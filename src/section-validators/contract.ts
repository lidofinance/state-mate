import chalk from "chalk";
import { JsonRpcProvider } from "ethers";

import { EntryField } from "src/common";
import { logError, logFinalStatus, logHeader1, logHeader2 } from "src/logger";
import { ContractEntry, isTypeOfTB, ProxyContractEntryTB } from "src/typebox";

import {
  CheckLevel,
  clearErrorContext,
  getContractStats,
  incChecks,
  incErrors,
  needCheck,
  resetContractCounters,
  SectionValidatorBase,
  setErrorContext,
} from "./base";
import { ChecksSectionValidator } from "./checks";
import { ImplementationChecksSectionValidator } from "./implementation-checks";
import { OzAclSectionValidator } from "./oz-acl";
import { OzNonEnumerableAclSectionValidator } from "./oz-non-enumerable-acl";
import { ProxyCheckSectionValidator } from "./proxy-check";
import { StorageSectionValidator } from "./storage";

// bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class ContractSectionValidator {
  private map: Map<EntryField, SectionValidatorBase> = new Map();
  private provider: JsonRpcProvider;

  constructor(provider: JsonRpcProvider) {
    this.provider = provider;
    const sections = [
      EntryField.checks,
      EntryField.storage,
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
        case EntryField.storage: {
          this.map.set(section, new StorageSectionValidator(provider));
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

    // Reset per-contract counters
    resetContractCounters();

    logHeader1(`Contract: ${sectionTitle}/${contractAlias} (${contractEntry.name}, ${contractEntry.address})`);

    // Set base error context for this contract
    setErrorContext({
      section: sectionTitle,
      contract: contractAlias,
      contractAddress: contractEntry.address,
    });

    const basePath = `${sectionTitle}/${contractAlias}`;

    await this._checkEip1967Topology(contractEntry);

    if (needCheck(CheckLevel.checksType, EntryField.checks)) {
      logHeader2(`${basePath}/${EntryField.checks}`);
      setErrorContext({ checksType: EntryField.checks });
      await this.map.get(EntryField.checks)!.validateSection(contractEntry, contractAlias);
    }

    if (needCheck(CheckLevel.checksType, EntryField.storage)) {
      setErrorContext({ checksType: EntryField.storage });
      await this.map.get(EntryField.storage)!.validateSection(contractEntry, contractAlias, basePath);
    }

    if (needCheck(CheckLevel.checksType, EntryField.proxyChecks)) {
      setErrorContext({ checksType: EntryField.proxyChecks });
      await this.map.get(EntryField.proxyChecks)!.validateSection(contractEntry, contractAlias, basePath);
    }

    if (needCheck(CheckLevel.checksType, EntryField.ozNonEnumerableAcl)) {
      setErrorContext({ checksType: EntryField.ozNonEnumerableAcl });
      await this.map.get(EntryField.ozNonEnumerableAcl)!.validateSection(contractEntry, contractAlias, basePath);
    }

    if (needCheck(CheckLevel.checksType, EntryField.implementationChecks)) {
      setErrorContext({ checksType: EntryField.implementationChecks });
      await this.map.get(EntryField.implementationChecks)!.validateSection(contractEntry, contractAlias, basePath);
    }

    if (needCheck(CheckLevel.checksType, EntryField.ozAcl)) {
      setErrorContext({ checksType: EntryField.ozAcl });
      await this.map.get(EntryField.ozAcl)!.validateSection(contractEntry, contractAlias, basePath);
    }

    // Clear error context after contract validation
    clearErrorContext();

    // Show contract status (not last, global status follows)
    const { checks, errors } = getContractStats();
    const statusMessage = errors
      ? `${checks} checks, ${chalk.red(`${errors} ${errors === 1 ? "error" : "errors"}`)}`
      : `${checks} checks passed`;
    logFinalStatus(statusMessage, errors === 0, true);
  }

  private async _checkEip1967Topology(contractEntry: ContractEntry): Promise<void> {
    if (contractEntry.skipImplementationChecks) return;

    let raw: string;
    try {
      raw = await this.provider.getStorage(contractEntry.address, EIP1967_IMPL_SLOT);
    } catch {
      return; // best-effort: ignore storage read failures
    }
    if (!raw || raw === "0x" || /^0x0+$/.test(raw)) return;

    const implFromSlot = `0x${raw.slice(-40).toLowerCase()}`;
    if (implFromSlot === ZERO_ADDRESS) return;

    setErrorContext({ checksType: "eip1967ProxyDetection", method: "getStorage" });

    if (isTypeOfTB(contractEntry, ProxyContractEntryTB)) {
      if (contractEntry.implementation && contractEntry.implementation.toLowerCase() !== implFromSlot) {
        const message = `EIP-1967 implementation slot reports ${implFromSlot}, but config declares ${contractEntry.implementation.toLowerCase()}`;
        logError(message);
        incErrors(message);
      } else {
        incChecks();
      }
      return;
    }

    const message =
      `Address ${contractEntry.address} is an EIP-1967 proxy (impl=${implFromSlot}) but is described as a plain contract. ` +
      `Use the proxy form (proxyName/implementation/proxyChecks/implementationChecks), or set 'skipImplementationChecks: true' to acknowledge.`;
    logError(message);
    incErrors(message);
  }
}
