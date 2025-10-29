/* eslint-disable @typescript-eslint/no-unused-vars */
import { JsonRpcProvider, Interface, Contract } from "ethers";

import { EntryField } from "src/common";
import { logHeader2 } from "src/logger";
import { ContractEntry, StaticCallResult } from "src/typebox";

import { SectionValidatorBase } from "./base";

const ACCESS_CONTROL_ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getRoleMemberCount(bytes32 role) view returns (uint256)",
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

      for (const [role, addrs] of Object.entries(contractEntry.ozAcl)) {
        logHeader2(`Role: ${role}`);

        // Check getRoleMemberCount(role) == addrs.length
        const countCheck: StaticCallResult = {
          signature: "getRoleMemberCount",
          args: [role],
          result: addrs.length,
        };
        await this._checkViewFunction(contract, "getRoleMemberCount", countCheck);

        // Check hasRole(role, addr) == true for each addr
        for (const addr of addrs) {
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
