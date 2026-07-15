import { Contract, JsonRpcProvider } from "ethers";

import { EntryField } from "src/common";
import { loadContract } from "src/explorer-provider";
import { logErrorAndExit } from "src/logger";
import {
  ArrayOfStaticCallCheckTB,
  ChecksEntryValue,
  ContractEntry,
  isTypeOfTB,
  StaticCallCheckTB,
  ViewResultTB,
} from "src/typebox";
import { ChainId } from "src/types";

import { CheckLevel, needCheck, SectionValidatorBase } from "./base";

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
  }
}
