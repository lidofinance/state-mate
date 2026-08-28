import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ROLE_GRANTED_TOPIC } from "../src/acl/fold";
import {
  CHAIN_LOG_SOURCES,
  describeSource,
  fetchWindow,
  isRateLimitAnswer,
  parseQuantity,
  type ScanRange,
} from "../src/acl/log-source";

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
    for (const chainId of ["1", "10", "130", "8453", "42161", "59144", "11155111", "11155420"]) {
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
