/* eslint-disable @typescript-eslint/no-unused-vars */
import { JsonRpcProvider } from "ethers";

import { Ef } from "src/common";
import { logHeader2 } from "src/logger";
import { ContractEntry } from "src/typebox";

import { SectionValidatorBase } from "./base";
export class OzAclSectionValidator extends SectionValidatorBase {
  constructor(provider: JsonRpcProvider, sectionName: Ef = Ef.ozAcl) {
    super(provider, sectionName);
  }

  override async validateSection({ name, address, checks }: ContractEntry, contractAlias: string) {
    //TODO
    //logHeader2(this.sectionName);
  }
}
