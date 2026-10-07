import { concat, type JsonRpcProvider, keccak256, zeroPadValue } from "ethers";

import { printError } from "../common";

/**
 * `keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.AccessControl")) - 1)) & ~0xff`,
 * the ERC-7201 location OpenZeppelin v5 keeps `mapping(bytes32 role => RoleData) _roles` at.
 */
export const OZ_V5_ACCESS_CONTROL_BASE = "0x02dd7bc7dec4dceedda775e58dd541e08a116c6c53815c0bd028192f7b626800";

/** OpenZeppelin v4 declares `_roles` as the first slot of AccessControl. */
export const OZ_V4_ROLES_SLOT = `0x${"0".repeat(64)}`;

export interface StorageLayout {
  base: string;
  name: string;
}

export const CANDIDATE_LAYOUTS: readonly StorageLayout[] = [
  { base: OZ_V5_ACCESS_CONTROL_BASE, name: "openzeppelin v5 (erc-7201 namespaced)" },
  { base: OZ_V4_ROLES_SLOT, name: "openzeppelin v4 (_roles at slot 0)" },
];

const TRUE_WORD = `0x${"0".repeat(63)}1`;
const FALSE_WORD = `0x${"0".repeat(64)}`;

/** `_roles[role]`, whose first member is the `mapping(address => bool) members`. */
export function roleDataSlot(base: string, role: string): string {
  return keccak256(concat([role, base]));
}

/** `_roles[role].members[account]`. */
export function memberSlot(base: string, role: string, account: string): string {
  return keccak256(concat([zeroPadValue(account, 32), roleDataSlot(base, role)]));
}

export type SlotReading = { held: boolean; ok: true } | { ok: false; word: string };

/**
 * A membership word is a bool, so it is exactly zero or one. Anything else means the slot being
 * read is not the mapping it was taken for, and reporting it as "not a holder" would be a guess
 * dressed up as a check.
 */
export function decodeMembership(word: string): SlotReading {
  const normalized = word.toLowerCase();
  if (normalized === TRUE_WORD) return { held: true, ok: true };
  if (normalized === FALSE_WORD) return { held: false, ok: true };
  return { ok: false, word: normalized };
}

export async function readMembership(
  provider: JsonRpcProvider,
  address: string,
  layout: StorageLayout,
  role: string,
  account: string,
): Promise<SlotReading> {
  const word = await provider.getStorage(address, memberSlot(layout.base, role, account));
  return decodeMembership(word);
}

export interface CalibrationInput {
  /** Pairs the chain has already confirmed with `hasRole`, so the expected word is known. */
  account: string;
  role: string;
}

export type Calibration = { layout: StorageLayout; ok: true } | { ok: false; reason: string };

/**
 * Finds which storage layout the contract actually uses, by checking the holders the chain has
 * already confirmed against each candidate until one of them reads back as held.
 *
 * This is the gate that makes the whole exhaustive check sound. Event scanning is only complete if
 * every membership change emitted a standard event, and the only cheap evidence for that is that
 * the contract stores memberships where standard AccessControl stores them. When nothing
 * calibrates the contract is something else, and its event log cannot be assumed to be the whole
 * story -- so the check refuses to run rather than reporting a clean ACL it has not verified.
 *
 * Every confirmed holder gets a turn rather than only the first one. A layout is established by
 * any holder that reads back from it, so a single holder whose view answer disagrees with its slot
 * becomes a finding in the reconciliation that follows instead of derailing the search and
 * reporting "unknown layout" for a contract whose layout is perfectly well known.
 */
export async function calibrateStorageLayout(
  provider: JsonRpcProvider,
  address: string,
  confirmed: readonly CalibrationInput[],
): Promise<Calibration> {
  if (confirmed.length === 0) {
    return {
      ok: false,
      reason: "no configured role holder was confirmed on chain, so the storage layout cannot be calibrated",
    };
  }

  const tried: string[] = [];

  for (const layout of CANDIDATE_LAYOUTS) {
    const oddWords = new Set<string>();
    for (const { account, role } of confirmed) {
      let reading: SlotReading;
      try {
        reading = await readMembership(provider, address, layout, role, account);
      } catch (error) {
        return { ok: false, reason: `could not read storage at ${address}: ${printError(error)}` };
      }
      if (reading.ok && reading.held) return { layout, ok: true };
      // A word that is not a bool says the slot is not the mapping it was taken for, which is a
      // sharper hint than "nobody read back" and worth keeping in the failure
      if (!reading.ok) oddWords.add(reading.word);
    }
    const odd = oddWords.size > 0 ? ` (unexpected word ${[...oddWords].join(", ")})` : "";
    tried.push(`${layout.name} -> none of the ${confirmed.length} confirmed holder(s) read back${odd}`);
  }

  return {
    ok: false,
    reason: `no known AccessControl storage layout accounts for any confirmed holder at ${address} (${tried.join("; ")})`,
  };
}
