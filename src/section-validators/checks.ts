import type { Contract, JsonRpcProvider } from "ethers";

import { EntryField, printError } from "src/common";
import { context } from "src/context";
import { loadContract } from "src/explorer";
import { LogCommand, logErrorAndExit } from "src/logger";
import { recordObservedCall } from "src/observed";
import {
  ArrayOfStaticCallCheckTB,
  type ChecksEntryValue,
  type ContractEntry,
  isTypeOfTB,
  StaticCallCheckTB,
  ViewResultTB,
} from "src/typebox";
import type { Abi, ChainId } from "src/types";

import { _stringify, CheckLevel, getErrorContext, needCheck, SectionValidatorBase } from "./base";

// <name>Length or <name>Count next to an indexed getter <name>(uint256) is an enumeration
const ENUMERATION = /^(.+?)(Length|Count)$/;
// Beyond this many entries the expansion would be a scan, not a check
const ENUMERATION_CAP = 1000;

function indexedGetter(abi: Abi, stem: string): boolean {
  return abi.some(
    ({ type, name, inputs, stateMutability }) =>
      type === "function" &&
      name === stem &&
      (stateMutability === "view" || stateMutability === "pure") &&
      inputs?.length === 1 &&
      /^uint\d*$/.test(inputs[0].type ?? ""),
  );
}

function argumentless(abi: Abi, name: string): boolean {
  return abi.some((entry) => entry.type === "function" && entry.name === name && (entry.inputs?.length ?? 0) === 0);
}

/** The indices the config pins as <stem>(i) entries. */
export function pinnedIndices(declared: ChecksEntryValue | undefined): Set<number> {
  const entries = isTypeOfTB(declared, ArrayOfStaticCallCheckTB)
    ? declared
    : isTypeOfTB(declared, StaticCallCheckTB)
      ? [declared]
      : [];
  const indices = new Set<number>();
  for (const entry of entries) {
    if (entry.args?.length !== 1) continue;
    const index = Number(entry.args[0]);
    if (Number.isInteger(index) && index >= 0) indices.add(index);
  }
  return indices;
}

export class ChecksSectionValidator extends SectionValidatorBase {
  constructor(provider: JsonRpcProvider, chainId: ChainId, sectionName: EntryField = EntryField.checks) {
    super(provider, sectionName, chainId);
  }

  private async _validateSubsection(contract: Contract, method: string, checkEntryValue: ChecksEntryValue) {
    if (isTypeOfTB(checkEntryValue, ArrayOfStaticCallCheckTB)) {
      if (checkEntryValue.length === 0) {
        await this._checkViewFunction(contract, method, { result: [] });
      } else {
        for (const argumentsResult of checkEntryValue) {
          await this._checkViewFunction(contract, method, argumentsResult);
        }
      }
    } else if (isTypeOfTB(checkEntryValue, StaticCallCheckTB)) {
      await this._checkViewFunction(contract, method, checkEntryValue);
    } else if (isTypeOfTB(checkEntryValue, ViewResultTB)) {
      await this._checkViewFunction(contract, method, { result: checkEntryValue });
    } else {
      logErrorAndExit(`Unknown check type: ${JSON.stringify(checkEntryValue)}`);
    }
  }

  override async validateSection(contractEntry: ContractEntry, contractAlias: string, basePath?: string) {
    void basePath; // Used for interface compatibility - header printed by contract.ts
    const { address, checks } = contractEntry;
    const abi = this._loadContractAbi(contractEntry);
    this._reportNonCoveredNonMutableChecks(contractAlias, abi, Object.keys(checks));

    const contract = loadContract(address, abi, this.provider);
    for (const [method, checkEntryValue] of Object.entries(checks)) {
      if (!needCheck(CheckLevel.method, method)) continue;

      await this._validateSubsection(contract, method, checkEntryValue);
    }
    if (context.expandEnumerations) await this._expandEnumerations(contract, abi, checks);
  }

  /**
   * For every declared <stem>Length the chain says how many <stem>(i) exist; the entries the
   * config does not pin are read, recorded as observed and reported as warnings, so that a
   * list can no longer be verified by its length alone. A length declared `null` is read here
   * even though the checks skip it: `null` declines to assert a value, not to look.
   */
  protected async _expandEnumerations(contract: Contract, abi: Abi, checks: Record<string, ChecksEntryValue>) {
    for (const [key, declared] of Object.entries(checks)) {
      const stem = ENUMERATION.exec(key)?.[1];
      if (!stem || !indexedGetter(abi, stem) || !argumentless(abi, key)) continue;
      if (!needCheck(CheckLevel.method, key) && !needCheck(CheckLevel.method, stem)) continue;

      let count: number;
      try {
        const answer: unknown = await contract.getFunction(key).staticCall();
        count = Number(answer);
        // The checks skipped a null length, so this read is the only record of the count
        if (declared === null) recordObservedCall(getErrorContext(), key, undefined, { value: answer });
      } catch {
        continue;
      }
      if (count > ENUMERATION_CAP) {
        new LogCommand(`.${stem}[0..${count})`).warning(
          `${count} entries exceed the expansion cap of ${ENUMERATION_CAP}`,
        );
        continue;
      }
      const pinned = pinnedIndices(checks[stem]);
      for (let index = 0; index < count; index++) {
        if (pinned.has(index)) continue;
        const logHandle = new LogCommand(`.${stem}(${index})`);
        try {
          const value: unknown = await contract.getFunction(stem).staticCall(index);
          recordObservedCall(getErrorContext(), stem, [index], { value });
          logHandle.warning(`not in the config; the chain says ${_stringify(value)}`);
        } catch (error) {
          logHandle.warning(`not in the config; the read REVERTED with: ${printError(error)}`);
        }
      }
    }
  }
}
