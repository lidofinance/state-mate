import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

import type { JsonRpcProvider } from "ethers";

import { normalizeChainId } from "../src/common";
import { context, resetStats, stats } from "../src/context";
import {
  assertProviderChain,
  loadContractInfo,
  reserveRequestSlot,
  resetRequestSlots,
  verifyChainIdWithExplorer,
  withTransientRetry,
} from "../src/explorer";
import { CheckLevel, incChecks, incErrors, needCheck, setErrorContext } from "../src/section-validators/base";
import { ExplorerSectionTB, isTypeOfTB } from "../src/typebox";

class ExitSignal extends Error {}

// logErrorAndExit calls process.exit; turn it into a catchable signal and capture the message
async function captureExit(callback: () => Promise<unknown>): Promise<string | undefined> {
  const originalExit = process.exit;
  const originalError = console.error;
  const originalTrace = console.trace;
  let message: string | undefined;
  console.error = (...parts: unknown[]) => {
    message = (message ?? "") + parts.map(String).join(" ");
  };
  console.trace = () => {};
  process.exit = (() => {
    throw new ExitSignal();
  }) as typeof process.exit;
  try {
    await callback();
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
    return message ?? "";
  } finally {
    process.exit = originalExit;
    console.error = originalError;
    console.trace = originalTrace;
  }
  return undefined;
}

function mockExplorerResponse(body: unknown) {
  return mock.method(globalThis, "fetch", async () => {
    return { ok: true, json: async () => body } as Response;
  });
}

describe("verifyChainIdWithExplorer", () => {
  it("refuses to run when the explorer reports a different chain", async () => {
    const fetchMock = mockExplorerResponse({ jsonrpc: "2.0", id: 83, result: "0x38" });
    try {
      const message = await captureExit(() => verifyChainIdWithExplorer("api.bscscan.com", "1"));
      assert.notEqual(message, undefined);
      assert.match(message as string, /does not match/);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("passes when the explorer confirms the configured chain", async () => {
    const fetchMock = mockExplorerResponse({ jsonrpc: "2.0", id: 83, result: "0x38" });
    try {
      const message = await captureExit(() => verifyChainIdWithExplorer("api.bscscan.com", "56"));
      assert.equal(message, undefined);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("warns but continues when the explorer cannot answer", async () => {
    const fetchMock = mockExplorerResponse({ status: "0", message: "NOTOK", result: "Invalid API URL" });
    try {
      const message = await captureExit(() => verifyChainIdWithExplorer("api.bscscan.com", "56"));
      assert.equal(message, undefined);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("skips the probe for etherscan hosts, where chainId is a request parameter", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("no probe expected");
    });
    try {
      const message = await captureExit(() => verifyChainIdWithExplorer("api.etherscan.io", "8453"));
      assert.equal(message, undefined);
      assert.equal(fetchMock.mock.calls.length, 0);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("asks the explorer once per host and chain, later sections reuse the answer", async () => {
    const fetchMock = mockExplorerResponse({ jsonrpc: "2.0", id: 83, result: "0x61" });
    try {
      await captureExit(() => verifyChainIdWithExplorer("api.testnet.bscscan.com", "97"));
      const callsAfterFirst = fetchMock.mock.calls.length;
      await captureExit(() => verifyChainIdWithExplorer("api.testnet.bscscan.com", "97"));
      assert.ok(callsAfterFirst > 0);
      assert.equal(fetchMock.mock.calls.length, callsAfterFirst);
    } finally {
      fetchMock.mock.restore();
    }
  });
});

describe("assertProviderChain", () => {
  const providerOn = (chainId: bigint) => ({ getNetwork: async () => ({ chainId }) }) as unknown as JsonRpcProvider;

  it("refuses to run checks against an RPC serving a different chain", async () => {
    const message = await captureExit(() => assertProviderChain(providerOn(56n), "1"));
    assert.notEqual(message, undefined);
    assert.match(message as string, /56/);
    assert.match(message as string, /RPC/i);
  });

  it("passes when the RPC serves the configured chain", async () => {
    const message = await captureExit(() => assertProviderChain(providerOn(56n), "56"));
    assert.equal(message, undefined);
  });
});

describe("withTransientRetry", () => {
  it("retries once after a transient RPC failure", async () => {
    let calls = 0;
    const result = await withTransientRetry(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("server response 503"), { code: "SERVER_ERROR" });
      return "ok";
    }, 0);
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });

  it("does not mask a real revert as a flake", async () => {
    let calls = 0;
    await assert.rejects(
      withTransientRetry(async () => {
        calls++;
        throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" });
      }, 0),
      /execution reverted/,
    );
    assert.equal(calls, 1);
  });
});

describe("chainId is required by the schema", () => {
  const section = { rpcUrl: "SOME_RPC_URL", explorerHostname: "api.etherscan.io" };

  it("rejects a section without chainId", () => {
    assert.equal(isTypeOfTB(section, ExplorerSectionTB), false);
  });

  it("accepts the same section once chainId is pinned", () => {
    assert.equal(isTypeOfTB({ ...section, chainId: 1 }, ExplorerSectionTB), true);
  });

  it("rejects chain ids that are not positive integers", () => {
    assert.equal(isTypeOfTB({ ...section, chainId: -1 }, ExplorerSectionTB), false);
    assert.equal(isTypeOfTB({ ...section, chainId: " " }, ExplorerSectionTB), false);
    assert.equal(isTypeOfTB({ ...section, chainId: "0x1" }, ExplorerSectionTB), false);
    assert.equal(isTypeOfTB({ ...section, chainId: "56" }, ExplorerSectionTB), true);
  });
});

describe("normalizeChainId", () => {
  it("refuses garbage instead of normalizing it to a wrong chain", async () => {
    for (const garbage of [" ", "-1", "1.5", "0x1"]) {
      const message = await captureExit(async () => normalizeChainId(garbage));
      assert.notEqual(message, undefined, `expected exit for ${JSON.stringify(garbage)}`);
    }
    assert.equal(normalizeChainId(56), "56");
    assert.equal(normalizeChainId("97"), "97");
  });
});

describe("stats between configs (directory mode)", () => {
  it("resetStats clears errors accumulated by a previous config", () => {
    setErrorContext({ section: "l1", contract: "lido" });
    incChecks();
    incErrors("boom");
    assert.equal(stats.errors > 0, true);
    assert.equal(stats.errorDetails.length > 0, true);

    resetStats();

    assert.deepEqual(
      { totalChecks: stats.totalChecks, errors: stats.errors, details: stats.errorDetails.length },
      { totalChecks: 0, errors: 0, details: 0 },
    );
  });

  it("-o filter skips sections that do not match", () => {
    context.checkOnly = { section: "l1" };
    try {
      assert.equal(needCheck(CheckLevel.section, "l1"), true);
      assert.equal(needCheck(CheckLevel.section, "l2"), false);
      assert.equal(needCheck(CheckLevel.contract, "anything"), true);
    } finally {
      context.checkOnly = null;
    }
    assert.equal(needCheck(CheckLevel.section, "l2"), true);
  });
});

describe("explorer request pacing", () => {
  // earlier tests in this file already booked slots against the real clock
  beforeEach(() => resetRequestSlots());

  it("spaces requests to stay under three per second", () => {
    const now = 1_000_000;
    assert.equal(reserveRequestSlot(now), 0);
    assert.equal(reserveRequestSlot(now), 334);
    assert.equal(reserveRequestSlot(now), 668);
  });

  it("does not delay a request that arrives after its slot", () => {
    const now = 1_000_000;
    reserveRequestSlot(now);
    assert.equal(reserveRequestSlot(now + 5000), 0);
  });
});

describe("loadContractInfo", () => {
  beforeEach(() => resetRequestSlots());

  const ADDRESS = "0xAaAaAAaaAaAAAaaAAaAaaaAAaAAAaaaAaaaaaaa1";
  const ABI = [{ type: "function", name: "getFee", inputs: [], stateMutability: "view" }];

  it("terminates when the explorer reports an implementation cycle", async () => {
    // a proxy whose implementation points back at itself must not loop forever
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      return {
        ok: true,
        json: async () => ({
          status: "1",
          message: "OK",
          result: [{ ABI: JSON.stringify(ABI), ContractName: "Loop", Implementation: ADDRESS }],
        }),
      } as Response;
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const info = await Promise.race([
        loadContractInfo(ADDRESS, "api.etherscan.io", "", 1),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("did not terminate")), 1500);
        }),
      ]);
      assert.equal(info?.contractName, "Loop");
    } finally {
      if (timer) clearTimeout(timer);
      fetchMock.mock.restore();
    }
  });

  it("retries once after an HTTP 429 instead of skipping the address", async () => {
    let calls = 0;
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 429, statusText: "Too Many Requests" } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          status: "1",
          message: "OK",
          result: [{ ABI: JSON.stringify(ABI), ContractName: "Lido" }],
        }),
      } as Response;
    });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pending = loadContractInfo(ADDRESS, "api.etherscan.io", "", 1);
      // fire the retry back-off and the paced request slots as they get scheduled
      for (let round = 0; round < 8; round++) {
        await new Promise((resolve) => setImmediate(resolve));
        mock.timers.tick(7000);
      }
      const info = await pending;
      assert.equal(info?.contractName, "Lido");
      assert.equal(calls, 2);
    } finally {
      mock.timers.reset();
      fetchMock.mock.restore();
    }
  });
});
