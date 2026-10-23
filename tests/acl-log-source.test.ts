import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, mock } from "node:test";

import { FetchRequest, FetchResponse, JsonRpcProvider, toUtf8Bytes } from "ethers";

import { ROLE_GRANTED_TOPIC } from "../src/acl/fold";
import {
  CHAIN_LOG_SOURCES,
  collectRoleEvents,
  collectTailLogs,
  collectTailRoleEvents,
  describeSource,
  fetchWindow,
  isRateLimitAnswer,
  isSpanRefusal,
  makeSettledScanRange,
  parseQuantity,
  resolveScanBounds,
  type ScanRange,
  setExplorerTokenEnv,
  setRateLimitPause,
} from "../src/acl/log-source";
import { RetryingJsonRpcProvider, resetRequestSlots } from "../src/explorer";
import { toBlockTag } from "../src/pinned-block";

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

  it("fails a cooldown beyond the wait budget at once, naming it a rate limit", async () => {
    resetRequestSlots();
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async () => new Response("", { status: 429, headers: { "retry-after": "600" } }),
    );

    try {
      const outcome = await collectRoleEvents("10", CONTRACT, { fromBlock: 1, toBlock: 2 });
      assert.equal(outcome.ok, false);
      assert.match(outcome.ok ? "" : outcome.reason, /rate limit: cooldown 600000ms exceeds/);
      assert.equal(fetchMock.mock.calls.length, 1);
    } finally {
      fetchMock.mock.restore();
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

describe("the explorer token", () => {
  const withEnv = async (vars: Record<string, string | undefined>, body: () => Promise<void>) => {
    const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await body();
    } finally {
      setExplorerTokenEnv(undefined, undefined);
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it("comes from the variable the config names", async () => {
    // Reading a literal `ETHERSCAN_TOKEN` sent every ACL scan out unkeyed while the deployment
    // held the same credential under the name its config declares. Etherscan answers
    // "Missing/Invalid API Key", which reads as a rate limit and gets answered by copying the
    // secret into the file under a second name.
    await withEnv({ ETHERSCAN_TOKEN: undefined, ETHERSCAN_API_KEY: "from-the-config" }, async () => {
      setExplorerTokenEnv("ETHERSCAN_API_KEY", "api.etherscan.io");
      const seen: string[] = [];
      const restore = mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
        seen.push(String(url));
        return { ok: true, json: async () => ({ result: [], status: "1" }) } as Response;
      });
      try {
        await collectRoleEvents("1", `0x${"11".repeat(20)}`, makeSettledScanRange(0, 10));
      } finally {
        restore.mock.restore();
      }
      assert.ok(
        seen.some((url) => url.includes("apikey=from-the-config")),
        `no request carried the configured key: ${seen[0] ?? "(none sent)"}`,
      );
    });
  });

  it("falls back to the historic name, so a deployment relying on it keeps working", async () => {
    await withEnv({ ETHERSCAN_TOKEN: "the-old-name", ETHERSCAN_API_KEY: undefined }, async () => {
      setExplorerTokenEnv(undefined, undefined);
      const seen: string[] = [];
      const restore = mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
        seen.push(String(url));
        return { ok: true, json: async () => ({ result: [], status: "1" }) } as Response;
      });
      try {
        await collectRoleEvents("1", `0x${"22".repeat(20)}`, makeSettledScanRange(0, 10));
      } finally {
        restore.mock.restore();
      }
      assert.ok(
        seen.some((url) => url.includes("apikey=the-old-name")),
        seen[0] ?? "(none sent)",
      );
    });
  });

  it("knows chain 4663, whose holders were invisible while it did not", () => {
    // A chain absent from this table skips the scan and records "holders cannot be enumerated",
    // so an undeclared role holder is invisible rather than reported.
    assert.equal(CHAIN_LOG_SOURCES["4663"]?.source.kind, "etherscan");
  });

  it("does not send an Etherscan key to the independent Base or Optimism log source", async () => {
    await withEnv({ ETHERSCAN_TOKEN: "private-etherscan-key", BLOCKSCOUT_TOKEN: undefined }, async () => {
      setExplorerTokenEnv("ETHERSCAN_TOKEN", "api.etherscan.io");
      const seen: URL[] = [];
      const restore = mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
        seen.push(new URL(String(url)));
        return Response.json({ result: [], status: "1" });
      });
      try {
        await collectRoleEvents("8453", `0x${"11".repeat(20)}`, makeSettledScanRange(0, 10));
        await collectRoleEvents("10", `0x${"11".repeat(20)}`, makeSettledScanRange(0, 10));
      } finally {
        restore.mock.restore();
      }
      assert.deepEqual(
        seen.map((url) => url.hostname),
        ["base.blockscout.com", "explorer.optimism.io"],
      );
      assert.ok(seen.every((url) => url.searchParams.get("apikey") === null));
    });
  });

  it("uses a configured Blockscout key only on its matching log host", async () => {
    await withEnv({ CUSTOM_EXPLORER_KEY: "custom/key", BLOCKSCOUT_TOKEN: undefined }, async () => {
      setExplorerTokenEnv("CUSTOM_EXPLORER_KEY", "base.blockscout.com");
      const seen: URL[] = [];
      const restore = mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
        seen.push(new URL(String(url)));
        return Response.json({ result: [], status: "1" });
      });
      try {
        await collectRoleEvents("8453", `0x${"11".repeat(20)}`, makeSettledScanRange(0, 10));
        await collectRoleEvents("10", `0x${"11".repeat(20)}`, makeSettledScanRange(0, 10));
      } finally {
        restore.mock.restore();
      }
      assert.equal(seen[0].searchParams.get("apikey"), "custom/key");
      assert.equal(seen[1].searchParams.get("apikey"), null);
    });
  });

  it("uses provider-specific fallback keys when the configured explorer differs", async () => {
    await withEnv(
      {
        CUSTOM_EXPLORER_KEY: "other-provider-key",
        ETHERSCAN_TOKEN: "etherscan-fallback",
        BLOCKSCOUT_TOKEN: "blockscout-fallback",
      },
      async () => {
        setExplorerTokenEnv("CUSTOM_EXPLORER_KEY", "unrelated.example");
        const seen: URL[] = [];
        const restore = mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
          seen.push(new URL(String(url)));
          return Response.json({ result: [], status: "1" });
        });
        try {
          await collectRoleEvents("1", `0x${"11".repeat(20)}`, makeSettledScanRange(0, 10));
          await collectRoleEvents("8453", `0x${"11".repeat(20)}`, makeSettledScanRange(0, 10));
        } finally {
          restore.mock.restore();
        }
        assert.deepEqual(
          seen.map((url) => url.searchParams.get("apikey")),
          ["etherscan-fallback", "blockscout-fallback"],
        );
      },
    );
  });
});

describe("a node that limits the eth_getLogs span", () => {
  const ALCHEMY_FREE =
    'could not coalesce error (error={ "code": -32600, "message": "Under the Free tier plan, you can make ' +
    "eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: " +
    '[0x4, 0xd]" }, code=UNKNOWN_ERROR, version=6.17.0)';

  function limitedTo(span: number, asked: ScanRange[], blocks: number[] = []) {
    return {
      getLogs: async ({ fromBlock, toBlock }: ScanRange) => {
        asked.push({ fromBlock, toBlock });
        if (toBlock - fromBlock + 1 > span) throw new Error(ALCHEMY_FREE);
        return blocks
          .filter((block) => block >= fromBlock && block <= toBlock)
          .map((blockNumber) => ({
            address: CONTRACT,
            blockNumber,
            data: "0x",
            index: 0,
            topics: [ROLE_GRANTED_TOPIC],
          }));
      },
    } as unknown as JsonRpcProvider;
  }

  it("halves the tail until the node answers, and covers every block exactly once", async () => {
    // chain 4663: a 1200-block tail against an archive node that serves ten blocks at a time
    const asked: ScanRange[] = [];
    const logs = await collectTailLogs(limitedTo(10, asked, [7, 600, 1199]), CONTRACT, [ROLE_GRANTED_TOPIC], {
      fromBlock: 1,
      toBlock: 1200,
    });

    assert.deepEqual(
      logs.map((entry) => entry.blockNumber),
      [7, 600, 1199],
    );
    const served = asked.filter(({ fromBlock, toBlock }) => toBlock - fromBlock + 1 <= 10);
    const covered = served.flatMap(({ fromBlock, toBlock }) =>
      Array.from({ length: toBlock - fromBlock + 1 }, (_, index) => fromBlock + index),
    );
    assert.deepEqual(
      covered,
      Array.from({ length: 1200 }, (_, index) => index + 1),
    );
    // a refused span is not asked again: one refusal per halving on the way down, not per window
    assert.ok(asked.length - served.length <= 8, `${asked.length - served.length} refusals`);
  });

  it("gives up on a single block the node still refuses", async () => {
    await assert.rejects(
      collectTailLogs(limitedTo(0, []), CONTRACT, [ROLE_GRANTED_TOPIC], { fromBlock: 1, toBlock: 4 }),
      /10 block range/,
    );
  });

  it("does not halve on a rate limit, which a narrower window would not cure", async () => {
    const asked: ScanRange[] = [];
    const provider = {
      getLogs: async (range: ScanRange) => {
        asked.push(range);
        throw new Error("server response 429 Too Many Requests");
      },
    } as unknown as JsonRpcProvider;

    await assert.rejects(collectTailLogs(provider, CONTRACT, [ROLE_GRANTED_TOPIC], { fromBlock: 1, toBlock: 1200 }));
    assert.equal(asked.length, 1);
  });

  it("recognises how the common nodes word a span refusal", () => {
    for (const text of [
      ALCHEMY_FREE,
      "query returned more than 10000 results",
      "eth_getLogs is limited to a 10,000 range",
      "exceed maximum block range: 50000",
      "block range is too wide",
      "Log response size exceeded.",
      "ranges over 10000 blocks are not supported on freemium keys",
    ]) {
      assert.equal(isSpanRefusal(new Error(text)), true, text);
    }
    for (const text of ["execution reverted", "Too Many Requests", "rate limit exceeded", "missing trie node"]) {
      assert.equal(isSpanRefusal(new Error(text)), false, text);
    }
  });

  it("reads the refusal from the node's answer, not from the request id ethers quotes beside it", () => {
    const REFUSAL = { code: 22, message: "eth_getLogs range over 100000 blocks is not supported on robinhood" };
    const provider = new JsonRpcProvider("http://localhost:0", undefined, { staticNetwork: true });
    try {
      for (const id of [4, 429, 1429]) {
        const payload = { id, jsonrpc: "2.0" as const, method: "eth_getLogs", params: [{ fromBlock: "0x0" }] };
        assert.equal(isSpanRefusal(provider.getRpcError(payload, { error: REFUSAL, id })), true, `JSON-RPC id ${id}`);
      }
    } finally {
      provider.destroy();
    }

    // the error ethers raises for an HTTP status that is not 2xx
    const httpError = (status: number, statusText: string, error: { code: number; message: string }) => {
      const body = toUtf8Bytes(JSON.stringify({ error, id: 429, jsonrpc: "2.0" }));
      const response = new FetchResponse(status, statusText, {}, body, new FetchRequest("https://rpc.example"));
      try {
        response.assertOk();
      } catch (thrown) {
        return thrown;
      }
      throw new Error(`HTTP ${status} was accepted`);
    };
    const RANGE = { code: -32602, message: "block range too large" };
    assert.equal(isSpanRefusal(httpError(400, "Bad Request", RANGE)), true);
    assert.equal(isSpanRefusal(httpError(429, "Too Many Requests", RANGE)), false);
    assert.equal(isSpanRefusal(httpError(400, "Bad Request", { ...RANGE, code: 429 })), false);
  });

  it("takes a 429 that ethers escalated to 599 for a rate limit, whatever the body says", async () => {
    const server = http.createServer(async (request, response) => {
      for await (const _ of request) {
        // drain the request
      }
      response.statusCode = 429;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ error: { code: -32602, message: "block range too large" }, id: 1, jsonrpc: "2.0" }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const request = new FetchRequest(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    // one attempt: ethers would otherwise wait out a dozen retries before it escalates
    request.setThrottleParams({ maxAttempts: 1 });
    const provider = new JsonRpcProvider(request, 1, { batchMaxCount: 1, staticNetwork: true });
    try {
      const refusal = await provider.getLogs({ fromBlock: 1, toBlock: 2 }).then(
        () => assert.fail("the node answered 429"),
        (error: unknown) => error,
      );
      assert.match(String((refusal as { info?: { responseStatus?: unknown } }).info?.responseStatus), /^599 .*429/);
      assert.equal(isSpanRefusal(refusal), false);
    } finally {
      provider.destroy();
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("a pinned scan", () => {
  const prototype = JsonRpcProvider.prototype as { send?: unknown };

  function pinnedAt(pin: number, head: number): RetryingJsonRpcProvider {
    prototype.send = async (method: string) => {
      if (method === "eth_blockNumber") return `0x${head.toString(16)}`;
      throw new Error(`unexpected ${method}`);
    };
    const provider = new RetryingJsonRpcProvider("http://localhost:0", undefined, { staticNetwork: true });
    provider.pinned = { number: pin, tag: toBlockTag(pin) };
    return provider;
  }

  it("lets the log source serve all the way to a pin older than head minus the lag", async () => {
    // chain 4663's lag is 1200 blocks
    try {
      assert.deepEqual(await resolveScanBounds("4663", pinnedAt(67_125_350, 67_200_000)), {
        captured: 67_125_350,
        settled: 67_125_350,
      });
    } finally {
      delete prototype.send;
    }
  });

  it("still leaves a tail when the pin is within the lag of the head", async () => {
    try {
      assert.deepEqual(await resolveScanBounds("4663", pinnedAt(10_000, 10_500)), { captured: 10_000, settled: 9_300 });
    } finally {
      delete prototype.send;
    }
  });
});
