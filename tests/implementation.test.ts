import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { JsonRpcProvider } from "ethers";

import { context, resetStats, stats } from "../src/context";
import { resetContractCounters } from "../src/section-validators/base";
import { checkImplementation, checkProxyAdminOwner } from "../src/section-validators/implementation";
import { ContractEntry } from "../src/typebox";

const PROXY_ADDRESS = "0xAaAaAAaaAaAAAaaAAaAaaaAAaAAAaaaAaaaaaaa1";
const IMPL_ADDRESS = "0xBbbBBBbbbBBbbbBbbBbbbbBBbBBbbBbBbbbbbbb2";
const OTHER_IMPL_ADDRESS = "0xcCCcccCcCCcCcCCCcCcccCcCcCcCcCCcCcccCcC3";
const PROXY_ADMIN_ADDRESS = "0xDdDDDddDdDddDDddDDddDDDDdDdDDdDDdDDDDDD4";
const OWNER_ADDRESS = "0xEeeEEEeeeEEEeeeEEEeeeeEeeeeEEEEeeEEeEeE5";
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
  slots?: Record<string, string>;
};

/** Records every read so that the tests can assert which resolution steps ran. */
function stubProvider(stub: ProviderStub): { provider: JsonRpcProvider; reads: string[] } {
  const reads: string[] = [];
  const provider = {
    async call({ to }: { to: string }) {
      reads.push(`call:${to.toLowerCase()}`);
      const answer = stub.calls?.[to.toLowerCase()] ?? stub.callResult;
      if (answer instanceof Error) throw answer;
      return answer ?? ZERO_WORD;
    },
    async getStorage(address: string, slot: string) {
      reads.push(`slot:${slot}`);
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

function adminOwnerEntry(proxyAdminOwner?: string): ContractEntry {
  return { ...proxyEntry(IMPL_ADDRESS), proxyAdminOwner } as ContractEntry;
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

  it("falls back to the first storage slot for a Safe when implementation() reverts", async () => {
    const { provider, reads } = stubProvider({
      callResult: new Error("execution reverted"),
      slots: { [SAFE_SLOT]: word(IMPL_ADDRESS) },
    });

    await checkImplementation(provider, proxyEntry(IMPL_ADDRESS, "SafeProxy"));

    assert.equal(stats.errors, 0);
    assert.deepEqual(reads, [`slot:${EIP1967_SLOT}`, `call:${PROXY_ADDRESS.toLowerCase()}`, `slot:${SAFE_SLOT}`]);
  });

  it("does not judge a non-Safe proxy by its first storage slot", async () => {
    // slot 0 of an arbitrary proxy holds whatever the implementation keeps there; an
    // address-shaped value must not fail the check
    const { provider, reads } = stubProvider({
      callResult: new Error("execution reverted"),
      slots: { [SAFE_SLOT]: word(OTHER_IMPL_ADDRESS) },
    });

    await checkImplementation(provider, proxyEntry(IMPL_ADDRESS));

    assert.equal(stats.errors, 0);
    assert.ok(!reads.includes(`slot:${SAFE_SLOT}`), `slot 0 was read: ${reads.join(", ")}`);
  });

  it("warns instead of failing when no resolution step yields an address", async () => {
    const { provider } = stubProvider({ callResult: new Error("execution reverted") });

    await checkImplementation(provider, proxyEntry(IMPL_ADDRESS));

    assert.equal(stats.errors, 0);
  });

  it("does not count an unreadable implementation as a passed check", async () => {
    const { provider } = stubProvider({ callResult: new Error("execution reverted") });

    await checkImplementation(provider, proxyEntry(IMPL_ADDRESS));

    // an inconclusive read is a skip, not a pass: the totals must not claim it was verified
    assert.equal(stats.totalChecks, 0);
    assert.equal(stats.errors, 0);
  });

  it("prints the skip warning even under --quiet", async () => {
    const { provider } = stubProvider({ callResult: new Error("execution reverted") });
    context.quiet = true;
    const captured = captureOutput();

    await checkImplementation(provider, proxyEntry(IMPL_ADDRESS));

    assert.match(captured.output(), /could not be read/);
  });

  it("warns that a Safe entry pins no implementation instead of calling it not a proxy", async () => {
    const { provider } = stubProvider({
      callResult: new Error("execution reverted"),
      slots: { [SAFE_SLOT]: word(IMPL_ADDRESS) },
    });
    const captured = captureOutput();

    await checkImplementation(provider, proxyEntry(undefined, "SafeProxy"));

    assert.equal(stats.errors, 0);
    assert.match(captured.output(), /pins no implementation/);
    assert.doesNotMatch(captured.output(), /not a proxy/);
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

  it("reports a failed slot read on a regular entry instead of confirming it is not a proxy", async () => {
    const failingProvider = {
      async call() {
        throw new Error("rate limited");
      },
      async getStorage() {
        throw new Error("rate limited");
      },
    } as unknown as JsonRpcProvider;
    let output = "";
    process.stdout.write = ((chunk: string) => {
      output += chunk;
      return true;
    }) as typeof process.stdout.write;

    await checkImplementation(failingProvider, regularEntry());

    assert.equal(stats.errors, 0);
    assert.match(output, /could not be read/);
    assert.doesNotMatch(output, /not a proxy/);
  });

  it("accepts a regular contract that holds no implementation", async () => {
    const { provider, reads } = stubProvider({ slots: { [SAFE_SLOT]: word(IMPL_ADDRESS) } });

    await checkImplementation(provider, regularEntry());

    assert.equal(stats.errors, 0);
    // the first slot of a regular contract is an ordinary variable, it must not be read
    assert.deepEqual(reads, [`slot:${EIP1967_SLOT}`]);
  });

  it("ignores a proxy entry without a declared implementation", async () => {
    const { provider } = stubProvider({ slots: { [SAFE_SLOT]: word(IMPL_ADDRESS) } });

    await checkImplementation(provider, proxyEntry());

    assert.equal(stats.errors, 0);
  });

  it("touches the chain for nothing when --skip-implementation-check is set", async () => {
    const { provider, reads } = stubProvider({ slots: { [EIP1967_SLOT]: word(OTHER_IMPL_ADDRESS) } });
    context.skipImplementationCheck = true;

    await checkImplementation(provider, proxyEntry(IMPL_ADDRESS));

    assert.deepEqual(reads, []);
    assert.equal(stats.errors, 0);
    assert.equal(stats.totalChecks, 0);
  });

  it("stays out of a run narrowed to a single checks type", async () => {
    const { provider, reads } = stubProvider({ slots: { [EIP1967_SLOT]: word(OTHER_IMPL_ADDRESS) } });
    context.checkOnly = { checksType: "checks", section: "l1" };

    await checkImplementation(provider, proxyEntry(IMPL_ADDRESS));

    assert.deepEqual(reads, []);
    assert.equal(stats.errors, 0);
  });
});

describe("checkProxyAdminOwner", () => {
  it("passes when the ProxyAdmin behind the proxy is owned by the expected address", async () => {
    const { provider, reads } = stubProvider({
      calls: { [PROXY_ADMIN_ADDRESS.toLowerCase()]: word(OWNER_ADDRESS) },
      slots: { [ADMIN_SLOT]: word(PROXY_ADMIN_ADDRESS) },
    });

    await checkProxyAdminOwner(provider, adminOwnerEntry(OWNER_ADDRESS));

    assert.equal(stats.errors, 0);
    assert.equal(stats.totalChecks, 1);
    assert.deepEqual(reads, [`slot:${ADMIN_SLOT}`, `call:${PROXY_ADMIN_ADDRESS.toLowerCase()}`]);
  });

  it("names the admin, its owner and the expectation when they differ", async () => {
    const { provider } = stubProvider({
      calls: { [PROXY_ADMIN_ADDRESS.toLowerCase()]: word(OTHER_IMPL_ADDRESS) },
      slots: { [ADMIN_SLOT]: word(PROXY_ADMIN_ADDRESS) },
    });

    await checkProxyAdminOwner(provider, adminOwnerEntry(OWNER_ADDRESS));

    assert.equal(stats.errors, 1);
    const { message } = stats.errorDetails[0];
    assert.match(message, new RegExp(PROXY_ADMIN_ADDRESS, "i"));
    assert.match(message, new RegExp(OTHER_IMPL_ADDRESS, "i"));
    assert.match(message, new RegExp(OWNER_ADDRESS, "i"));
  });

  it("fails when the proxy keeps no admin in the EIP-1967 slot", async () => {
    const { provider } = stubProvider({});

    await checkProxyAdminOwner(provider, adminOwnerEntry(OWNER_ADDRESS));

    assert.equal(stats.errors, 1);
    assert.match(stats.errorDetails[0].message, /no admin in the EIP-1967 slot/);
  });

  it("points at a storage check when the admin does not answer owner()", async () => {
    const { provider } = stubProvider({
      calls: { [PROXY_ADMIN_ADDRESS.toLowerCase()]: new Error("execution reverted") },
      slots: { [ADMIN_SLOT]: word(PROXY_ADMIN_ADDRESS) },
    });

    await checkProxyAdminOwner(provider, adminOwnerEntry(OWNER_ADDRESS));

    assert.equal(stats.errors, 1);
    const { message } = stats.errorDetails[0];
    assert.match(message, /does not answer owner\(\)/);
    assert.match(message, /storage:/);
  });

  it("accepts a renounced ProxyAdmin when the config expects the zero owner", async () => {
    const { provider } = stubProvider({
      calls: { [PROXY_ADMIN_ADDRESS.toLowerCase()]: ZERO_WORD },
      slots: { [ADMIN_SLOT]: word(PROXY_ADMIN_ADDRESS) },
    });

    await checkProxyAdminOwner(provider, adminOwnerEntry(`0x${"0".repeat(40)}`));

    assert.equal(stats.errors, 0);
  });

  it("reports the zero owner instead of claiming the admin does not answer", async () => {
    const { provider } = stubProvider({
      calls: { [PROXY_ADMIN_ADDRESS.toLowerCase()]: ZERO_WORD },
      slots: { [ADMIN_SLOT]: word(PROXY_ADMIN_ADDRESS) },
    });

    await checkProxyAdminOwner(provider, adminOwnerEntry(OWNER_ADDRESS));

    assert.equal(stats.errors, 1);
    const { message } = stats.errorDetails[0];
    assert.match(message, new RegExp(`0x${"0".repeat(40)}`));
    assert.doesNotMatch(message, /does not answer/);
  });

  it("reads nothing for an entry without the field", async () => {
    const { provider, reads } = stubProvider({ slots: { [ADMIN_SLOT]: word(PROXY_ADMIN_ADDRESS) } });

    await checkProxyAdminOwner(provider, adminOwnerEntry());

    assert.deepEqual(reads, []);
    assert.equal(stats.totalChecks, 0);
  });
});
