import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";

import { Contract, JsonRpcProvider } from "ethers";
import { context } from "../src/context";
import { createProvider, RetryingJsonRpcProvider } from "../src/explorer";
import { FatalError } from "../src/logger";
import {
  assertPinnedHashCanonical,
  parseBlockOption,
  pinBlockTag,
  pinSectionBlock,
  toBlockTag,
} from "../src/pinned-block";

describe("--block option", () => {
  it("accepts a block number, a block hash or latest and nothing else", () => {
    assert.equal(parseBlockOption("65439916"), "65439916");
    assert.equal(parseBlockOption("latest"), "latest");
    assert.equal(parseBlockOption(`0x${"ab".repeat(32)}`), `0x${"ab".repeat(32)}`);
    assert.equal(parseBlockOption(`0x${"ab".repeat(31)}`), null);
    assert.equal(parseBlockOption("0x3e688ac"), null);
    assert.equal(parseBlockOption("pending"), null);
    assert.equal(parseBlockOption("-1"), null);
  });

  it("renders a block as the hex tag JSON-RPC takes", () => {
    assert.equal(toBlockTag(65439916), "0x3e688ac");
    assert.equal(toBlockTag(0), "0x0");
  });
});

describe("pinning a block tag", () => {
  it("rewrites the latest ethers sends with every read", () => {
    assert.deepEqual(pinBlockTag("eth_call", [{ to: "0x1" }, "latest"], "0x10"), [{ to: "0x1" }, "0x10"]);
    assert.deepEqual(pinBlockTag("eth_getStorageAt", ["0x1", "0x0", "latest"], "0x10"), ["0x1", "0x0", "0x10"]);
    assert.deepEqual(pinBlockTag("eth_getCode", ["0x1", "latest"], "0x10"), ["0x1", "0x10"]);
    assert.deepEqual(pinBlockTag("eth_getBalance", ["0x1", "latest"], "0x10"), ["0x1", "0x10"]);
  });

  it("fills in the tag a caller left out", () => {
    assert.deepEqual(pinBlockTag("eth_call", [{ to: "0x1" }], "0x10"), [{ to: "0x1" }, "0x10"]);
  });

  it("leaves an explicit block and every other method alone", () => {
    assert.deepEqual(pinBlockTag("eth_call", [{ to: "0x1" }, "0x5"], "0x10"), [{ to: "0x1" }, "0x5"]);
    assert.deepEqual(pinBlockTag("eth_blockNumber", [], "0x10"), []);
    assert.deepEqual(pinBlockTag("eth_getLogs", [{ toBlock: "latest" }], "0x10"), [{ toBlock: "latest" }]);
    assert.deepEqual(pinBlockTag("eth_call", { to: "0x1" }, "0x10"), { to: "0x1" });
  });
});

describe("a pinned provider", () => {
  const sent: [string, unknown][] = [];
  const prototype = JsonRpcProvider.prototype as { send?: unknown };

  afterEach(() => {
    delete prototype.send;
    sent.length = 0;
  });

  function provider(): RetryingJsonRpcProvider {
    prototype.send = async (method: string, parameters: unknown) => {
      sent.push([method, parameters]);
      return "0x";
    };
    return new RetryingJsonRpcProvider("http://localhost:0", undefined, { staticNetwork: true });
  }

  it("sends every read at the pinned block and reports that block as the head", async () => {
    const pinned = provider();
    pinned.pinned = { number: 16, tag: "0x10" };

    await pinned.send("eth_call", [{ to: "0x1" }, "latest"]);
    await pinned.send("eth_getStorageAt", ["0x1", "0x0", "latest"]);

    assert.deepEqual(sent, [
      ["eth_call", [{ to: "0x1" }, "0x10"]],
      ["eth_getStorageAt", ["0x1", "0x0", "0x10"]],
    ]);
    assert.equal(await pinned.getBlockNumber(), 16);
  });

  it("sends an unpinned read as it came", async () => {
    await provider().send("eth_call", [{ to: "0x1" }, "latest"]);

    assert.deepEqual(sent, [["eth_call", [{ to: "0x1" }, "latest"]]]);
  });
});

const HASH = `0x${"ab".repeat(32)}`;
const ADDRESS = "0x0000000000000000000000000000000000000001";
const BLOCK = {
  hash: HASH,
  parentHash: `0x${"cd".repeat(32)}`,
  number: "0x10",
  timestamp: "0x1",
  nonce: "0x0000000000000000",
  difficulty: "0x0",
  gasLimit: "0x1",
  gasUsed: "0x0",
  miner: ADDRESS,
  extraData: "0x",
  transactions: [],
};

/** A JSON-RPC server that records what ethers puts on the wire, and a provider pointed at it. */
async function wire() {
  const sent: Record<string, string> = {};
  const answers: Record<string, unknown> = {
    eth_chainId: "0x1",
    eth_getCode: "0x6001",
    eth_getLogs: [],
    eth_getBlockByHash: BLOCK,
  };
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body);
      const replies = [parsed].flat().map((message: { id: number; method: string; params: unknown }) => {
        sent[message.method] = JSON.stringify(message.params);
        return { jsonrpc: "2.0", id: message.id, result: answers[message.method] ?? `0x${"0".repeat(63)}1` };
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const provider = createProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const read = async () => {
    await new Contract(ADDRESS, ["function f() view returns (uint256)"], provider).getFunction("f").staticCall();
    await provider.getStorage(ADDRESS, 0);
    await provider.getCode(ADDRESS);
    await provider.getLogs({ address: ADDRESS, fromBlock: 1, toBlock: await provider.getBlockNumber() });
  };
  const close = () => {
    provider.destroy();
    server.close();
  };
  return { answers, close, provider, read, sent };
}

describe("ethers over a pinned provider", () => {
  it("puts the pinned block number on the wire for calls, storage, code and log scans", async () => {
    const { close, provider, read, sent } = await wire();
    provider.pinned = { number: 16, tag: "0x10" };
    try {
      await read();
    } finally {
      close();
    }
    assert.match(sent.eth_call, /"0x10"\]$/);
    assert.match(sent.eth_getStorageAt, /"0x10"\]$/);
    assert.match(sent.eth_getCode, /"0x10"\]$/);
    assert.match(sent.eth_getLogs, /"toBlock":"0x10"/);
    assert.equal(sent.eth_blockNumber, undefined);
  });

  it("pins a block hash as a canonical EIP-1898 reference, and scans logs to its number", async () => {
    const { close, provider, read, sent } = await wire();
    context.block = HASH;
    try {
      await pinSectionBlock(provider);
      await read();
    } finally {
      context.block = undefined;
      close();
    }
    const reference = `{"blockHash":"${HASH}","requireCanonical":true}`;
    assert.ok(sent.eth_call.endsWith(`${reference}]`));
    assert.ok(sent.eth_getStorageAt.endsWith(`${reference}]`));
    assert.ok(sent.eth_getCode.endsWith(`${reference}]`));
    assert.match(sent.eth_getLogs, /"toBlock":"0x10"/);
  });

  for (const [still, heldHash] of [
    [true, HASH],
    [false, `0x${"ef".repeat(32)}`],
  ] as const) {
    it(`${still ? "keeps" : "fails"} the run when the height ${still ? "still holds" : "no longer holds"} the pinned hash`, async () => {
      const { answers, close, provider } = await wire();
      context.block = HASH.toUpperCase().replace("0X", "0x");
      context.json = true;
      try {
        await pinSectionBlock(provider);
        answers.eth_getBlockByNumber = { ...BLOCK, hash: heldHash };
        const check = assertPinnedHashCanonical(provider);
        if (still) await check;
        else await assert.rejects(check, FatalError);
      } finally {
        context.block = undefined;
        context.json = false;
        close();
      }
    });
  }
});
