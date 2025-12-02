import { Contract, JsonRpcProvider } from "ethers";

import { loadAbiFromFile } from "src/abi-provider";
import { EntryField } from "src/common";
import { loadContract } from "src/explorer-provider";
import { log, logErrorAndExit } from "src/logger";
import {
  ArrayOfStaticCallCheckTB,
  ChecksEntryValue,
  ContractEntry,
  isTypeOfTB,
  ProxyContractEntryTB,
  StaticCallCheckTB,
  ViewResultTB,
} from "src/typebox";
import { Abi } from "src/types";

import { CheckLevel, needCheck, SectionValidatorBase } from "./base";

export class ChecksSectionValidator extends SectionValidatorBase {
  constructor(provider: JsonRpcProvider, sectionName: EntryField = EntryField.checks) {
    super(provider, sectionName);
  }

  override async validateSection(contractEntry: ContractEntry, contractAlias: string) {
    const { address, checks } = contractEntry;
    const abi = this._loadAbiWithImplementationFallback(contractEntry);
    this._reportNonCoveredNonMutableChecks(contractAlias, abi, Object.keys(checks));

    const contract = loadContract(address, abi, this.provider);
    for (const [method, checkEntryValue] of Object.entries(checks)) {
      if (!needCheck(CheckLevel.method, method)) continue;

      await this._validateSubsection(contract, method, checkEntryValue);
    }
  }

  /**
   * For proxy contracts, prefer loading ABI from the implementation address
   * since the proxy delegates calls to the implementation.
   * Falls back to the proxy address ABI if implementation ABI is not available.
   */
  protected _loadAbiWithImplementationFallback(contractEntry: ContractEntry): Abi {
    const { name, address } = contractEntry;

    // Check if this is a proxy contract with an implementation
    if (isTypeOfTB(contractEntry, ProxyContractEntryTB) && contractEntry.implementation) {
      try {
        // Try to load implementation ABI first
        return loadAbiFromFile(name, contractEntry.implementation);
      } catch {
        // Fall back to proxy address ABI
        log(`  (Using proxy ABI as implementation ABI for ${name} at ${contractEntry.implementation} was not found)`);
      }
    }

    return loadAbiFromFile(name, address);
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
