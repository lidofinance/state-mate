import chalk from "chalk";
import { getAddress, JsonRpcProvider } from "ethers";

import { context } from "src/context";
import { LogCommand } from "src/logger";
import { ContractEntry, isTypeOfTB, ProxyContractEntryTB } from "src/typebox";

import { incChecks, incErrors, setErrorContext } from "./base";

// keccak256("eip1967.proxy.implementation") - 1. Read first, every EIP-1967 proxy keeps the
// address here
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
// keccak256("eip1967.proxy.admin") - 1, holds the ProxyAdmin of a transparent proxy
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
// implementation(). Aragon-style proxies leave the slot empty and expose this getter instead
const IMPLEMENTATION_SELECTOR = "0x5c60da1b";
// proxy__getImplementation(), the OssifiableProxy getter
const PROXY_GET_IMPLEMENTATION_SELECTOR = "0xad729a71";
// owner()
const OWNER_SELECTOR = "0x8da5cb5b";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
// Safe stores its singleton here. Read only for Safe proxies: in any other contract the first
// slot holds an ordinary variable, and an address-shaped one would fake a mismatch
const SAFE_SINGLETON_SLOT = "0x0";
const SAFE_PROXY_NAMES = new Set(["SafeProxy", "GnosisSafeProxy"]);

const BYPASS_HINT = `pass ${chalk.yellow("--skip-implementation-check")} to skip this check`;

/**
 * Rejects a word whose upper 12 bytes are set: a packed storage variable would otherwise
 * pass for an address and report a mismatch that does not exist. Checksums the result so that
 * errors do not mix a lowercase address with the checksummed one from the config.
 */
function addressFromWord(word: null | string | undefined): string | undefined {
  if (!word || !/^0x0{24}(?!0{40})[0-9a-fA-F]{40}$/.test(word)) return undefined;
  return getAddress(`0x${word.slice(26)}`);
}

// Both readers swallow failures so the caller falls through to the next resolution step. The
// slot reader still reports the failure: an unanswered read proves nothing about the contract
async function readSlotWord(
  provider: JsonRpcProvider,
  address: string,
  slot: string,
): Promise<{ failed?: true; word?: string }> {
  try {
    return { word: await provider.getStorage(address, slot) };
  } catch {
    return { failed: true };
  }
}

async function callWord(provider: JsonRpcProvider, address: string, selector: string): Promise<string | undefined> {
  try {
    return await provider.call({ data: selector, to: address });
  } catch {
    return undefined;
  }
}

async function callAsAddress(
  provider: JsonRpcProvider,
  address: string,
  selector: string,
): Promise<string | undefined> {
  return addressFromWord(await callWord(provider, address, selector));
}

/** Numeric comparison, so hex case, word width and leading zeros do not matter. */
function sameWord(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

/** True when a `storage:` check already pins the same word. */
function pinsStorageWord(contractEntry: ContractEntry, slot: string, expected: string): boolean {
  const { storage } = contractEntry as { storage?: { expected: string; slot: string }[] };
  return (storage ?? []).some((check) => sameWord(check.slot, slot) && sameWord(check.expected, expected));
}

/**
 * Verifies `implementation:` against the chain for every entry, including entries with no
 * `proxyChecks`. A stale address, or a proxy described as a regular contract, makes state-mate
 * load the wrong ABI and every check under it passes against the wrong contract.
 */
export async function checkImplementation(provider: JsonRpcProvider, contractEntry: ContractEntry): Promise<void> {
  // `-o <section>/<contract>/checks` asks for one checks type, so keep an unrelated failure out
  if (context.skipImplementationCheck || context.checkOnly?.checksType) return;

  const { address } = contractEntry;
  const proxyEntry = isTypeOfTB(contractEntry, ProxyContractEntryTB) ? contractEntry : undefined;
  const expected = proxyEntry?.implementation;

  // Let the storage validator own an assertion the config already expresses. Running the same
  // eth_getStorageAt twice would only duplicate the check and its counters.
  const implementationSlot = SAFE_PROXY_NAMES.has(proxyEntry?.proxyName ?? "")
    ? SAFE_SINGLETON_SLOT
    : EIP1967_IMPLEMENTATION_SLOT;
  if (expected && pinsStorageWord(contractEntry, implementationSlot, expected)) return;

  setErrorContext({ checksType: "implementation", method: "implementation" });
  const logHandle = new LogCommand("implementation");
  // An inconclusive read is a skip, not a pass: only a verdict counts towards the totals
  const fail = (message: string) => {
    incChecks();
    logHandle.failure(message);
    incErrors(message);
  };

  let actual: string | undefined;

  if (SAFE_PROXY_NAMES.has(proxyEntry?.proxyName ?? "")) {
    // A SafeProxy delegates to slot 0 whatever the EIP-1967 slot holds, and answers no getters,
    // so slot 0 is the only read that can vouch for it
    const safeSlot = await readSlotWord(provider, address, SAFE_SINGLETON_SLOT);
    if (safeSlot.failed) {
      fail(`the singleton slot of ${address} could not be read, so nothing was verified; retry, or ${BYPASS_HINT}`);
      return;
    }
    const singleton = addressFromWord(safeSlot.word);
    if (!expected) {
      if (!singleton) {
        fail(
          `${address} is declared ${proxyEntry?.proxyName}, but no implementation could be read on-chain. ` +
            `Add ${chalk.yellow("implementation")}, or ${BYPASS_HINT}`,
        );
        return;
      }
      // A storage: check pinning slot 0 to the same singleton asserts the linkage elsewhere in
      // the entry; anything less leaves the delegation unverified
      if (pinsStorageWord(contractEntry, SAFE_SINGLETON_SLOT, singleton)) {
        logHandle.warning(`delegates to ${singleton}, but the config pins no implementation`);
        return;
      }
      fail(
        `${address} delegates to ${singleton}, but the config pins no implementation. ` +
          `Add ${chalk.yellow("implementation")}, or ${BYPASS_HINT}`,
      );
      return;
    }
    actual = singleton;
  } else {
    const slotRead = await readSlotWord(provider, address, EIP1967_IMPLEMENTATION_SLOT);
    const slotImplementation = addressFromWord(slotRead.word);

    if (!expected) {
      // Judge an undeclared entry by this slot alone. A beacon answers implementation()
      // legitimately, and the first slot of an ordinary contract holds whatever its first
      // variable is
      if (slotImplementation) {
        const complaint = proxyEntry?.proxyName
          ? `the config pins no implementation. Add ${chalk.yellow("implementation")}`
          : `the config describes it as a regular contract. ` +
            `Add ${chalk.yellow("proxyName")} and ${chalk.yellow("implementation")}`;
        fail(`${address} delegates to ${slotImplementation}, but ${complaint}, or ${BYPASS_HINT}`);
        return;
      }
      if (slotRead.failed) {
        fail(
          `the implementation slot of ${address} could not be read, so nothing was verified; retry, or ${BYPASS_HINT}`,
        );
        return;
      }
      if (proxyEntry?.proxyName) {
        // The config calls it a proxy; a getter may still name the implementation the empty
        // EIP-1967 slot did not, and either way "not a proxy" would contradict the config
        const viaGetter =
          (await callAsAddress(provider, address, IMPLEMENTATION_SELECTOR)) ??
          (await callAsAddress(provider, address, PROXY_GET_IMPLEMENTATION_SELECTOR));
        const complaint = viaGetter
          ? `${address} delegates to ${viaGetter}, but the config pins no implementation`
          : `${address} is declared ${proxyEntry.proxyName}, but no implementation could be read on-chain`;
        fail(`${complaint}. Add ${chalk.yellow("implementation")}, or ${BYPASS_HINT}`);
        return;
      }
      incChecks();
      logHandle.success("not a proxy");
      return;
    }

    // The config declares this one a proxy, so the riskier reads are safe to try
    actual = slotImplementation ?? (await callAsAddress(provider, address, IMPLEMENTATION_SELECTOR));
    actual ??= await callAsAddress(provider, address, PROXY_GET_IMPLEMENTATION_SELECTOR);
  }

  if (!actual) {
    fail(`the implementation of ${address} could not be read, so nothing was verified; retry, or ${BYPASS_HINT}`);
    return;
  }

  if (actual.toLowerCase() !== expected.toLowerCase()) {
    fail(
      `${address} delegates to ${actual}, while the config expects ${expected}. ` +
        `Update ${chalk.yellow("implementation")} in the config and re-run with ${chalk.yellow("--update-abi")}, or ${BYPASS_HINT}`,
    );
    return;
  }

  incChecks();
  logHandle.success(actual);
}

/**
 * Verifies who owns the ProxyAdmin a transparent proxy delegates upgrades to. The ProxyAdmin
 * address itself is a `storage:` check away, but its owner is one hop further, and that owner is
 * what actually controls the upgrade. Opt-in per entry, so no bypass flag.
 */
export async function checkProxyAdminOwner(provider: JsonRpcProvider, contractEntry: ContractEntry): Promise<void> {
  if (!isTypeOfTB(contractEntry, ProxyContractEntryTB) || !contractEntry.proxyAdminOwner) return;

  const { address, proxyAdminOwner: expected } = contractEntry;
  setErrorContext({ checksType: "proxyAdminOwner", method: "proxyAdminOwner" });
  incChecks();
  const logHandle = new LogCommand("proxyAdminOwner");

  const adminSlot = await readSlotWord(provider, address, EIP1967_ADMIN_SLOT);
  // An unanswered read proves nothing about the proxy: a throttled or failing provider must not
  // be reported as a proxy that keeps no admin
  if (adminSlot.failed) {
    const message = `the admin slot of ${address} could not be read, so nothing was verified; retry`;
    logHandle.failure(message);
    incErrors(message);
    return;
  }
  const admin = addressFromWord(adminSlot.word);
  if (!admin) {
    const message = `${address} keeps no admin in the EIP-1967 slot, so it has no ProxyAdmin to own`;
    logHandle.failure(message);
    incErrors(message);
    return;
  }

  // A renounced admin answers owner() with the zero address; that is a real answer the config
  // may legitimately expect
  const ownerWord = await callWord(provider, admin, OWNER_SELECTOR);
  const owner = /^0x0{64}$/.test(ownerWord ?? "") ? ZERO_ADDRESS : addressFromWord(ownerWord);
  if (!owner) {
    const message =
      `the admin of ${address}, ${admin}, does not answer owner(). ` +
      `Assert the admin address itself with a ${chalk.yellow("storage:")} check on the EIP-1967 admin slot`;
    logHandle.failure(message);
    incErrors(message);
    return;
  }

  if (owner.toLowerCase() !== expected.toLowerCase()) {
    const message = `${admin} administers ${address} and is owned by ${owner}, while the config expects ${expected}`;
    logHandle.failure(message);
    incErrors(message);
    return;
  }

  logHandle.success(`${owner} owns ${admin}`);
}
