import { JsonRpcProvider } from "ethers";
import { Ef, getNonMutables } from "../common";
import { logHeader2 } from "../logger";
import { ContractEntry, isTypeOfTB, ProxyContractEntryTB, RegularChecks } from "../typebox";
import { ChecksSectionValidator } from "./checks";
import { loadAbiFromFile } from "../abi-provider";

export class ImplementationChecksSectionValidator extends ChecksSectionValidator {
  constructor(provider: JsonRpcProvider) {
    super(provider, Ef.implementationChecks);
  }

  override async validateSection(contractEntry: ContractEntry, contractAlias: string) {
    if (isTypeOfTB(contractEntry, ProxyContractEntryTB) && contractEntry.implementation) {
      logHeader2(this.sectionName);
      const { implementation, name, implementationChecks } = contractEntry;

      const allNonMutable = getNonMutables(loadAbiFromFile(name, implementation));
      const skippedChecks: RegularChecks = {};
      allNonMutable.reduce((acc, x) => ((acc[x.name] = null), acc), skippedChecks);
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
