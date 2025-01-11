import { BaseContract, JsonRpcProvider } from "ethers";
import { loadAbiFromFile } from "../abi-provider";
import { CheckLevel, Ef, needCheck } from "../common";
import { logErrorAndExit, logHeader2 } from "../logger";
import { ChecksEntryValue, ContractEntry, isTypeOfTB, ProxyContractEntryTB, ViewResultTB } from "../typebox";
import { SectionValidatorBase } from "./base";
import { loadContract } from "../explorer-provider";

export class ProxyCheckSectionValidator extends SectionValidatorBase {
  constructor(provider: JsonRpcProvider) {
    super(provider, Ef.proxyChecks);
  }
  override async validateSection(contractEntry: ContractEntry, contractAlias: string) {
    if (isTypeOfTB(contractEntry, ProxyContractEntryTB) && contractEntry.proxyChecks) {
      logHeader2(this.sectionName);

      const { address, proxyName, proxyChecks } = contractEntry;

      const abi = loadAbiFromFile(proxyName, address);
      this._reportNonCoveredNonMutableChecks(contractAlias, abi, Object.keys(proxyChecks));

      const contract = loadContract(address, abi, this.provider);
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
