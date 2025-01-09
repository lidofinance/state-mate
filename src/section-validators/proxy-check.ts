import chalk from "chalk";
import { BaseContract, JsonRpcProvider } from "ethers";
import { loadContract } from "../abi-provider";
import { CheckLevel, Ef, needCheck } from "../common";
import { logErrorAndExit, logHeader2 } from "../logger";
import { ChecksEntryValue, ContractEntry, isTypeOfTB, ProxyContractEntryTB, ViewResultTB } from "../typebox";
import { SectionValidatorBase } from "./base";

export class ProxyCheckSectionValidator extends SectionValidatorBase {
  constructor(provider: JsonRpcProvider) {
    super(provider);
  }
  override async validateSection(contractEntry: ContractEntry) {
    if (isTypeOfTB(contractEntry, ProxyContractEntryTB) && contractEntry.proxyChecks) {
      logHeader2(Ef.proxyChecks);
      const { address, proxyName, proxyChecks } = contractEntry;

      console.log(`Checking contract ${chalk.yellow(proxyName)} at address ${chalk.yellow(address)}...`);
      const contract = loadContract(proxyName, address, this.provider);

      for (const [method, checkEntryValue] of Object.entries(proxyChecks)) {
        if (!needCheck(CheckLevel.method, method)) continue;
        await this._validateSubsection(contract, method, checkEntryValue);
      }
    }
  }

  private async _validateSubsection(contract: BaseContract, method: string, checkEntryValue: ChecksEntryValue) {
    if (isTypeOfTB(checkEntryValue, ViewResultTB)) {
      await this._checkViewFunction(contract, method, { result: checkEntryValue });
    } else {
      logErrorAndExit(`Unknown check type: ${JSON.stringify(checkEntryValue)}`);
    }
  }
}
