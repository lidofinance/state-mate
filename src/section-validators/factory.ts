import { JsonRpcProvider } from "ethers";

import { EntryField } from "src/common";

import { ChecksSectionValidator } from "./checks";
import { ImplementationChecksSectionValidator } from "./implementation-checks";
import { OzAclSectionValidator } from "./oz-acl";
import { OzNonEnumerableAclSectionValidator } from "./oz-non-enumerable-acl";
import { ProxyCheckSectionValidator } from "./proxy-check";

export const ValidatorFactory = {
  getValidator(entryField: EntryField, provider: JsonRpcProvider) {
    switch (entryField) {
      case EntryField.checks: {
        return new ChecksSectionValidator(provider);
      }
      case EntryField.proxyChecks: {
        return new ProxyCheckSectionValidator(provider);
      }
      case EntryField.ozNonEnumerableAcl: {
        return new OzNonEnumerableAclSectionValidator(provider);
      }
      case EntryField.implementationChecks: {
        return new ImplementationChecksSectionValidator(provider);
      }
      case EntryField.ozAcl: {
        return new OzAclSectionValidator(provider);
      }
      default: {
        //@ts-expect-error trick to detect compile-time errors when a new section is added
        const _: never = entryField;
        throw new Error("Unknown label section");
      }
    }
  },
};
