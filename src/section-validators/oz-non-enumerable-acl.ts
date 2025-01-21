import { assert } from "chai";
import { JsonRpcProvider } from "ethers";

import { loadAbiFromFile } from "src/abi-provider";
import { Ef } from "src/common";
import { loadContract, safeStaticCall } from "src/explorer-provider";
import { log, LogCommand, logHeader2, WARNING_MARK } from "src/logger";
import { ContractEntry } from "src/typebox";

import { incErrors, SectionValidatorBase } from "./base";

export class OzNonEnumerableAclSectionValidator extends SectionValidatorBase {
  constructor(provider: JsonRpcProvider) {
    super(provider, Ef.ozNonEnumerableAcl);
  }
  override async validateSection(contractEntry: ContractEntry) {
    if (contractEntry.ozNonEnumerableAcl) {
      logHeader2(this.sectionName);
      await this._validate(contractEntry);
    }
  }

  protected async _validate(contractEntry: ContractEntry) {
    const abi = loadAbiFromFile(contractEntry.name, contractEntry.address);
    const contract = loadContract(contractEntry.address, abi, this.provider); //TODO to move out from this method

    log(
      `${WARNING_MARK}: Non-enumerable OZ Acl means it is impossible to check absence of an arbitrary role holder ` +
        `only by means of calling view function. Current version of state-mate does what it can at most: for all the ` +
        `role holders specified checks they do not hold roles they are not described to have among all the roles mentioned.`,
    );

    const rolesByHolders = new Map<string, Set<string>>();
    for (const role in contractEntry.ozNonEnumerableAcl) {
      for (const holder of contractEntry.ozNonEnumerableAcl[role]) {
        if (!rolesByHolders.has(holder)) {
          rolesByHolders.set(holder, new Set<string>());
        }
        rolesByHolders.get(holder)?.add(role);
        const isRoleOnHolder: unknown = await safeStaticCall(contract, "hasRole", role, holder);
        const logHandle = new LogCommand(`.hasRole(${role}, ${holder})`);
        try {
          assert.isTrue(isRoleOnHolder);
          logHandle.success(`${isRoleOnHolder}`);
        } catch (error) {
          logHandle.failure(`REVERTED with: ${(error as Error).message}`);
          incErrors();
        }
      }
    }

    for (const [holder, rolesExpectedOnTheHolder] of rolesByHolders) {
      for (const role in contractEntry.ozNonEnumerableAcl) {
        if (!rolesExpectedOnTheHolder.has(role)) {
          const isRoleOnHolder: unknown = await safeStaticCall(contract, "hasRole", role, holder); //await contract.getFunction("hasRole").staticCall(role, holder);
          const logHandle = new LogCommand(`.hasRole(${role}, ${holder})`);
          try {
            assert.isFalse(isRoleOnHolder);
            logHandle.success(`${isRoleOnHolder}`);
          } catch (error) {
            logHandle.failure(`REVERTED with: ${(error as Error).message}`);
            incErrors();
          }
        }
      }
    }
  }
}