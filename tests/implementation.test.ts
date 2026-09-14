import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { JsonRpcProvider } from "ethers";

import { context, resetStats, stats } from "../src/context";
import { resetContractCounters } from "../src/section-validators/base";
import { checkImplementation, checkProxyAdmin } from "../src/section-validators/implementation";
import type { ContractEntry } from "../src/typebox";

const PROXY_ADDRESS = "0xAaAaAAaaAaAAAaaAAaAaaaAAaAAAaaaAaaaaaaa1";
const IMPL_ADDRESS = "0xBbbBBBbbbBBbbbBbbBbbbbBBbBBbbBbBbbbbbbb2";
const OTHER_IMPL_ADDRESS = "0xcCCcccCcCCcCcCCCcCcccCcCcCcCcCCcCcccCcC3";
const PROXY_ADMIN_ADDRESS = "0xDdDDDddDdDddDDddDDddDDDDdDdDDdDDdDDDDDD4";
const OWNER_ADDRESS = "0xEeeEEEeeeEEEeeeEEEeeeeEeeeeEEEEeeEEeEeE5";
const OTHER_ADMIN_ADDRESS = "0x9999999999999999999999999999999999999999";
const EIP1967_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const SAFE_SLOT = "0x0";
const ZERO_WORD = `0x${"0".repeat(64)}`;

function word(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

type ProviderStub = {
  callResult?: Error | string;
  calls?: Record<string, Error | string>;
  selectors?: Record<string, Error | string>;
  slotErrors?: Record<string, Error>;
  slots?: Record<string, string>;
};

/** Records every read so that the tests can assert which resolution steps ran. */
function stubProvider(stub: ProviderStub): { provider: JsonRpcProvider; reads: string[] } {
  const reads: string[] = [];
  const provider = {
    async call({ data, to }: { data: string; to: string }) {
      reads.push(`call:${to.toLowerCase()}`);
      const answer = stub.selectors?.[data] ?? stub.calls?.[to.toLowerCase()] ?? stub.callResult;
      if (answer instanceof Error) throw answer;
      return answer ?? ZERO_WORD;
    },
    async getStorage(_address: string, slot: string) {
      reads.push(`slot:${slot}`);
      const failure = stub.slotErrors?.[slot];
      if (failure) throw failure;
      return stub.slots?.[slot] ?? ZERO_WORD;
    },
  } as unknown as JsonRpcProvider;
  return { provider, reads };
}

function proxyEntry(implementation?: string, proxyName = "OssifiableProxy"): ContractEntry {
  return {
    address: PROXY_ADDRESS,
    checks: {},
    implementation,
    implementationChecks: {},
    name: "Lido",
    proxyName,
  } as ContractEntry;
}

function regularEntry(): ContractEntry {
  return { address: PROXY_ADDRESS, checks: {}, name: "Lido" } as ContractEntry;
}

// storage: pins in the configs hold the singleton as a plain address, the way anchors keep it
function safePinnedEntry(singleton: string): ContractEntry {
  return {
    ...proxyEntry(undefined, "SafeProxy"),
    storage: [{ slot: ZERO_WORD, expected: singleton, label: "singleton" }],
  } as ContractEntry;
}

function adminOwnerEntry(proxyAdminOwner?: string): ContractEntry {
  return { ...proxyEntry(IMPL_ADDRESS), proxyAdminOwner } as ContractEntry;
}

function adminEntry(fields: { proxyAdmin?: string; proxyAdminOwner?: string }): ContractEntry {
  return { ...proxyEntry(IMPL_ADDRESS), ...fields } as ContractEntry;
}

const originalWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  resetStats();
  resetContractCounters();
  context.skipImplementationCheck = false;
  context.checkOnly = null;
  context.quiet = false;
  // failures print regardless of --quiet; keep the test output readable
  process.stdout.write = (() => true) as typeof process.stdout.write;
});

function captureOutput(): { output: () => string } {
  let captured = "";
  process.stdout.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stdout.write;
  return { output: () => captured };
}

afterEach(() => {
  process.stdout.write = originalWrite;
});

describe("checkImplementation", () => {
  it("passes when the EIP-1967 slot holds the declared implementation", async () => {
    const { provider, reads } = stubProvider({ slots: { [EIP1967_SLOT]: word(IMPL_ADDRESS) } });

    await checkImplementation(provider, proxyEntry(IMPL_ADDRESS));

    assert.equal(stats.errors, 0);
    assert.equal(stats.totalChecks, 1);
    assert.deepEqual(reads, [`slot:${EIP1967_SLOT}`]);
  });

  it("leaves an implementation slot already pinned in storage to the storage validator", async () => {
    const { provider, reads } = stubProvider({ slots: { [EIP1967_SLOT]: word(IMPL_ADDRESS) } });
    const entry = {
      ...proxyEntry(IMPL_ADDRESS),
      storage: [{ expected: IMPL_ADDRESS, label: "implementation", slot: EIP1967_SLOT }],
    } as ContractEntry;

    await checkImplementation(provider, entry);

    assert.equal(stats.errors, 0);
    assert.equal(stats.totalChecks, 0);
    assert.deepEqual(reads, []);
  });

  it("reports the on-chain and the expected implementation when they differ", async () => {
    const { provider } = stubProvider({ slots: { [EIP1967_SLOT]: word(OTHER_IMPL_ADDRESS) } });

    await checkImplementation(provider, proxyEntry(IMPL_ADDRESS));

    assert.equal(stats.errors, 1);
    const { message } = stats.errorDetails[0];
    assert.match(message, new RegExp(OTHER_IMPL_ADDRESS, "i"));
    assert.match(message, new RegExp(IMPL_ADDRESS, "i"));
    assert.match(message, /--skip-implementation-check/);
  });

  it("falls back to implementation() for proxies that leave the EIP-1967 slot empty", async () => {
    const { provider, reads } = stubProvider({ callResult: word(IMPL_ADDRESS) });

    await checkImplementation(provider, proxyEntry(IMPL_ADDRESS));

    assert.equal(stats.errors, 0);
    assert.deepEqual(reads, [`slot:${EIP1967_SLOT}`, `call:${PROXY_ADDRESS.toLowerCase()}`]);
  });

  it("reads only the singleton slot for a Safe, skipping the getters a Safe never answers", async () => {
    const { provider, reads } = stubProvider({
      callResult: new Error("execution reverted"),
      slots: { [SAFE_SLOT]: word(IMPL_ADDRESS) },
    });

    await checkImplementation(provider, proxyEntry(IMPL_ADDRESS, "SafeProxy"));

    assert.equal(stats.errors, 0);
    // one read total: reverting getter calls and the EIP-1967 slot say nothing about a Safe
    assert.deepEqual(reads, [`slot:${SAFE_SLOT}`]);
  });

  it("judges a Safe by slot 0 even when the EIP-1967 slot shows the expected address", async () => {
    // a SafeProxy delegates to slot 0; an EIP-1967 slot that happens to agree with the config
    // must not vouch for it
    const { provider } = stubProvider({
      slots: { [EIP1967_SLOT]: word(IMPL_ADDRESS), [SAFE_SLOT]: word(OTHER_IMPL_ADDRESS) },
    });

    await checkImplementation(provider, proxyEntry(IMPL_ADDRESS, "SafeProxy"));

    assert.equal(stats.errors, 1);
    assert.match(stats.errorDetails[0].message, new RegExp(OTHER_IMPL_ADDRESS, "i"));
  });

  it("does not judge a non-Safe proxy by its first storage slot", async () => {
    // slot 0 of an arbitrary proxy holds whatever the implementation keeps there; an
    // address-shaped value must not fail the check
    const { provider, reads } = stubProvider({
      callResult: new Error("execution reverted"),
      slots: { [SAFE_SLOT]: word(OTHER_IMPL_ADDRESS) },
    });

    await checkImplementation(provider, proxyEntry(IMPL_ADDRESS));

    // the entry still fails as unresolved, but never on the garbage slot 0 holds
    assert.equal(stats.errors, 1);
    assert.doesNotMatch(stats.errorDetails[0].message, new RegExp(OTHER_IMPL_ADDRESS, "i"));
    assert.ok(!reads.includes(`slot:${SAFE_SLOT}`), `slot 0 was read: ${reads.join(", ")}`);
  });

  it("fails when no resolution step yields an address", async () => {
    // a persistent RPC failure must not let the run finish green; the bypass flag is the
    // deliberate way out
    const { provider } = stubProvider({ callResult: new Error("execution reverted") });

    await checkImplementation(provider, proxyEntry(IMPL_ADDRESS));

    assert.equal(stats.errors, 1);
    assert.equal(stats.totalChecks, 1);
    assert.match(stats.errorDetails[0].message, /--skip-implementation-check/);
  });

  it("resolves through proxy__getImplementation before giving up", async () => {
    const { provider } = stubProvider({
      callResult: new Error("execution reverted"),
      selectors: { "0xad729a71": word(IMPL_ADDRESS) },
    });

    await checkImplementation(provider, proxyEntry(IMPL_ADDRESS));

    assert.equal(stats.errors, 0);
    assert.equal(stats.totalChecks, 1);
  });

  it("prints the pins-no-implementation warning even under --quiet", async () => {
    const { provider } = stubProvider({
      callResult: new Error("execution reverted"),
      slots: { [SAFE_SLOT]: word(IMPL_ADDRESS) },
    });
    context.quiet = true;
    const captured = captureOutput();

    await checkImplementation(provider, safePinnedEntry(IMPL_ADDRESS));

    assert.match(captured.output(), /pins no implementation/);
  });

  it("fails when the Safe singleton slot cannot be read for an undeclared entry", async () => {
    const { provider } = stubProvider({
      callResult: new Error("execution reverted"),
      slotErrors: { [SAFE_SLOT]: new Error("rate limited") },
    });

    await checkImplementation(provider, proxyEntry(undefined, "SafeProxy"));

    assert.equal(stats.errors, 1);
  });

  it("warns instead of failing when a storage check pins slot 0 to the same singleton", async () => {
    const { provider } = stubProvider({ slots: { [SAFE_SLOT]: word(IMPL_ADDRESS) } });
    const captured = captureOutput();

    await checkImplementation(provider, safePinnedEntry(IMPL_ADDRESS));

    assert.equal(stats.errors, 0);
    assert.match(captured.output(), /pins no implementation/);
    assert.doesNotMatch(captured.output(), /not a proxy/);
  });

  it("fails a Safe that pins its singleton neither as implementation nor in storage", async () => {
    // an unpinned delegation is unverified; the warning is reserved for entries that assert
    // slot 0 through a storage: check
    const { provider } = stubProvider({ slots: { [SAFE_SLOT]: word(IMPL_ADDRESS) } });

    await checkImplementation(provider, proxyEntry(undefined, "SafeProxy"));

    assert.equal(stats.errors, 1);
    const { message } = stats.errorDetails[0];
    assert.match(message, new RegExp(IMPL_ADDRESS, "i"));
    assert.match(message, /pins no implementation/);
  });

  it("accepts a slot-0 pin written as a short slot and a full mixed-case word", async () => {
    // the schema lets the slot be "0" and the pin be a 32-byte word in any case; the comparison
    // is numeric, so notation must not fail a matching pin or crash on a checksum
    const entry = {
      ...proxyEntry(undefined, "SafeProxy"),
      storage: [{ slot: "0", expected: `0x${"0".repeat(24)}${IMPL_ADDRESS.slice(2)}`, label: "singleton" }],
    } as ContractEntry;
    const { provider } = stubProvider({ slots: { [SAFE_SLOT]: word(IMPL_ADDRESS) } });

    await checkImplementation(provider, entry);

    assert.equal(stats.errors, 0);
  });

  it("fails a Safe whose slot-0 storage pin disagrees with the chain", async () => {
    const { provider } = stubProvider({ slots: { [SAFE_SLOT]: word(OTHER_IMPL_ADDRESS) } });

    await checkImplementation(provider, safePinnedEntry(IMPL_ADDRESS));

    assert.equal(stats.errors, 1);
  });

  it("fails when a contract described as regular delegates to an implementation", async () => {
    const { provider } = stubProvider({ slots: { [EIP1967_SLOT]: word(IMPL_ADDRESS) } });

    await checkImplementation(provider, regularEntry());

    assert.equal(stats.errors, 1);
    const { message } = stats.errorDetails[0];
    assert.match(message, new RegExp(IMPL_ADDRESS, "i"));
    assert.match(message, /proxyName/);
    assert.match(message, /--skip-implementation-check/);
  });

  it("tells a proxy entry that pins no implementation to add the field", async () => {
    const { provider } = stubProvider({ slots: { [EIP1967_SLOT]: word(IMPL_ADDRESS) } });

    await checkImplementation(provider, proxyEntry());

    assert.equal(stats.errors, 1);
    const { message } = stats.errorDetails[0];
    assert.match(message, /implementation/);
    // proxyName is already in the config, the message must not ask for it again
    assert.doesNotMatch(message, /proxyName/);
  });

  it("fails a regular entry whose implementation slot cannot be read", async () => {
    const failingProvider = {
      async call() {
        throw new Error("rate limited");
      },
      async getStorage() {
        throw new Error("rate limited");
      },
    } as unknown as JsonRpcProvider;

    await checkImplementation(failingProvider, regularEntry());

    assert.equal(stats.errors, 1);
    assert.match(stats.errorDetails[0].message, /--skip-implementation-check/);
  });

  it("accepts a regular contract that holds no implementation", async () => {
    const { provider, reads } = stubProvider({ slots: { [SAFE_SLOT]: word(IMPL_ADDRESS) } });

    await checkImplementation(provider, regularEntry());

    assert.equal(stats.errors, 0);
    // the first slot of a regular contract is an ordinary variable, it must not be read
    assert.deepEqual(reads, [`slot:${EIP1967_SLOT}`]);
  });

  it("fails a declared proxy that pins no implementation and answers no getter", async () => {
    // proxyName in the config is a promise; passing the entry as "not a proxy" would contradict it
    const { provider } = stubProvider({ callResult: new Error("execution reverted") });

    await checkImplementation(provider, proxyEntry());

    assert.equal(stats.errors, 1);
    const { message } = stats.errorDetails[0];
    assert.match(message, /OssifiableProxy/);
    assert.match(message, /--skip-implementation-check/);
  });

  it("names the implementation a getter reveals when the config pins none", async () => {
    const { provider } = stubProvider({
      callResult: new Error("execution reverted"),
      selectors: { "0xad729a71": word(IMPL_ADDRESS) },
    });

    await checkImplementation(provider, proxyEntry());

    assert.equal(stats.errors, 1);
    const { message } = stats.errorDetails[0];
    assert.match(message, new RegExp(IMPL_ADDRESS, "i"));
    assert.match(message, /pins no implementation/);
  });

  it("touches the chain for nothing but counts the skip when --skip-implementation-check is set", async () => {
    const { provider, reads } = stubProvider({ slots: { [EIP1967_SLOT]: word(OTHER_IMPL_ADDRESS) } });
    context.skipImplementationCheck = true;
    const { output } = captureOutput();

    await checkImplementation(provider, proxyEntry(IMPL_ADDRESS));

    assert.deepEqual(reads, []);
    assert.equal(stats.errors, 0);
    assert.equal(stats.totalChecks, 0);
    assert.equal(stats.skipped, 1);
    assert.match(output(), /implementation.*skipped/);
  });

  it("stays out of a run narrowed to a single checks type", async () => {
    const { provider, reads } = stubProvider({ slots: { [EIP1967_SLOT]: word(OTHER_IMPL_ADDRESS) } });
    context.checkOnly = { checksType: "checks", section: "l1" };

    await checkImplementation(provider, proxyEntry(IMPL_ADDRESS));

    assert.deepEqual(reads, []);
    assert.equal(stats.errors, 0);
    assert.equal(stats.skipped, 0);
  });
});

describe("checkProxyAdmin", () => {
  it("passes when the ProxyAdmin behind the proxy is owned by the expected address", async () => {
    const { provider, reads } = stubProvider({
      calls: { [PROXY_ADMIN_ADDRESS.toLowerCase()]: word(OWNER_ADDRESS) },
      slots: { [ADMIN_SLOT]: word(PROXY_ADMIN_ADDRESS) },
    });

    await checkProxyAdmin(provider, adminOwnerEntry(OWNER_ADDRESS));

    assert.equal(stats.errors, 0);
    assert.equal(stats.totalChecks, 1);
    assert.deepEqual(reads, [`slot:${ADMIN_SLOT}`, `call:${PROXY_ADMIN_ADDRESS.toLowerCase()}`]);
  });

  it("names the admin, its owner and the expectation when they differ", async () => {
    const { provider } = stubProvider({
      calls: { [PROXY_ADMIN_ADDRESS.toLowerCase()]: word(OTHER_IMPL_ADDRESS) },
      slots: { [ADMIN_SLOT]: word(PROXY_ADMIN_ADDRESS) },
    });

    await checkProxyAdmin(provider, adminOwnerEntry(OWNER_ADDRESS));

    assert.equal(stats.errors, 1);
    const { message } = stats.errorDetails[0];
    assert.match(message, new RegExp(PROXY_ADMIN_ADDRESS, "i"));
    assert.match(message, new RegExp(OTHER_IMPL_ADDRESS, "i"));
    assert.match(message, new RegExp(OWNER_ADDRESS, "i"));
  });

  it("fails when the proxy keeps no admin in the EIP-1967 slot", async () => {
    const { provider } = stubProvider({});

    await checkProxyAdmin(provider, adminOwnerEntry(OWNER_ADDRESS));

    assert.equal(stats.errors, 1);
    assert.match(stats.errorDetails[0].message, /no admin in the EIP-1967 slot/);
  });

  it("separates an unreadable admin slot from a proxy that keeps no admin", async () => {
    const { provider } = stubProvider({ slotErrors: { [ADMIN_SLOT]: new Error("missing revert data") } });

    await checkProxyAdmin(provider, adminOwnerEntry(OWNER_ADDRESS));

    assert.equal(stats.errors, 1);
    const { message } = stats.errorDetails[0];
    assert.match(message, /could not be read/);
    assert.doesNotMatch(message, /no admin in the EIP-1967 slot/);
  });

  it("points at the admin pin when the admin does not answer owner()", async () => {
    const { provider } = stubProvider({
      calls: { [PROXY_ADMIN_ADDRESS.toLowerCase()]: new Error("execution reverted") },
      slots: { [ADMIN_SLOT]: word(PROXY_ADMIN_ADDRESS) },
    });

    await checkProxyAdmin(provider, adminOwnerEntry(OWNER_ADDRESS));

    assert.equal(stats.errors, 1);
    const { message } = stats.errorDetails[0];
    assert.match(message, /does not answer owner\(\)/);
    assert.match(message, /proxyAdmin:/);
  });

  it("accepts a renounced ProxyAdmin when the config expects the zero owner", async () => {
    const { provider } = stubProvider({
      calls: { [PROXY_ADMIN_ADDRESS.toLowerCase()]: ZERO_WORD },
      slots: { [ADMIN_SLOT]: word(PROXY_ADMIN_ADDRESS) },
    });

    await checkProxyAdmin(provider, adminOwnerEntry(`0x${"0".repeat(40)}`));

    assert.equal(stats.errors, 0);
  });

  it("reports the zero owner instead of claiming the admin does not answer", async () => {
    const { provider } = stubProvider({
      calls: { [PROXY_ADMIN_ADDRESS.toLowerCase()]: ZERO_WORD },
      slots: { [ADMIN_SLOT]: word(PROXY_ADMIN_ADDRESS) },
    });

    await checkProxyAdmin(provider, adminOwnerEntry(OWNER_ADDRESS));

    assert.equal(stats.errors, 1);
    const { message } = stats.errorDetails[0];
    assert.match(message, new RegExp(`0x${"0".repeat(40)}`));
    assert.doesNotMatch(message, /does not answer/);
  });

  it("keeps running when the run is narrowed to one checks type", async () => {
    const { provider } = stubProvider({
      calls: { [PROXY_ADMIN_ADDRESS.toLowerCase()]: word(OWNER_ADDRESS) },
      slots: { [ADMIN_SLOT]: word(PROXY_ADMIN_ADDRESS) },
    });
    context.checkOnly = { section: "l1", checksType: "checks" };

    await checkProxyAdmin(provider, adminOwnerEntry(OWNER_ADDRESS));

    assert.equal(stats.totalChecks, 1);
    assert.equal(stats.errors, 0);
  });

  it("reads nothing for an entry without the field", async () => {
    const { provider, reads } = stubProvider({ slots: { [ADMIN_SLOT]: word(PROXY_ADMIN_ADDRESS) } });

    await checkProxyAdmin(provider, adminOwnerEntry());

    assert.deepEqual(reads, []);
    assert.equal(stats.totalChecks, 0);
  });

  it("passes when the EIP-1967 admin slot holds the declared ProxyAdmin", async () => {
    const { provider, reads } = stubProvider({ slots: { [ADMIN_SLOT]: word(PROXY_ADMIN_ADDRESS) } });

    await checkProxyAdmin(provider, adminEntry({ proxyAdmin: PROXY_ADMIN_ADDRESS }));

    assert.equal(stats.errors, 0);
    assert.equal(stats.totalChecks, 1);
    // no owner() call: pinning the admin address asks nothing about who controls it
    assert.deepEqual(reads, [`slot:${ADMIN_SLOT}`]);
  });

  it("names the administering contract and the expectation when they differ", async () => {
    const { provider } = stubProvider({ slots: { [ADMIN_SLOT]: word(OTHER_ADMIN_ADDRESS) } });

    await checkProxyAdmin(provider, adminEntry({ proxyAdmin: PROXY_ADMIN_ADDRESS }));

    assert.equal(stats.errors, 1);
    const { message } = stats.errorDetails[0];
    assert.match(message, new RegExp(OTHER_ADMIN_ADDRESS, "i"));
    assert.match(message, new RegExp(PROXY_ADMIN_ADDRESS, "i"));
  });

  it("fails the admin pin when the slot holds no address", async () => {
    const { provider } = stubProvider({});

    await checkProxyAdmin(provider, adminEntry({ proxyAdmin: PROXY_ADMIN_ADDRESS }));

    assert.equal(stats.errors, 1);
    assert.match(stats.errorDetails[0].message, /no admin in the EIP-1967 slot/);
  });

  it("catches an unexpected ProxyAdmin that answers the expected owner", async () => {
    const { provider } = stubProvider({
      calls: { [OTHER_ADMIN_ADDRESS.toLowerCase()]: word(OWNER_ADDRESS) },
      slots: { [ADMIN_SLOT]: word(OTHER_ADMIN_ADDRESS) },
    });

    await checkProxyAdmin(provider, adminEntry({ proxyAdmin: PROXY_ADMIN_ADDRESS, proxyAdminOwner: OWNER_ADDRESS }));

    assert.equal(stats.totalChecks, 2);
    assert.equal(stats.errors, 1);
    assert.equal(stats.errorDetails[0].checksType, "proxyAdmin");
  });

  it("reads the admin slot once for both fields", async () => {
    const { provider, reads } = stubProvider({
      calls: { [PROXY_ADMIN_ADDRESS.toLowerCase()]: word(OWNER_ADDRESS) },
      slots: { [ADMIN_SLOT]: word(PROXY_ADMIN_ADDRESS) },
    });

    await checkProxyAdmin(provider, adminEntry({ proxyAdmin: PROXY_ADMIN_ADDRESS, proxyAdminOwner: OWNER_ADDRESS }));

    assert.equal(stats.totalChecks, 2);
    assert.equal(stats.errors, 0);
    assert.deepEqual(reads, [`slot:${ADMIN_SLOT}`, `call:${PROXY_ADMIN_ADDRESS.toLowerCase()}`]);
  });

  it("reports an unreadable admin slot against every declared field", async () => {
    const { provider } = stubProvider({ slotErrors: { [ADMIN_SLOT]: new Error("missing revert data") } });

    await checkProxyAdmin(provider, adminEntry({ proxyAdmin: PROXY_ADMIN_ADDRESS, proxyAdminOwner: OWNER_ADDRESS }));

    assert.equal(stats.errors, 2);
    for (const detail of stats.errorDetails) assert.match(detail.message, /could not be read/);
  });
});
