import { BaseContract, JsonRpcProvider } from "ethers";
import { loadContract } from "../abi-provider";
import { CheckLevel, needCheck } from "../common";
import { logErrorAndExit } from "../logger";
import {
  ArrayOfStaticCallCheckTB,
  ChecksEntryValue,
  ContractEntry,
  isTypeOfTB,
  StaticCallCheckTB,
  ViewResultTB,
} from "../typebox";
import { SectionValidatorBase } from "./base";

export class ChecksSectionValidator extends SectionValidatorBase {
  constructor(provider: JsonRpcProvider) {
    super(provider);
  }

  override async validateSection({ address, name, checks }: ContractEntry) {
    const contract = loadContract(name, address, this.provider);

    for (const [method, checkEntryValue] of Object.entries(checks)) {
      if (!needCheck(CheckLevel.method, method)) continue;

      await this._validateSubsection(contract, method, checkEntryValue);
    }
  }

  private async _validateSubsection(contract: BaseContract, method: string, checkEntryValue: ChecksEntryValue) {
    if (isTypeOfTB(checkEntryValue, ArrayOfStaticCallCheckTB) /* && checkEntryValue !== null */) {
      //todo check without  checkEntryValue !== null
      for (const argsResult of checkEntryValue) {
        await this._checkViewFunction(contract, method, argsResult);
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
