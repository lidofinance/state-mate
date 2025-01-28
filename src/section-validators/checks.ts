import { Contract, JsonRpcProvider } from "ethers";

import { loadAbiFromFile } from "src/abi-provider";
import { Ef } from "src/common";
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

import { CheckLevel, needCheck, SectionValidatorBase } from "./base";

export class ChecksSectionValidator extends SectionValidatorBase {
  constructor(provider: JsonRpcProvider, sectionName: Ef = Ef.checks) {
    super(provider, sectionName);
  }

  override async validateSection({ name, address, checks }: ContractEntry, contractAlias: string) {
    const abi = loadAbiFromFile(name, address);
    this._reportNonCoveredNonMutableChecks(contractAlias, abi, Object.keys(checks));

    const contract = loadContract(address, abi, this.provider);
    for (const [method, checkEntryValue] of Object.entries(checks)) {
      if (!needCheck(CheckLevel.method, method)) continue;

      await this._validateSubsection(contract, method, checkEntryValue);
    }
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
}
