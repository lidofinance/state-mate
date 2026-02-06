/* eslint-disable @typescript-eslint/no-unused-vars */
import { JsonRpcProvider, Interface, Contract } from "ethers";

import { EntryField } from "src/common";
import { logError, logHeader2 } from "src/logger";
import { ContractEntry, StaticCallResult } from "src/typebox";

import { SectionValidatorBase } from "./base";

const ACCESS_CONTROL_ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getRoleMemberCount(bytes32 role) view returns (uint256)",
  "function getRoleMember(bytes32 role, uint256 index) view returns (address)",
];

export class OzAclSectionValidator extends SectionValidatorBase {
  constructor(provider: JsonRpcProvider, sectionName: EntryField = EntryField.ozAcl) {
    super(provider, sectionName);
  }

  override async validateSection(contractEntry: ContractEntry, contractAlias: string) {
    if (contractEntry.ozAcl) {
      logHeader2(this.sectionName);

      const address = contractEntry.address;
      const iface = new Interface(ACCESS_CONTROL_ABI);
      const contract = new Contract(address, iface, this.provider);

      for (const [role, expectedAddrs] of Object.entries(contractEntry.ozAcl)) {
        logHeader2(`Role: ${role}`);

        // Get actual role member count
        const actualCount = await contract.getRoleMemberCount(role);
        const expectedCount = expectedAddrs.length;

        // Check if counts match
        const countCheck: StaticCallResult = {
          signature: "getRoleMemberCount",
          args: [role],
          result: expectedCount,
        };
        await this._checkViewFunction(contract, "getRoleMemberCount", countCheck);

        // If count doesn't match, enumerate actual members for debugging
        if (Number(actualCount) !== expectedCount) {
          logError(`Role member count mismatch. Actual members:`);
          for (let index = 0; index < Number(actualCount); index++) {
            try {
              const member = await contract.getRoleMember(role, index);
              logError(`  [${index}] ${member}`);
            } catch {
              // getRoleMember might not be available in all AccessControl implementations
              break;
            }
          }
        }

        // Check hasRole(role, addr) == true for each expected addr
        for (const addr of expectedAddrs) {
          const hasRoleCheck: StaticCallResult = {
            signature: "hasRole",
            args: [role, addr],
            result: true,
          };
          await this._checkViewFunction(contract, "hasRole", hasRoleCheck);
        }
      }
    }
  }
}
