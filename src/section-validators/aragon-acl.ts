import { Contract, Interface, type JsonRpcProvider } from "ethers";
import {
  ANY_ENTITY,
  ARAGON_ACL_TOPICS,
  type AragonEvent,
  type AragonState,
  appRoleKey,
  decodePermissionWord,
  foldAragonEvents,
  managerSlot,
  paramsDigest,
  parseAragonLog,
  permissionSlot,
} from "src/acl/aragon";
import {
  collectTopicLogs,
  hasLogSource,
  makeSettledScanRange,
  resolveDeploymentBlock,
  resolveScanHead,
} from "src/acl/log-source";
import { EntryField, normalizeChainId, printError } from "src/common";
import { LogCommand, log, logHeader2 } from "src/logger";
import type { AragonAclSection, ContractEntry } from "src/typebox";
import type { ChainId } from "src/types";

import { incSkipped, SectionValidatorBase } from "./base";

// The section's own view surface; the checks section covers the full ABI separately
const ACL_VIEW_ABI = new Interface([
  "function hasPermission(address entity, address app, bytes32 role) view returns (bool)",
  "function getPermissionManager(address app, bytes32 role) view returns (address)",
  "function getPermissionParamsLength(address entity, address app, bytes32 role) view returns (uint256)",
]);

interface DeclaredRole {
  app: string;
  role: string;
  manager: string;
  granted: string[];
  paramsDigest?: string;
}

/**
 * Verifies the whole DAO permission map against the ACL that owns it: every declared grant and
 * manager, and -- because the map is declared in one place -- every live grant nobody declared.
 *
 * Three answers must agree for everything reported: the event history, the view functions, and
 * the raw ACL storage. The one wrinkle Aragon adds over OpenZeppelin is parameterized grants:
 * `hasPermission(entity, app, role)` answers FALSE for a live conditional grant (measured on
 * mainnet), so those are verified through the params hash -- event vs slot vs the digest the
 * config pins -- rather than through the view.
 */
export class AragonAclSectionValidator extends SectionValidatorBase {
  constructor(provider: JsonRpcProvider, chainId: ChainId) {
    super(provider, EntryField.aragonAcl, chainId);
  }

  override async validateSection(contractEntry: ContractEntry, contractAlias: string, basePath?: string) {
    void contractAlias;
    if (!contractEntry.aragonAcl) {
      return;
    }
    logHeader2(basePath ? `${basePath}/${this.sectionName}` : this.sectionName);

    const chainId = normalizeChainId(this.chainId);
    if (!hasLogSource(chainId)) {
      incSkipped();
      new LogCommand("aragon ACL scan").warning(
        `no log source is known for chainId ${chainId}; permissions cannot be enumerated`,
      );
      return;
    }

    const outcome = await this._scan(chainId, contractEntry.address);
    if (!outcome.ok) {
      await this._check("aragon ACL scan", async () => ({
        message: `aragon ACL scan could not run: ${outcome.reason}`,
        ok: false,
      }));
      return;
    }
    log(`  ${outcome.source}: ${outcome.events.length} ACL events in blocks ${outcome.fromBlock}-${outcome.toBlock}`);
    log(`  permission changes after block ${outcome.toBlock} are not covered by this scan`);

    await this._compareWithState(contractEntry, foldAragonEvents(outcome.events));
  }

  /** Overridable seam: tests feed canned events, production reads the explorer. */
  protected async _scan(
    chainId: string,
    address: string,
  ): Promise<
    | { events: AragonEvent[]; fromBlock: number; ok: true; source: string; toBlock: number }
    | { ok: false; reason: string }
  > {
    const fromBlock = await resolveDeploymentBlock(chainId, address);
    if (fromBlock === undefined) {
      return { ok: false, reason: `the explorer would not give a deployment block for ${address}` };
    }
    let range: { fromBlock: number; toBlock: number };
    try {
      // an ACL deployed above the settled head has no settled history yet, same rule as the OZ scan
      range = makeSettledScanRange(fromBlock, await resolveScanHead(chainId, this.provider));
    } catch (error) {
      return { ok: false, reason: printError(error) };
    }
    const { fromBlock: from, toBlock } = range;

    const raw = await collectTopicLogs(chainId, address, ARAGON_ACL_TOPICS, range);
    if (!raw.ok) return raw;

    const events: AragonEvent[] = [];
    for (const entry of raw.logs) {
      const parsed = parseAragonLog(entry);
      if (!parsed.ok) return { ok: false, reason: `${raw.source} served an unreadable log: ${parsed.reason}` };
      events.push(parsed.event);
    }
    return { events, fromBlock: from, ok: true, source: raw.source, toBlock };
  }

  /** The bound ACL every view confirmation calls through. */
  protected _aclContract(address: string): Contract {
    return new Contract(address, ACL_VIEW_ABI, this.provider);
  }

  protected async _compareWithState(contractEntry: ContractEntry, state: AragonState) {
    const aclAddress = contractEntry.address;
    const acl = this._aclContract(aclAddress);
    const declared = this._normalizeDeclared(contractEntry.aragonAcl as AragonAclSection);
    if (!declared) return;

    // Calibration: before any conclusion is drawn from events or slots, one declared grantee the
    // view vouches for must read back from the slot the layout points at. aragonOS has a single
    // fixed layout, but a contract at this address that is not that layout must fail here, not
    // pass quietly below
    if (!(await this._calibrate(acl, aclAddress, declared))) return;

    const declaredRoleKeys = new Set(declared.map((entry) => appRoleKey(entry.app, entry.role)));
    const declaredApps = new Set(declared.map((entry) => entry.app));

    for (const entry of declared) {
      await this._verifyManager(acl, aclAddress, entry, state);
      for (const entity of entry.granted) {
        await this._verifyUnconditional(acl, aclAddress, entry, entity, state);
      }
      await this._verifyParams(acl, aclAddress, entry, state);
    }

    // DAO-wide completeness for grants: a live grant on an app or role nobody declared is exactly
    // the holder this section exists to find
    for (const [roleKey, entities] of [...state.granted.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (entities.size === 0 || declaredRoleKeys.has(roleKey)) continue;
      const [app, role] = roleKey.split("|");
      for (const entity of [...entities].toSorted((a, b) => a.localeCompare(b))) {
        await this._check(`undeclared permission ${role} on ${app}`, async () => {
          const word = decodePermissionWord(
            await this.provider.getStorage(aclAddress, permissionSlot(entity, app, role)),
          );
          if (word.kind === "absent") return { detail: "not present in storage (stale event)", ok: true };
          return { message: `undeclared ${word.kind} permission: ${entity} on app ${app} role ${role}`, ok: false };
        });
      }
    }

    // Managers are scoped to the declared apps (the rest are a documented deferral), but within
    // a declared app every live manager must be declared: the manager IS the power to grant
    for (const [roleKey, manager] of [...state.managers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [app, role] = roleKey.split("|");
      if (!declaredApps.has(app) || declaredRoleKeys.has(roleKey)) continue;
      await this._check(`undeclared manager for ${role} on ${app}`, async () => ({
        message: `role ${role} on declared app ${app} has manager ${manager} but is not declared`,
        ok: false,
      }));
    }
  }

  private _normalizeDeclared(section: AragonAclSection): DeclaredRole[] | undefined {
    const declared: DeclaredRole[] = [];
    const seen = new Set<string>();
    for (const [app, roles] of Object.entries(section)) {
      for (const [role, entry] of Object.entries(roles)) {
        const key = appRoleKey(app, role);
        if (seen.has(key)) {
          // two YAML keys differing only in case would silently collapse into one opinion
          void this._check(`role ${role}`, async () => ({
            message: `role ${role} on ${app} is declared twice under different casing`,
            ok: false,
          }));
          return undefined;
        }
        seen.add(key);
        declared.push({
          app: app.toLowerCase(),
          granted: (entry.granted ?? []).map((entity) => entity.toLowerCase()),
          manager: entry.manager.toLowerCase(),
          paramsDigest: entry.paramsDigest?.toLowerCase(),
          role: role.toLowerCase(),
        });
      }
    }
    return declared;
  }

  private async _calibrate(acl: Contract, aclAddress: string, declared: DeclaredRole[]): Promise<boolean> {
    for (const entry of declared) {
      for (const entity of entry.granted) {
        let vouched = false;
        try {
          vouched = Boolean(await acl.getFunction("hasPermission").staticCall(entity, entry.app, entry.role));
        } catch {
          continue;
        }
        if (!vouched) continue;
        const word = decodePermissionWord(
          await this.provider.getStorage(aclAddress, permissionSlot(entity, entry.app, entry.role)),
        );
        if (word.kind !== "absent") return true;
        await this._check("storage layout calibration", async () => ({
          message:
            `hasPermission vouches for ${entity} on ${entry.app} role ${entry.role} but the aragonOS ` +
            `permission slot is empty; this contract does not store permissions where the ACL stores them`,
          ok: false,
        }));
        return false;
      }
    }
    await this._check("storage layout calibration", async () => ({
      message: "no declared grantee was confirmed on chain, so the storage layout cannot be calibrated",
      ok: false,
    }));
    return false;
  }

  private async _verifyManager(acl: Contract, aclAddress: string, entry: DeclaredRole, state: AragonState) {
    const roleKey = appRoleKey(entry.app, entry.role);
    await this._check(`manager of ${entry.role} on ${entry.app}`, async () => {
      const fromEvents = state.managers.get(roleKey);
      const fromView = String(
        await acl.getFunction("getPermissionManager").staticCall(entry.app, entry.role),
      ).toLowerCase();
      const fromSlot = `0x${(await this.provider.getStorage(aclAddress, managerSlot(entry.app, entry.role))).slice(-40)}`;
      const answers = { events: fromEvents ?? "(none)", slot: fromSlot, view: fromView };
      if (fromView !== entry.manager || fromSlot !== entry.manager || fromEvents !== entry.manager) {
        return { message: `expected manager ${entry.manager}, got ${JSON.stringify(answers)}`, ok: false };
      }
      return { detail: entry.manager, ok: true };
    });
  }

  private async _verifyUnconditional(
    acl: Contract,
    aclAddress: string,
    entry: DeclaredRole,
    entity: string,
    state: AragonState,
  ) {
    await this._check(`.hasPermission(${entity}, ${entry.app}, ${entry.role})`, async () => {
      const live = state.granted.get(appRoleKey(entry.app, entry.role))?.has(entity) ?? false;
      const view = Boolean(await acl.getFunction("hasPermission").staticCall(entity, entry.app, entry.role));
      const word = decodePermissionWord(
        await this.provider.getStorage(aclAddress, permissionSlot(entity, entry.app, entry.role)),
      );
      if (!live || !view || word.kind !== "unconditional") {
        const got = `events=${live}, view=${view}, slot=${word.kind}`;
        return { message: `expected an unconditional live grant, got ${got}`, ok: false };
      }
      return { detail: "true", ok: true };
    });
  }

  private async _verifyParams(acl: Contract, aclAddress: string, entry: DeclaredRole, state: AragonState) {
    const roleKey = appRoleKey(entry.app, entry.role);
    const live = [...(state.granted.get(roleKey) ?? [])]
      .filter((entity) => state.paramsHash.has(`${roleKey}|${entity}`))
      .toSorted((a, b) => a.localeCompare(b));

    if (entry.paramsDigest === undefined) {
      if (live.length === 0) return;
      await this._check(`parameterized grants of ${entry.role} on ${entry.app}`, async () => ({
        message: `${live.length} live parameterized grant(s) exist but no paramsDigest is pinned`,
        ok: false,
      }));
      return;
    }

    await this._check(`paramsDigest of ${entry.role} on ${entry.app}`, async () => {
      const fromEvents = live.map((entity) => ({
        entity,
        paramsHash: state.paramsHash.get(`${roleKey}|${entity}`) ?? "",
      }));
      const fromSlots = [];
      for (const entity of live) {
        const word = decodePermissionWord(
          await this.provider.getStorage(aclAddress, permissionSlot(entity, entry.app, entry.role)),
        );
        if (word.kind !== "params") {
          return { message: `slot for ${entity} reads ${word.kind}, but events say it carries params`, ok: false };
        }
        fromSlots.push({ entity, paramsHash: word.paramsHash });
      }
      const digests = { events: paramsDigest(fromEvents), slots: paramsDigest(fromSlots) };
      if (digests.events !== entry.paramsDigest || digests.slots !== entry.paramsDigest) {
        // the full live set is the fix: re-pinning is one reviewed copy-paste
        log(`  live parameterized grants of ${entry.role} on ${entry.app}:`);
        for (const pair of fromEvents) log(`    ${pair.entity} ${pair.paramsHash}`);
        return {
          message: `pinned ${entry.paramsDigest}, events fold to ${digests.events}, slots to ${digests.slots}`,
          ok: false,
        };
      }
      // the view cannot vouch for conditional grants; params length is the view-side proof they exist
      const paramsLength = Number(
        await acl.getFunction("getPermissionParamsLength").staticCall(live[0], entry.app, entry.role),
      );
      if (paramsLength === 0) {
        return {
          message: `getPermissionParamsLength is 0 for ${live[0]}, yet the slot carries a params hash`,
          ok: false,
        };
      }
      return { detail: `${live.length} grant(s), digest ${entry.paramsDigest.slice(0, 18)}…`, ok: true };
    });

    // A live wildcard would hide inside the digest; it is never legitimate here
    if (live.includes(ANY_ENTITY) || (state.granted.get(roleKey)?.has(ANY_ENTITY) ?? false)) {
      await this._check(`ANY_ENTITY on ${entry.role}`, async () => ({
        message: `ANY_ENTITY holds ${entry.role} on ${entry.app}: the permission is granted to everyone`,
        ok: false,
      }));
    }
  }
}
