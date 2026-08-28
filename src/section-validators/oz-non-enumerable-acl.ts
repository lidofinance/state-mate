import type { Contract, JsonRpcProvider } from "ethers";

import { foldRoleEvents, type RoleHolders, sortedHolders, sortedRoles } from "src/acl/fold";
import {
  collectRoleEvents,
  hasLogSource,
  makeSettledScanRange,
  resolveDeploymentBlock,
  resolveScanHead,
  type ScanRange,
} from "src/acl/log-source";
import { type CalibrationInput, calibrateStorageLayout, readMembership, type StorageLayout } from "src/acl/storage";
import { EntryField, normalizeChainId, printError } from "src/common";
import { loadContract } from "src/explorer";
import { LogCommand, log, logHeader2, WARNING_MARK } from "src/logger";
import type { ContractEntry } from "src/typebox";
import type { ChainId } from "src/types";

import { incChecks, incErrors, incSkipped, SectionValidatorBase, setErrorContext } from "./base";

const NON_EXHAUSTIVE_NOTE =
  `${WARNING_MARK}: Non-enumerable OZ Acl means it is impossible to check absence of an arbitrary role holder ` +
  `only by means of calling view function. Current version of state-mate does what it can at most: for all the ` +
  `role holders specified checks they do not hold roles they are not described to have among all the roles mentioned.`;

type CheckOutcome = { detail: string; ok: true } | { message: string; ok: false };

/** hasRole answers from the declared pass, so the exhaustive pass does not ask the chain twice. */
interface RoleAnswer {
  held: boolean | undefined;
  holder: string;
  role: string;
}
type KnownRoles = Map<string, RoleAnswer>;

function pairKey(role: string, holder: string): string {
  return `${role.toLowerCase()}|${holder.toLowerCase()}`;
}

export class OzNonEnumerableAclSectionValidator extends SectionValidatorBase {
  constructor(provider: JsonRpcProvider, chainId: ChainId) {
    super(provider, EntryField.ozNonEnumerableAcl, chainId);
  }

  override async validateSection(contractEntry: ContractEntry, contractAlias: string, basePath?: string) {
    void contractAlias;
    if (!contractEntry.ozNonEnumerableAcl) {
      return;
    }

    logHeader2(basePath ? `${basePath}/${this.sectionName}` : this.sectionName);

    // Enumeration is not optional: whether the scan runs is the one decision the rest of this
    // check cannot fail closed on. The only thing that stops it is a chain whose logs no source
    // serves, which is a structural limit -- counted as a skip, never as a pass
    const scannable = hasLogSource(normalizeChainId(this.chainId));

    const known = await this._validate(contractEntry, scannable);
    if (scannable) {
      await this._validateExhaustive(contractEntry, known);
    } else {
      incSkipped();
      new LogCommand("exhaustive ACL scan").warning(
        `no log source is known for chainId ${normalizeChainId(this.chainId)}; holders cannot be enumerated`,
      );
    }
  }

  /**
   * One check: counted once, logged once, and any failure attributed to this contract. Everything
   * the section reports goes through here, so the tally cannot drift from what actually ran.
   */
  private async _check(label: string, run: () => Promise<CheckOutcome>): Promise<void> {
    incChecks();
    const logHandle = new LogCommand(label);
    setErrorContext({ method: label });

    let outcome: CheckOutcome;
    try {
      outcome = await run();
    } catch (error) {
      // A check that could not be made is a failure, never a pass by default
      outcome = { message: `REVERTED with: ${printError(error)}`, ok: false };
    }

    if (outcome.ok) {
      logHandle.success(outcome.detail);
      return;
    }
    logHandle.failure(outcome.message);
    incErrors(outcome.message);
  }

  /** The bound contract every check in this section calls through. */
  protected _contractFor(contractEntry: ContractEntry): Contract {
    return loadContract(contractEntry.address, this._loadContractAbi(contractEntry), this.provider);
  }

  protected async _validate(contractEntry: ContractEntry, exhaustiveFollows = false): Promise<KnownRoles> {
    const contract = this._contractFor(contractEntry);
    const known: KnownRoles = new Map();

    // The caveat is only true when the scan does not run; saying it anyway would undersell a check
    // that did enumerate every holder
    if (!exhaustiveFollows) log(NON_EXHAUSTIVE_NOTE);

    const rolesByHolders = new Map<string, Set<string>>();
    for (const role in contractEntry.ozNonEnumerableAcl) {
      for (const holder of contractEntry.ozNonEnumerableAcl[role]) {
        if (!rolesByHolders.has(holder)) rolesByHolders.set(holder, new Set<string>());
        rolesByHolders.get(holder)?.add(role);
        known.set(pairKey(role, holder), { held: await this._assertRole(contract, role, holder, true), holder, role });
      }
    }

    for (const [holder, rolesExpectedOnTheHolder] of rolesByHolders) {
      for (const role in contractEntry.ozNonEnumerableAcl) {
        if (rolesExpectedOnTheHolder.has(role)) continue;
        known.set(pairKey(role, holder), { held: await this._assertRole(contract, role, holder, false), holder, role });
      }
    }

    return known;
  }

  /** Runs the declared check and reports what the chain actually said, error or not. */
  private async _assertRole(
    contract: Contract,
    role: string,
    holder: string,
    expected: boolean,
  ): Promise<boolean | undefined> {
    let held: boolean | undefined;
    await this._check(`.hasRole(${role}, ${holder})`, async () => {
      held = Boolean(await contract.getFunction("hasRole").staticCall(role, holder));
      return held === expected
        ? { detail: String(held), ok: true }
        : { message: `expected hasRole to be ${expected}, got ${held}`, ok: false };
    });
    return held;
  }

  /**
   * Enumerates every holder the chain ever granted, by replaying RoleGranted/RoleRevoked from
   * deployment, and reports the ones the config does not declare.
   *
   * Every step that cannot be completed is an error rather than a downgrade to the declared-only
   * check. A config that asks for an exhaustive scan and quietly gets a weaker one is worse than a
   * config that never asked: the run goes green having verified less than the reader believes.
   */
  private async _validateExhaustive(contractEntry: ContractEntry, known: KnownRoles) {
    const { address } = contractEntry;
    const chainId = normalizeChainId(this.chainId);
    const fail = (reason: string) =>
      this._check("exhaustive ACL scan", async () => ({
        message: `exhaustive ACL scan could not run: ${reason}`,
        ok: false,
      }));

    const confirmed: CalibrationInput[] = [];
    for (const role in contractEntry.ozNonEnumerableAcl) {
      for (const holder of contractEntry.ozNonEnumerableAcl[role]) {
        if (known.get(pairKey(role, holder))?.held) confirmed.push({ account: holder, role });
      }
    }

    const calibration = await calibrateStorageLayout(this.provider, address, confirmed);
    if (!calibration.ok) return fail(calibration.reason);
    log(`  storage layout: ${calibration.layout.name}`);

    let range: ScanRange;
    try {
      range = await this._scanRange(chainId, address);
    } catch (error) {
      return fail(printError(error));
    }

    const outcome = await collectRoleEvents(chainId, address, range);
    if (!outcome.ok) return fail(outcome.reason);
    log(`  ${outcome.source}: ${outcome.events.length} role events in blocks ${range.fromBlock}-${range.toBlock}`);
    // Anything after the settled head is outside this run; saying so beats implying it was covered
    log(`  role changes after block ${range.toBlock} are not covered by this scan`);

    const holders = foldRoleEvents(outcome.events.filter((event) => event.address === address.toLowerCase()));
    await this._compareWithConfig(contractEntry, holders, calibration.layout, known);
  }

  private async _scanRange(chainId: string, address: string): Promise<ScanRange> {
    const deployed = await resolveDeploymentBlock(chainId, address);
    if (deployed === undefined) throw new Error(`the explorer would not give a deployment block for ${address}`);
    return makeSettledScanRange(deployed, await resolveScanHead(chainId, this.provider));
  }

  protected async _compareWithConfig(
    contractEntry: ContractEntry,
    holders: RoleHolders,
    layout: StorageLayout,
    known: KnownRoles,
  ) {
    const contract = this._contractFor(contractEntry);
    const declared = new Map<string, Set<string>>();

    for (const role in contractEntry.ozNonEnumerableAcl) {
      const key = role.toLowerCase();
      // Two config keys differing only in case would silently collapse into one
      if (declared.has(key)) {
        await this._check(`role ${role}`, async () => ({
          message: `role ${role} is declared twice under different casing`,
          ok: false,
        }));
        continue;
      }
      declared.set(key, new Set(contractEntry.ozNonEnumerableAcl[role].map((holder) => holder.toLowerCase())));
    }

    // Every pair the section formed an opinion about is read from storage as well as asked of the
    // view. Calibration establishes the layout from whichever holder reads back; it does not vouch
    // for the rest, and a hasRole that answers true for an address the slot does not hold would
    // otherwise pass the declared check unseen
    for (const { held, holder, role } of [...known.values()].toSorted((a, b) =>
      `${a.role}|${a.holder}`.localeCompare(`${b.role}|${b.holder}`),
    )) {
      await this._reconcileSlot(contractEntry.address, layout, role.toLowerCase(), holder.toLowerCase(), held);
    }

    for (const role of sortedRoles(holders)) {
      const expected = declared.get(role) ?? new Set<string>();
      for (const holder of sortedHolders(holders, role)) {
        if (expected.has(holder)) continue;

        // Left undefined when the call itself failed: a confirmation that did not happen is not a
        // holder that is not there, and must not be reconciled against a made-up answer
        let held: boolean | undefined;
        await this._check(`undeclared .hasRole(${role}, ${holder})`, async () => {
          held = Boolean(await contract.getFunction("hasRole").staticCall(role, holder));
          return held
            ? { message: `undeclared role holder: ${holder} holds ${role}`, ok: false }
            : { detail: "false (granted, then revoked)", ok: true };
        });
        await this._reconcileSlot(contractEntry.address, layout, role, holder, held);
      }
    }
  }

  /**
   * Compares the raw membership slot with what hasRole reported. They can only differ if the view
   * is overridden or the layout is not what it calibrated as, and either one means the scan was
   * reading a contract it does not actually understand.
   *
   * The slot is the only independent witness here: hasRole is dispatched through the proxy to
   * whatever is deployed, using an ABI an explorer served, while the slot is derived from the
   * layout and touches neither.
   */
  protected async _reconcileSlot(
    address: string,
    layout: StorageLayout,
    role: string,
    holder: string,
    viewSaid: boolean | undefined,
  ) {
    if (viewSaid === undefined) return;
    await this._check(`storage ${role} / ${holder}`, async () => {
      const reading = await readMembership(this.provider, address, layout, role, holder);
      if (!reading.ok) return { message: `membership slot holds ${reading.word}, which is not a bool`, ok: false };
      return reading.held === viewSaid
        ? { detail: String(reading.held), ok: true }
        : { message: `hasRole says ${viewSaid} but the membership slot says ${reading.held}`, ok: false };
    });
  }
}
