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

// The explorer failures these tests provoke are meant to warn; capturing the warning both asserts
// it and keeps the raw bytes out of the stdout stream the runner frames its own events on
async function captureLog<T>(callback: () => Promise<T>): Promise<{ lines: string[]; result: T }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...parts: unknown[]) => void lines.push(parts.map(String).join(" "));
  try {
    return { lines, result: await callback() };
  } finally {
    console.log = originalLog;
  }
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
    // a hostname of its own: reusing a host-chain pair a passing test has already verified
    // would hit the memo and prove nothing
    const fetchMock = mockExplorerResponse({ status: "0", message: "NOTOK", result: "Invalid API URL" });
    try {
      const { lines, result: message } = await captureLog(() =>
        captureExit(() => verifyChainIdWithExplorer("api.unanswered.blockscout.example", "56")),
      );
      assert.equal(message, undefined);
      assert.ok(fetchMock.mock.calls.length > 0, "the probe must actually run");
      assert.ok(
        lines.some((line) => line.includes("api.unanswered.blockscout.example")),
        "the unverified chain must be reported",
      );
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
    assert.equal(isTypeOfTB({ ...section, chainId: 0 }, ExplorerSectionTB), false);
    assert.equal(isTypeOfTB({ ...section, chainId: "0" }, ExplorerSectionTB), false);
    assert.equal(isTypeOfTB({ ...section, chainId: " " }, ExplorerSectionTB), false);
    assert.equal(isTypeOfTB({ ...section, chainId: "0x1" }, ExplorerSectionTB), false);
    assert.equal(isTypeOfTB({ ...section, chainId: "56" }, ExplorerSectionTB), true);
  });
});

describe("normalizeChainId", () => {
  it("refuses garbage instead of normalizing it to a wrong chain", async () => {
    for (const garbage of [" ", "-1", "1.5", "0x1", "0", 0]) {
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

  it("does not follow implementation metadata recursively", async () => {
    const IMPL = "0xBbbBBBbbbBBbbbBbbBbbbbBBbBBbbBbBbbbbbbb2";
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      return {
        ok: true,
        json: async () => ({
          status: "1",
          message: "OK",
          result: [{ ABI: JSON.stringify(ABI), ContractName: "Proxy", Implementation: IMPL }],
        }),
      } as Response;
    });
    try {
      const info = await loadContractInfo(ADDRESS, "api.etherscan.io", "", 1);
      assert.equal(info?.contractName, "Proxy");
      assert.equal(fetchMock.mock.calls.length, 1);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("gives a later reference its own attempt after the bounded retry fails", async () => {
    // a later call gets a fresh retry budget after a flaking explorer exhausts the first one
    let calls = 0;
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      calls++;
      if (calls <= 2) {
        return {
          ok: true,
          json: async () => ({ status: "0", message: "NOTOK", result: "something went wrong" }),
        } as Response;
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
    try {
      const skipped = await captureLog(() => loadContractInfo(ADDRESS, "api.etherscan.io", "", 1));
      assert.equal(skipped.result, undefined);
      assert.equal(calls, 2, "the retry is bounded to one extra attempt");
      assert.ok(
        skipped.lines.some((line) => line.includes(ADDRESS)),
        "the skipped address must be named",
      );
      const retried = await captureLog(() => loadContractInfo(ADDRESS, "api.etherscan.io", "", 1));
      assert.equal(retried.result?.contractName, "Lido");
      assert.equal(calls, 3);
      assert.deepEqual(retried.lines, [], "a recovered address must not warn");
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("spends at most two fetches whatever failures the explorer mixes", async () => {
    // transport and application failures share one retry budget; layered retries once turned a
    // rate-limited batch into 8 requests, and a capitalized "Rate limit" into a lost ABI
    const ok = {
      ok: true,
      json: async () => ({ status: "1", message: "OK", result: [{ ABI: JSON.stringify(ABI), ContractName: "Lido" }] }),
    } as Response;
    const notok = (result: string) =>
      ({ ok: true, json: async () => ({ status: "0", message: "NOTOK", result }) }) as Response;
    const scenarios: { answers: (() => Response)[]; name: string; recovers: boolean }[] = [
      {
        name: "network flake, then success",
        answers: [
          () => {
            throw new Error("socket hang up");
          },
          () => ok,
        ],
        recovers: true,
      },
      {
        name: "HTTP 429, then success",
        answers: [() => ({ ok: false, status: 429, statusText: "Too Many Requests" }) as Response, () => ok],
        recovers: true,
      },
      {
        name: "HTTP 408, then success",
        answers: [() => ({ ok: false, status: 408, statusText: "Request Timeout" }) as Response, () => ok],
        recovers: true,
      },
      {
        name: "capitalized rate limit, then success",
        answers: [() => notok("Max Rate limit reached"), () => ok],
        recovers: true,
      },
      {
        name: "malformed body, then success",
        answers: [
          () =>
            ({
              ok: true,
              json: async () => {
                throw new SyntaxError("Unexpected token <");
              },
            }) as unknown as Response,
          () => ok,
        ],
        recovers: true,
      },
      {
        name: "network flake, then rate limit",
        answers: [
          () => {
            throw new Error("socket hang up");
          },
          () => notok("rate limit reached"),
        ],
        recovers: false,
      },
      {
        name: "not verified, then success",
        answers: [() => notok("Contract source code not verified"), () => ok],
        recovers: false,
      },
    ];

    for (const scenario of scenarios) {
      resetRequestSlots();
      let calls = 0;
      const fetchMock = mock.method(globalThis, "fetch", async () => {
        const answer = scenario.answers[Math.min(calls, scenario.answers.length - 1)];
        calls++;
        return answer();
      });
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        const { lines, result: info } = await captureLog(async () => {
          const pending = loadContractInfo(ADDRESS, "api.etherscan.io", "", 1);
          for (let round = 0; round < 8; round++) {
            await new Promise((resolve) => setImmediate(resolve));
            mock.timers.tick(7000);
          }
          return pending;
        });
        assert.ok(calls <= 2, `${scenario.name}: ${calls} fetches`);
        assert.equal(info?.contractName, scenario.recovers ? "Lido" : undefined, scenario.name);
        // every scenario opens with a failure, so silence would mean the warning was lost
        assert.ok(lines.length > 0, scenario.name);
        assert.ok(
          lines.every((line) => line.includes(ADDRESS)),
          scenario.name,
        );
      } finally {
        mock.timers.reset();
        fetchMock.mock.restore();
      }
    }
  });

  it("stops after two requests when the explorer keeps answering 429", async () => {
    // the HTTP layer owns the whole retry budget; the transient-answer retry above it must not
    // multiply attempts during a rate limit
    let calls = 0;
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      calls++;
      return { ok: false, status: 429, statusText: "Too Many Requests" } as Response;
    });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { lines, result } = await captureLog(async () => {
        const pending = loadContractInfo(ADDRESS, "api.etherscan.io", "", 1);
        for (let round = 0; round < 8; round++) {
          await new Promise((resolve) => setImmediate(resolve));
          mock.timers.tick(7000);
        }
        return pending;
      });
      assert.equal(result, undefined);
      assert.equal(calls, 2);
      assert.ok(
        lines.some((line) => line.includes("429")),
        "the rate limit must be reported",
      );
    } finally {
      mock.timers.reset();
      fetchMock.mock.restore();
    }
  });

  it("asks only once about a contract the explorer says is not verified", async () => {
    // "not verified" is a final answer; a second request and a second warning help nobody
    let calls = 0;
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      calls++;
      return {
        ok: true,
        json: async () => ({ status: "0", message: "NOTOK", result: "Contract source code not verified" }),
      } as Response;
    });
    try {
      const { lines, result } = await captureLog(() => loadContractInfo(ADDRESS, "api.etherscan.io", "", 1));
      assert.equal(result, undefined);
      assert.equal(calls, 1);
      assert.equal(lines.length, 1, "one final answer deserves one warning");
    } finally {
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
      const { lines, result: info } = await captureLog(async () => {
        const pending = loadContractInfo(ADDRESS, "api.etherscan.io", "", 1);
        // fire the retry back-off and the paced request slots as they get scheduled
        for (let round = 0; round < 8; round++) {
          await new Promise((resolve) => setImmediate(resolve));
          mock.timers.tick(7000);
        }
        return pending;
      });
      assert.equal(info?.contractName, "Lido");
      assert.equal(calls, 2);
      assert.ok(
        lines.some((line) => line.includes("429")),
        "the retried rate limit must still be reported",
      );
    } finally {
      mock.timers.reset();
      fetchMock.mock.restore();
    }
  });
});
