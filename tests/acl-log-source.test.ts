import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import type { JsonRpcProvider } from "ethers";

import { ROLE_GRANTED_TOPIC } from "../src/acl/fold";
import {
  CHAIN_LOG_SOURCES,
  collectRoleEvents,
  collectTailLogs,
  collectTailRoleEvents,
  describeSource,
  fetchWindow,
  isRateLimitAnswer,
  makeSettledScanRange,
  parseQuantity,
  resolveScanBounds,
  type ScanRange,
  setRateLimitPause,
} from "../src/acl/log-source";
import { resetRequestSlots } from "../src/explorer";

const CONTRACT = "0xccccccccccccccccccccccccccccccccccccccc3";

describe("explorer quantity parsing", () => {
  // etherscan really does serve the zeroth log index as "0x"; reading it as NaN dropped the log
  // and failed a whole scan on a live Arbitrum contract
  it("reads the empty quantity etherscan uses for zero", () => {
    assert.equal(parseQuantity("0x"), 0);
  });

  it("reads hex, decimal strings and plain numbers", () => {
    assert.deepEqual(
      [parseQuantity("0xf740af7"), parseQuantity("259088105"), parseQuantity(42)],
      [259_263_223, 259_088_105, 42],
    );
  });

  it("rejects what it cannot read rather than guessing a zero", () => {
    assert.deepEqual(
      [parseQuantity("banana"), parseQuantity(null), parseQuantity(-1)],
      [undefined, undefined, undefined],
    );
  });
});

describe("rate-limit detection", () => {
  // measured from etherscan and blockscout; a refusal read as a real answer fails a whole scan
  const LIMITS = [
    { message: "NOTOK", result: "Max calls per sec rate limit reached (3/sec)" },
    { message: "NOTOK", result: "Max rate limit reached, please use API Key for higher rate limit" },
    { message: "Too many requests", result: "" },
  ];

  for (const response of LIMITS) {
    it(`treats "${String(response.result || response.message).slice(0, 38)}" as a pause, not a refusal`, () => {
      assert.equal(isRateLimitAnswer(response), true);
    });
  }

  it("does not mistake a real answer for a rate limit", () => {
    assert.equal(isRateLimitAnswer({ message: "No records found", result: [] as never }), false);
    assert.equal(isRateLimitAnswer({ message: "OK", result: [] as never }), false);
  });

  it("retries an HTTP 429 within the same bounded request budget", async () => {
    let requests = 0;
    setRateLimitPause(0);
    resetRequestSlots();
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      requests++;
      if (requests === 1) return new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
      return Response.json({ message: "No records found", result: "No records found", status: "0" });
    });

    try {
      const outcome = await collectRoleEvents("10", CONTRACT, { fromBlock: 1, toBlock: 2 });
      assert.equal(outcome.ok, true);
      // The grants topic: a 429, then success. Revocations are no longer fetched at all.
      assert.equal(requests, 2);
    } finally {
      fetchMock.mock.restore();
      setRateLimitPause(6000);
      resetRequestSlots();
    }
  });

  it("stops after the bounded budget when HTTP 429 persists", async () => {
    setRateLimitPause(0);
    resetRequestSlots();
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async () => new Response("rate limited", { status: 429, statusText: "Too Many Requests" }),
    );

    try {
      const outcome = await collectRoleEvents("10", CONTRACT, { fromBlock: 1, toBlock: 2 });
      assert.equal(outcome.ok, false);
      assert.equal(fetchMock.mock.calls.length, 4);
    } finally {
      fetchMock.mock.restore();
      setRateLimitPause(6000);
      resetRequestSlots();
    }
  });
});

describe("settled scan range", () => {
  it("accepts a contract deployed at the settled head", () => {
    assert.deepEqual(makeSettledScanRange(100, 100), { fromBlock: 100, toBlock: 100 });
  });

  it("rejects a deployment newer than the settled head before querying logs", () => {
    assert.throws(() => makeSettledScanRange(101, 100), /deployment is not yet settled/);
  });
});

describe("the unsettled tail", () => {
  const ROLE = `0x${"1".repeat(64)}`;
  const padded = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}`;
  const HOLDER = "0x00000000000000000000000000000000deadbeef";
  const grantLog = (blockNumber: number, topic0 = ROLE_GRANTED_TOPIC) => ({
    address: CONTRACT,
    blockNumber,
    data: "0x",
    index: 0,
    topics: [topic0, ROLE, padded(HOLDER), padded(HOLDER)],
  });

  it("captures the head once and settles it by the chain's confirmation lag", async () => {
    const provider = { getBlockNumber: async () => 1000 } as unknown as JsonRpcProvider;
    assert.deepEqual(await resolveScanBounds("1", provider), { captured: 1000, settled: 992 });
  });

  it("asks the RPC for exactly the tail window, with every topic as an alternative", async () => {
    const asked: unknown[] = [];
    const provider = {
      getLogs: async (filter: unknown) => {
        asked.push(filter);
        return [grantLog(996)];
      },
    } as unknown as JsonRpcProvider;

    const logs = await collectTailLogs(provider, CONTRACT, ["0xaa", "0xbb"], { fromBlock: 993, toBlock: 1000 });

    assert.deepEqual(asked, [{ address: CONTRACT, fromBlock: 993, toBlock: 1000, topics: [["0xaa", "0xbb"]] }]);
    // ethers calls the position `index`; the fold expects `logIndex`
    assert.deepEqual(logs, [
      { address: CONTRACT, blockNumber: 996, data: "0x", logIndex: 0, topics: grantLog(996).topics },
    ]);
  });

  it("returns nothing without asking when there is no tail to fetch", async () => {
    const provider = {
      getLogs: async () => {
        throw new Error("must not be called");
      },
    } as unknown as JsonRpcProvider;

    assert.deepEqual(await collectTailLogs(provider, CONTRACT, [ROLE_GRANTED_TOPIC], { fromBlock: 5, toBlock: 4 }), []);
  });

  it("folds a tail grant like any other candidate", async () => {
    const provider = { getLogs: async () => [grantLog(996)] } as unknown as JsonRpcProvider;

    const outcome = await collectTailRoleEvents(provider, CONTRACT, { fromBlock: 993, toBlock: 1000 });

    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.events.length, 1);
      assert.deepEqual(
        { account: outcome.events[0].account, granted: outcome.events[0].granted },
        { account: HOLDER, granted: true },
      );
    }
  });

  it("fails on a tail log it cannot read rather than dropping it", async () => {
    const truncated = { ...grantLog(996), topics: [ROLE_GRANTED_TOPIC, ROLE] };
    const provider = { getLogs: async () => [truncated] } as unknown as JsonRpcProvider;

    const outcome = await collectTailRoleEvents(provider, CONTRACT, { fromBlock: 993, toBlock: 1000 });

    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.reason, /unreadable/);
  });

  it("reports an RPC that will not serve the tail instead of shrinking coverage", async () => {
    const provider = {
      getLogs: async () => {
        throw new Error("free plan says no");
      },
    } as unknown as JsonRpcProvider;

    const outcome = await collectTailRoleEvents(provider, CONTRACT, { fromBlock: 993, toBlock: 1000 });

    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.reason, /would not serve the tail 993-1000/);
  });
});

describe("truncation defence", () => {
  it("returns a short answer without narrowing the window", async () => {
    const asked: ScanRange[] = [];
    const logs = await fetchWindow({ fromBlock: 1, toBlock: 1000 }, 100, async (range) => {
      asked.push(range);
      return [];
    });

    assert.deepEqual(logs, []);
    assert.deepEqual(asked, [{ fromBlock: 1, toBlock: 1000 }]);
  });

  // this is the whole truncation defence now that there is one source, so it has to hold without
  // help from paging: blockscout ignores page/offset and replays page one forever
  it("splits a window that came back at the record cap and covers every block exactly once", async () => {
    const covered: number[] = [];
    await fetchWindow({ fromBlock: 1, toBlock: 8 }, 2, async ({ fromBlock, toBlock }) => {
      if (toBlock - fromBlock + 1 > 2) {
        return [
          { address: CONTRACT, blockNumber: fromBlock, logIndex: 0, topics: [] },
          { address: CONTRACT, blockNumber: toBlock, logIndex: 0, topics: [] },
        ];
      }
      for (let block = fromBlock; block <= toBlock; block++) covered.push(block);
      return [];
    });

    assert.deepEqual(
      covered.toSorted((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(new Set(covered).size, covered.length, "no block fetched twice");
  });

  it("keeps every record when a deep split is needed", async () => {
    const dense = new Set([3, 4, 11, 12, 29, 30]);
    const logs = await fetchWindow({ fromBlock: 1, toBlock: 32 }, 2, async ({ fromBlock, toBlock }) => {
      const found = [];
      for (const block of dense) {
        if (block >= fromBlock && block <= toBlock) {
          found.push({ address: CONTRACT, blockNumber: block, logIndex: 0, topics: [ROLE_GRANTED_TOPIC] });
        }
      }
      return found;
    });

    assert.deepEqual(
      logs.map((entry) => entry.blockNumber).toSorted((a, b) => a - b),
      [...dense].toSorted((a, b) => a - b),
    );
  });

  it("refuses to report success when a single block fills the cap", async () => {
    await assert.rejects(
      fetchWindow({ fromBlock: 5, toBlock: 5 }, 1, async () => [
        { address: CONTRACT, blockNumber: 5, logIndex: 0, topics: [] },
      ]),
      /cannot be narrowed/,
    );
  });
});

describe("chain log sources", () => {
  it("gives every supported chain a source and a confirmation lag", () => {
    for (const [chainId, chain] of Object.entries(CHAIN_LOG_SOURCES)) {
      assert.ok(chain.source.kind, `chainId ${chainId} has no source`);
      assert.ok(chain.confirmationLag > 0, `chainId ${chainId} needs a confirmation lag`);
    }
  });

  // every chain a config declares an ozNonEnumerableAcl on, since the scan always runs
  it("covers every chain the ACL configs actually use", () => {
    for (const chainId of ["1", "10", "130", "8453", "42161", "59144", "560048", "11155111", "11155420"]) {
      assert.ok(CHAIN_LOG_SOURCES[chainId], `chainId ${chainId} has no log source`);
    }
  });

  // etherscan's free tier answers "Free API access is not supported for this chain" for both
  it("keeps optimism and base off etherscan", () => {
    for (const chainId of ["10", "8453"]) {
      assert.equal(CHAIN_LOG_SOURCES[chainId].source.kind, "blockscout");
    }
  });

  it("names a source the error messages can carry", () => {
    assert.equal(describeSource({ kind: "etherscan" }, "1"), "etherscan-v2(chainId=1)");
    assert.equal(
      describeSource({ hostname: "base.blockscout.com", kind: "blockscout" }, "8453"),
      "base.blockscout.com",
    );
  });
});
