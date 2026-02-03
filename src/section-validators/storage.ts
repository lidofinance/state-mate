import { JsonRpcProvider } from "ethers";

import { EntryField } from "src/common";
import { LogCommand } from "src/logger";
import { ContractEntry } from "src/typebox";

import { incChecks, incErrors, SectionValidatorBase, setErrorContext } from "./base";

interface StorageCheckEntry {
  slot: string;
  expected: string;
  label?: string;
}

export class StorageSectionValidator extends SectionValidatorBase {
  constructor(provider: JsonRpcProvider) {
    super(provider, EntryField.storage);
  }

  override async validateSection(contractEntry: ContractEntry, contractAlias: string) {
    void contractAlias; // Used for interface compatibility
    const { address } = contractEntry;
    const storage = (contractEntry as { storage?: StorageCheckEntry[] }).storage;

    if (!storage || storage.length === 0) {
      return;
    }

    for (const { slot, expected: expectedValue, label } of storage) {
      incChecks();
      const displayName = label ? `storage[${label}]` : `storage[${slot}]`;
      const logHandle = new LogCommand(displayName);
      setErrorContext({ method: displayName });

      try {
        const actual = await this.provider.getStorage(address, slot);
        const normalizedActual = actual.toLowerCase();
        let normalizedExpected = expectedValue.toLowerCase();

        // If expected is a 20-byte address (42 chars with 0x), pad it to 32 bytes
        if (normalizedExpected.length === 42 && normalizedActual.length === 66) {
          normalizedExpected = "0x" + normalizedExpected.slice(2).padStart(64, "0");
        }

        if (normalizedActual === normalizedExpected) {
          logHandle.success(actual);
        } else {
          const errorMessage = `Expected "${expectedValue}" but got "${actual}"`;
          logHandle.failure(errorMessage);
          incErrors(errorMessage);
        }
      } catch (error) {
        const errorMessage = `Storage read failed: ${error instanceof Error ? error.message : String(error)}`;
        logHandle.failure(errorMessage);
        incErrors(errorMessage);
      }
    }
  }
}
