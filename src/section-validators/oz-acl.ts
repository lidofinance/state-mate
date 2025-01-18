/* eslint-disable @typescript-eslint/no-unused-vars */
import { JsonRpcProvider } from "ethers";

import { Ef } from "src/common";
import { logHeader2 } from "src/logger";
import { ContractEntry, isTypeOfTB, ProxyContractEntryTB } from "src/typebox";

import { SectionValidatorBase } from "./base";
export class OzAclSectionValidator extends SectionValidatorBase {
  constructor(provider: JsonRpcProvider, sectionName: Ef = Ef.ozAcl) {
    super(provider, sectionName);
  }

  override async validateSection(contractEntry: ContractEntry, contractAlias: string) {
    if (isTypeOfTB(contractEntry, ProxyContractEntryTB) && contractEntry.ozAcl) {
      logHeader2(this.sectionName);
      //TODO
    }
  }
}
