import { JsonRpcProvider } from "ethers";

import { EntryField } from "src/common";
import { logHeader2, LogCommand } from "src/logger";
import { ContractEntry } from "src/typebox";

import { incChecks, incErrors, SectionValidatorBase, setErrorContext } from "./base";

/**
 * Normalizes a hex value to a 32-byte (64 hex chars + 0x prefix = 66 chars) representation.
 * This ensures consistent comparison between expected values and actual storage values.
 *
 * - 20-byte addresses (42 chars) are left-padded to 32 bytes
 * - Shorter hex values are left-padded to 32 bytes
 * - Already 32-byte values are returned as-is
 */
function normalizeToBytes32(value: string): string {
  const lower = value.toLowerCase();

  // If already 66 chars (32 bytes), return as-is
  if (lower.length === 66) {
    return lower;
  }

  // For any hex value shorter than 32 bytes, left-pad with zeros
  if (lower.startsWith("0x") && lower.length < 66) {
    return "0x" + lower.slice(2).padStart(64, "0");
  }

  // Return as-is for non-hex values or unexpected formats
  return lower;
}

export class StorageSectionValidator extends SectionValidatorBase {
  constructor(provider: JsonRpcProvider) {
    super(provider, EntryField.storage);
  }

  override async validateSection(contractEntry: ContractEntry, contractAlias: string, basePath?: string) {
    void contractAlias; // Used for interface compatibility
    const { address, storage } = contractEntry;

    if (!storage || storage.length === 0) {
      return;
    }

    logHeader2(basePath ? `${basePath}/${this.sectionName}` : this.sectionName);

    for (const { slot, expected: expectedValue, label } of storage) {
      incChecks();
      const displayName = label ? `[${label}]` : `[${slot}]`;
      const logHandle = new LogCommand(displayName);
      setErrorContext({ method: displayName });

      try {
        const actual = await this.provider.getStorage(address, slot);
        const normalizedActual = normalizeToBytes32(actual);
        const normalizedExpected = normalizeToBytes32(expectedValue);

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
