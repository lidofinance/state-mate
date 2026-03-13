import { Contract, JsonRpcProvider } from "ethers";

import { loadAbiFromFile } from "src/abi-provider";
import { EntryField } from "src/common";
import { loadContract } from "src/explorer-provider";
import { logErrorAndExit, logHeader2 } from "src/logger";
import { ChecksEntryValue, ContractEntry, isTypeOfTB, ProxyContractEntryTB, ViewResultTB } from "src/typebox";

import { CheckLevel, needCheck, SectionValidatorBase } from "./base";

export class ProxyCheckSectionValidator extends SectionValidatorBase {
  constructor(provider: JsonRpcProvider) {
    super(provider, EntryField.proxyChecks);
  }
  override async validateSection(contractEntry: ContractEntry, contractAlias: string, basePath?: string) {
    if (isTypeOfTB(contractEntry, ProxyContractEntryTB) && contractEntry.proxyChecks) {
      const { address, proxyName, proxyChecks } = contractEntry;

      // Skip if no checks defined
      if (Object.keys(proxyChecks).length === 0) return;

      logHeader2(basePath ? `${basePath}/${this.sectionName}` : this.sectionName);

      const abi = loadAbiFromFile(proxyName, address);
      this._reportNonCoveredNonMutableChecks(contractAlias, abi, Object.keys(proxyChecks));

      const contract = loadContract(address, abi, this.provider);
      for (const [method, checkEntryValue] of Object.entries(proxyChecks)) {
        if (!needCheck(CheckLevel.method, method)) continue;
        await this._validateSubsection(contract, method, checkEntryValue);
      }
    }
  }

  private async _validateSubsection(contract: Contract, method: string, checkEntryValue: ChecksEntryValue) {
    if (isTypeOfTB(checkEntryValue, ViewResultTB)) {
      await this._checkViewFunction(contract, method, { result: checkEntryValue });
    } else {
      logErrorAndExit(`Unknown check type: ${JSON.stringify(checkEntryValue)}`);
    }
  }
}
