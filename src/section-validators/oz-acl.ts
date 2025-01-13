import { JsonRpcProvider } from "ethers";
import { Ef } from "../common";
import { ContractEntry } from "../typebox";
import { SectionValidatorBase } from "./base";
import { logHeader2 } from "../logger";
export class OzAclSectionValidator extends SectionValidatorBase {
  constructor(provider: JsonRpcProvider, sectionName: Ef = Ef.ozAcl) {
    super(provider, sectionName);
  }

  override async validateSection({ name, address, checks }: ContractEntry, contractAlias: string) {
    logHeader2(this.sectionName);
    //TODO
  }
}
