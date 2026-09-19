import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { JsonRpcProvider } from "ethers";

import { RetryingJsonRpcProvider } from "../src/explorer";
import { parseBlockOption, pinBlockTag, toBlockTag } from "../src/pinned-block";

describe("--block option", () => {
  it("accepts a block number or latest and nothing else", () => {
    assert.equal(parseBlockOption("65439916"), "65439916");
    assert.equal(parseBlockOption("latest"), "latest");
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
    pinned.pinnedBlock = 16;

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
