import { assert } from "chai";
import { JsonRpcProvider } from "ethers";

import { EntryField } from "src/common";
import { loadContract } from "src/explorer-provider";
import { log, LogCommand, logHeader2, WARNING_MARK } from "src/logger";
import { ContractEntry } from "src/typebox";
import { ChainId } from "src/types";

import { incChecks, incErrors, SectionValidatorBase, setErrorContext } from "./base";

export class OzNonEnumerableAclSectionValidator extends SectionValidatorBase {
  constructor(provider: JsonRpcProvider, chainId: ChainId) {
    super(provider, EntryField.ozNonEnumerableAcl, chainId);
  }

  override async validateSection(contractEntry: ContractEntry, contractAlias: string, basePath?: string) {
    void contractAlias; // Used for interface compatibility
    if (contractEntry.ozNonEnumerableAcl) {
      logHeader2(basePath ? `${basePath}/${this.sectionName}` : this.sectionName);
      await this._validate(contractEntry);
    }
  }

  protected async _validate(contractEntry: ContractEntry) {
    const abi = this._loadContractAbi(contractEntry);
    const contract = loadContract(contractEntry.address, abi, this.provider); //TODO to move out from this method

    log(
      `${WARNING_MARK}: Non-enumerable OZ Acl means it is impossible to check absence of an arbitrary role holder ` +
        `only by means of calling view function. Current version of state-mate does what it can at most: for all the ` +
        `role holders specified checks they do not hold roles they are not described to have among all the roles mentioned.`,
    );

    const rolesByHolders = new Map<string, Set<string>>();
    for (const role in contractEntry.ozNonEnumerableAcl) {
      const holders = contractEntry.ozNonEnumerableAcl[role];
      for (const holder of holders) {
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
          logHandle.success(String(isRoleOnHolder));
        } catch (error) {
          const errorMessage = `REVERTED with: ${(error as Error).message}`;
          logHandle.failure(errorMessage);
          incErrors(errorMessage);
        }
      }
    }

    for (const [holder, rolesExpectedOnTheHolder] of rolesByHolders) {
      for (const role in contractEntry.ozNonEnumerableAcl) {
        if (rolesExpectedOnTheHolder.has(role)) {
          continue;
        }

        incChecks();
        const methodName = `.hasRole(${role}, ${holder})`;
        const logHandle = new LogCommand(methodName);
        setErrorContext({ method: methodName });
        try {
          const isRoleOnHolder: unknown = await contract.getFunction("hasRole").staticCall(role, holder);
          assert.isFalse(isRoleOnHolder);
          logHandle.success(String(isRoleOnHolder));
        } catch (error) {
          const errorMessage = `REVERTED with: ${(error as Error).message}`;
          logHandle.failure(errorMessage);
          incErrors(errorMessage);
        }
      }
    }
  }
}
