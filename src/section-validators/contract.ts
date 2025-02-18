import { JsonRpcProvider } from "ethers";

import { EntryField } from "src/common";
import { logHeader1, logHeader2 } from "src/logger";
import { ContractEntry } from "src/typebox";

import { CheckLevel, needCheck, SectionValidatorBase } from "./base";
import { ValidatorFactory } from "./factory";

export class ContractSectionValidator {
  private map: Map<EntryField, SectionValidatorBase> = new Map();

  constructor(provider: JsonRpcProvider) {
    const sections = [
      EntryField.checks,
      EntryField.proxyChecks,
      EntryField.ozNonEnumerableAcl,
      EntryField.implementationChecks,
      EntryField.ozAcl,
    ];
    for (const section of sections) {
      this.map.set(section, ValidatorFactory.getValidator(section, provider));
    }
  }

  public async see(contractEntry: ContractEntry, sectionTitle: string, contractAlias: string) {
    if (!needCheck(CheckLevel.contract, contractAlias)) return;

    logHeader1(`Contract (${sectionTitle}): ${contractAlias} (${contractEntry.name}, ${contractEntry.address})`);

    if (needCheck(CheckLevel.checksType, EntryField.checks)) {
      logHeader2(EntryField.checks);
      await this.map.get(EntryField.checks)!.validateSection(contractEntry, contractAlias);
    }

    if (needCheck(CheckLevel.checksType, EntryField.proxyChecks)) {
      await this.map.get(EntryField.proxyChecks)!.validateSection(contractEntry, contractAlias);
    }

    if (needCheck(CheckLevel.checksType, EntryField.ozNonEnumerableAcl)) {
      await this.map.get(EntryField.ozNonEnumerableAcl)!.validateSection(contractEntry, contractAlias);
    }

    if (needCheck(CheckLevel.checksType, EntryField.implementationChecks)) {
      await this.map.get(EntryField.implementationChecks)!.validateSection(contractEntry, contractAlias);
    }

    if (needCheck(CheckLevel.checksType, EntryField.ozAcl)) {
      await this.map.get(EntryField.ozAcl)!.validateSection(contractEntry, contractAlias);
    }
  }
}
