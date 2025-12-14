import { assert } from "chai";
import { JsonRpcProvider } from "ethers";

import { loadAbiFromFile } from "src/abi-provider";
import { EntryField } from "src/common";
import { loadContract } from "src/explorer-provider";
import { log, LogCommand, logHeader2, WARNING_MARK } from "src/logger";
import { ContractEntry, isTypeOfTB, ProxyContractEntryTB } from "src/typebox";
import { Abi } from "src/types";

import { incChecks, incErrors, SectionValidatorBase, setErrorContext } from "./base";

export class OzNonEnumerableAclSectionValidator extends SectionValidatorBase {
  constructor(provider: JsonRpcProvider) {
    super(provider, EntryField.ozNonEnumerableAcl);
  }
  override async validateSection(contractEntry: ContractEntry) {
    if (contractEntry.ozNonEnumerableAcl) {
      logHeader2(this.sectionName);
      await this._validate(contractEntry);
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

  protected async _validate(contractEntry: ContractEntry) {
    const abi = this._loadAbiWithImplementationFallback(contractEntry);
    const contract = loadContract(contractEntry.address, abi, this.provider); //TODO to move out from this method

    log(
      `${WARNING_MARK}: Non-enumerable OZ Acl means it is impossible to check absence of an arbitrary role holder ` +
        `only by means of calling view function. Current version of state-mate does what it can at most: for all the ` +
        `role holders specified checks they do not hold roles they are not described to have among all the roles mentioned.`,
    );

    const rolesByHolders = new Map<string, Set<string>>();
    for (const role in contractEntry.ozNonEnumerableAcl) {
      for (const holder of contractEntry.ozNonEnumerableAcl[role]) {
        incChecks();
        if (!rolesByHolders.has(holder)) {
          rolesByHolders.set(holder, new Set<string>());
        }
        rolesByHolders.get(holder)?.add(role);
        const methodName = `.hasRole(${role}, ${holder})`;
        const logHandle = new LogCommand(methodName);
        setErrorContext({ method: methodName });
        try {
          const isRoleOnHolder: unknown = await contract.getFunction("hasRole").staticCall(role, holder);
          assert.isTrue(isRoleOnHolder);
          logHandle.success(`${isRoleOnHolder}`);
        } catch (error) {
          const errorMessage = `REVERTED with: ${(error as Error).message}`;
          logHandle.failure(errorMessage);
          incErrors(errorMessage);
        }
      }
    }

    for (const [holder, rolesExpectedOnTheHolder] of rolesByHolders) {
      for (const role in contractEntry.ozNonEnumerableAcl) {
        if (!rolesExpectedOnTheHolder.has(role)) {
          incChecks();
          const methodName = `.hasRole(${role}, ${holder})`;
          const logHandle = new LogCommand(methodName);
          setErrorContext({ method: methodName });
          try {
            const isRoleOnHolder: unknown = await contract.getFunction("hasRole").staticCall(role, holder);
            assert.isFalse(isRoleOnHolder);
            logHandle.success(`${isRoleOnHolder}`);
          } catch (error) {
            const errorMessage = `REVERTED with: ${(error as Error).message}`;
            logHandle.failure(errorMessage);
            incErrors(errorMessage);
          }
        }
      }
    }
  }
}
