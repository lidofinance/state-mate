import { JsonRpcProvider } from "ethers";

import { EntryField } from "src/common";
import { logHeader1, logHeader2 } from "src/logger";
import { ContractEntry } from "src/typebox";

import { CheckLevel, clearErrorContext, needCheck, SectionValidatorBase, setErrorContext } from "./base";
import { ChecksSectionValidator } from "./checks";
import { ImplementationChecksSectionValidator } from "./implementation-checks";
import { OzAclSectionValidator } from "./oz-acl";
import { OzNonEnumerableAclSectionValidator } from "./oz-non-enumerable-acl";
import { ProxyCheckSectionValidator } from "./proxy-check";

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
      switch (section) {
        case EntryField.checks: {
          this.map.set(section, new ChecksSectionValidator(provider, section));
          break;
        }
        case EntryField.proxyChecks: {
          this.map.set(section, new ProxyCheckSectionValidator(provider));
          break;
        }
        case EntryField.ozNonEnumerableAcl: {
          this.map.set(section, new OzNonEnumerableAclSectionValidator(provider));
          break;
        }
        case EntryField.implementationChecks: {
          this.map.set(section, new ImplementationChecksSectionValidator(provider));
          break;
        }
        case EntryField.ozAcl: {
          this.map.set(section, new OzAclSectionValidator(provider));
          break;
        }
        default: {
          //@ts-expect-error trick to detect compile-time errors when a new section is added
          const _: never = entryField;
          throw new Error("Unknown label section");
        }
      }
    }
  }

  public async see(contractEntry: ContractEntry, sectionTitle: string, contractAlias: string) {
    if (!needCheck(CheckLevel.contract, contractAlias)) return;

    logHeader1(`Contract (${sectionTitle}): ${contractAlias} (${contractEntry.name}, ${contractEntry.address})`);

    // Set base error context for this contract
    setErrorContext({
      section: sectionTitle,
      contract: contractAlias,
      contractAddress: contractEntry.address,
    });

    if (needCheck(CheckLevel.checksType, EntryField.checks)) {
      logHeader2(EntryField.checks);
      setErrorContext({ checksType: EntryField.checks });
      await this.map.get(EntryField.checks)!.validateSection(contractEntry, contractAlias);
    }

    if (needCheck(CheckLevel.checksType, EntryField.proxyChecks)) {
      setErrorContext({ checksType: EntryField.proxyChecks });
      await this.map.get(EntryField.proxyChecks)!.validateSection(contractEntry, contractAlias);
    }

    if (needCheck(CheckLevel.checksType, EntryField.ozNonEnumerableAcl)) {
      setErrorContext({ checksType: EntryField.ozNonEnumerableAcl });
      await this.map.get(EntryField.ozNonEnumerableAcl)!.validateSection(contractEntry, contractAlias);
    }

    if (needCheck(CheckLevel.checksType, EntryField.implementationChecks)) {
      setErrorContext({ checksType: EntryField.implementationChecks });
      await this.map.get(EntryField.implementationChecks)!.validateSection(contractEntry, contractAlias);
    }

    if (needCheck(CheckLevel.checksType, EntryField.ozAcl)) {
      setErrorContext({ checksType: EntryField.ozAcl });
      await this.map.get(EntryField.ozAcl)!.validateSection(contractEntry, contractAlias);
    }

    // Clear error context after contract validation
    clearErrorContext();
  }
}
