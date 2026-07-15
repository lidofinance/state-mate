import { JsonRpcProvider } from "ethers";

import { loadAbiFromFile } from "src/abi-provider";
import { EntryField, getNonMutables } from "src/common";
import { logHeader2 } from "src/logger";
import { ContractEntry, isTypeOfTB, ProxyContractEntryTB, RegularChecks } from "src/typebox";
import { ChainId } from "src/types";

import { ChecksSectionValidator } from "./checks";

export class ImplementationChecksSectionValidator extends ChecksSectionValidator {
  constructor(provider: JsonRpcProvider, chainId: ChainId) {
    super(provider, chainId, EntryField.implementationChecks);
  }

  override async validateSection(contractEntry: ContractEntry, contractAlias: string, basePath?: string) {
    if (!(
      isTypeOfTB(contractEntry, ProxyContractEntryTB) &&
      contractEntry.implementation &&
      contractEntry.implementationChecks
    )) {
      return;
    }

    logHeader2(basePath ? `${basePath}/${this.sectionName}` : this.sectionName);
    const { implementation, name, implementationChecks } = contractEntry;

    const allNonMutable = getNonMutables(loadAbiFromFile(this.chainId, name, implementation));
    const skippedChecks: RegularChecks = {};

    for (const x of allNonMutable) {
      skippedChecks[x.name] = null;
    }
    await super.validateSection(
      {
        checks: { ...skippedChecks, ...implementationChecks },
        name: name,
        address: implementation,
      },
      contractAlias,
    );
  }
}
