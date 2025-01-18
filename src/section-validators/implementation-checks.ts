import { JsonRpcProvider } from "ethers";

import { loadAbiFromFile } from "src/abi-provider";
import { Ef, getNonMutables } from "src/common";
import { logHeader2 } from "src/logger";
import { ContractEntry, isTypeOfTB, ProxyContractEntryTB, RegularChecks } from "src/typebox";

import { ChecksSectionValidator } from "./checks";

export class ImplementationChecksSectionValidator extends ChecksSectionValidator {
  constructor(provider: JsonRpcProvider) {
    super(provider, Ef.implementationChecks);
  }

  override async validateSection(contractEntry: ContractEntry, contractAlias: string) {
    if (
      isTypeOfTB(contractEntry, ProxyContractEntryTB) &&
      contractEntry.implementation &&
      contractEntry.implementationChecks
    ) {
      logHeader2(this.sectionName);
      const { implementation, name, implementationChecks } = contractEntry;

      const allNonMutable = getNonMutables(loadAbiFromFile(name, implementation));
      const skippedChecks: RegularChecks = {};

      for (const x of allNonMutable) {
        // eslint-disable-next-line unicorn/no-null
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
}
