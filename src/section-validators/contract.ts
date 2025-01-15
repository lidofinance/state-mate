import { JsonRpcProvider } from "ethers";
import { CheckLevel, Ef, needCheck } from "src/common";
import { logHeader1, logHeader2 } from "src/logger";
import { ContractEntry } from "src/typebox";
import { SectionValidatorBase } from "./base";
import { ValidatorFactory } from "./factory";

export class ContractSectionValidator {
  private map: Map<Ef, SectionValidatorBase> = new Map();

  constructor(provider: JsonRpcProvider) {
    const sections = [Ef.checks, Ef.proxyChecks, Ef.ozNonEnumerableAcl, Ef.implementationChecks, Ef.ozAcl];
    sections.forEach((section) => {
      this.map.set(section, ValidatorFactory.getValidator(section, provider));
    });
  }

  public async see(contractEntry: ContractEntry, sectionTitle: string, contractAlias: string) {
    if (!needCheck(CheckLevel.contract, contractAlias)) return;

    logHeader1(`Contract (${sectionTitle}): ${contractAlias} (${contractEntry.name}, ${contractEntry.address})`);

    if (needCheck(CheckLevel.checksType, Ef.checks)) {
      logHeader2(Ef.checks);
      await this.map.get(Ef.checks)!.validateSection(contractEntry, contractAlias);
    }

    if (needCheck(CheckLevel.checksType, Ef.proxyChecks)) {
      await this.map.get(Ef.proxyChecks)!.validateSection(contractEntry, contractAlias);
    }

    if (needCheck(CheckLevel.checksType, Ef.ozNonEnumerableAcl)) {
      await this.map.get(Ef.ozNonEnumerableAcl)!.validateSection(contractEntry, contractAlias);
    }

    if (needCheck(CheckLevel.checksType, Ef.implementationChecks)) {
      await this.map.get(Ef.implementationChecks)!.validateSection(contractEntry, contractAlias);
    }

    if (needCheck(CheckLevel.checksType, Ef.ozAcl)) {
      await this.map.get(Ef.ozAcl)!.validateSection(contractEntry, contractAlias);
    }
  }
}
