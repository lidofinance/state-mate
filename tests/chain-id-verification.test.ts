import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { context, resetStats, stats } from "../src/context";
import { verifyChainIdWithExplorer } from "../src/explorer-provider";
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

  it("refuses to run when the chain is paywalled on the free etherscan plan", async () => {
    const fetchMock = mockExplorerResponse({
      status: "0",
      message: "NOTOK",
      result: "Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage.",
    });
    try {
      const message = await captureExit(() => verifyChainIdWithExplorer("api.etherscan.io", "56"));
      assert.notEqual(message, undefined);
      assert.match(message as string, /not covered by the free Etherscan API plan/);
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
});

describe("chainId is required by the schema", () => {
  const section = { rpcUrl: "SOME_RPC_URL", explorerHostname: "api.etherscan.io" };

  it("rejects a section without chainId", () => {
    assert.equal(isTypeOfTB(section, ExplorerSectionTB), false);
  });

  it("accepts the same section once chainId is pinned", () => {
    assert.equal(isTypeOfTB({ ...section, chainId: 1 }, ExplorerSectionTB), true);
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
