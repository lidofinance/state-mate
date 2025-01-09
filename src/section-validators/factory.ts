import { JsonRpcProvider } from "ethers";
import { Ef } from "../common";
import { ChecksSectionValidator } from "./checks";
import { OzNonEnumerableAclSectionValidator } from "./oz-non-enumerable-acl";
import { ProxyCheckSectionValidator } from "./proxy-check";

export class ValidatorFactory {
  static getValidator(ef: Ef, provider: JsonRpcProvider) {
    switch (ef) {
      case Ef.checks:
        return new ChecksSectionValidator(provider);
      case Ef.proxyChecks:
        return new ProxyCheckSectionValidator(provider);
      case Ef.ozNonEnumerableAcl:
        return new OzNonEnumerableAclSectionValidator(provider);
      case Ef.implementationChecks:
        return new OzNonEnumerableAclSectionValidator(provider);
      default:
        //@ts-expect-error trick to detect compile-time errors when a new section is added
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _: never = ef;
        throw new Error("Unknown label section");
    }
  }
}
