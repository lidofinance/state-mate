import { BaseContract, JsonRpcProvider } from "ethers";
import { loadAbiFromFile } from "../abi-provider";
import { CheckLevel, Ef, needCheck } from "../common";
import { loadContract } from "../explorer-provider";
import { logErrorAndExit } from "../logger";
import {
  ArrayOfStaticCallCheckTB,
  ArrayPlainValueTB,
  ArrayViewResultPlainValueTB,
  ChecksEntryValue,
  ContractEntry,
  isTypeOfTB,
  StaticCallCheckTB,
  ViewResultPlainValueTB,
  ViewResultTB,
} from "../typebox";
import { SectionValidatorBase } from "./base";

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

  private async _validateSubsection(contract: BaseContract, method: string, checkEntryValue: ChecksEntryValue) {
    if (isTypeOfTB(checkEntryValue, ArrayOfStaticCallCheckTB) /* && checkEntryValue !== null */) {
      //todo check without  checkEntryValue !== null
      if (!checkEntryValue.length) {
        await this._checkViewFunction(contract, method, { result: "" });
      } else {
        for (const argsResult of checkEntryValue) {
          await this._checkViewFunction(contract, method, argsResult);
        }
      }
    } else if (isTypeOfTB(checkEntryValue, StaticCallCheckTB)) {
      await this._checkViewFunction(contract, method, checkEntryValue);
    } else if (isTypeOfTB(checkEntryValue, ViewResultTB)) {
      await this._checkViewFunction(contract, method, { result: checkEntryValue });
    } else if (isTypeOfTB(checkEntryValue, ArrayPlainValueTB)) {
      for (const plainValueOrArray of checkEntryValue) {
        if (isTypeOfTB(plainValueOrArray, ViewResultPlainValueTB)) {
          await this._checkViewFunction(contract, method, { result: plainValueOrArray });
        } else if (isTypeOfTB(plainValueOrArray, ArrayViewResultPlainValueTB)) {
          for (const plainValue of plainValueOrArray) {
            await this._checkViewFunction(contract, method, { result: plainValue });
          }
        }
      }
    } else {
      logErrorAndExit(`Unknown check type: ${JSON.stringify(checkEntryValue)}`);
    }
  }
}
