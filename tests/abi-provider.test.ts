import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import zlib from "node:zlib";

import { JsonRpcProvider } from "ethers";

import {
  checkAllAbi,
  flushAbiUpdates,
  getAbiNameForAddress,
  keepStoredAbi,
  loadAbiFromFile,
  pruneAbiStores,
  resetAbiCache,
  resetAbiRebuildState,
} from "../src/abi-provider";
import { EntryField } from "../src/common";
import { context, resetStats, stats } from "../src/context";
import { fetchExplorerChainId, resetBlockscoutHostProbes } from "../src/explorer";
import { SectionValidatorBase } from "../src/section-validators/base";
import * as stateMate from "../src/state-mate";
import type { ContractEntry, EntireDocument } from "../src/typebox";
import type { Abi, ContractInfo } from "../src/types";
import { mockFetch } from "./helpers/fetch-mock";

const PROXY_ADDRESS = "0xAaAaAAaaAaAAAaaAAaAaaaAAaAAAaaaAaaaaaaa1";
const IMPL_ADDRESS = "0xBbbBBBbbbBBbbbBbbBbbbbBBbBBbbBbBbbbbbbb2";
const CROSS_CHAIN_ADDRESS = "0xb948a93827d68a82F6513Ad178964Da487fe2BD9";
const BSC_PROXY_ADDRESS = "0xbe3F7e06872E0dF6CD7FF35B7aa4Bb1446DC9986";
const ETH_CHAIN_ID = 1;
const BSC_CHAIN_ID = 56;
const LIDO_ABI: Abi = [{ type: "function", name: "getFee", inputs: [], stateMutability: "view" }];
const PROXY_ABI: Abi = [{ type: "function", name: "proxy__getAdmin", inputs: [], stateMutability: "view" }];
const WORMHOLE_ABI: Abi = [{ type: "function", name: "nttManager", inputs: [], stateMutability: "view" }];

function scopedKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

const temporaryDirectories: string[] = [];

function setupConfigDirectory(store?: Record<string, unknown>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "state-mate-abi-test-"));
  temporaryDirectories.push(directory);
  if (store) {
    fs.writeFileSync(path.join(directory, "abis.json.gz"), zlib.gzipSync(JSON.stringify(store)));
  }
  context.configPath = path.join(directory, "config.yaml");
  resetAbiCache();
  return directory;
}

function readStore(directory: string): Record<string, { name: string; abi: Abi }> {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(directory, "abis.json.gz"))).toString("utf8")) as Record<
    string,
    { name: string; abi: Abi }
  >;
}

function findAbiArchives(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findAbiArchives(entryPath);
    return entry.name === "abis.json.gz" ? [entryPath] : [];
  });
}

class ExitSignal extends Error {}

// logErrorAndExit calls process.exit; turn it into a catchable signal and capture the message
function expectExit(callback: () => unknown): string {
  const originalExit = process.exit;
  const originalError = console.error;
  const originalTrace = console.trace;
  let message = "";
  console.error = (...parts: unknown[]) => {
    message += parts.map(String).join(" ");
  };
  console.trace = () => {};
  process.exit = (() => {
    throw new ExitSignal();
  }) as typeof process.exit;
  try {
    callback();
    assert.fail("expected logErrorAndExit to be called");
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
  } finally {
    process.exit = originalExit;
    console.error = originalError;
    console.trace = originalTrace;
  }
  return message;
}

afterEach(() => {
  context.updateAbi = false;
  context.allowUnverifiedExplorer = false;
  resetAbiRebuildState();
  resetBlockscoutHostProbes();
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.length = 0;
});

describe("loadAbiFromFile", () => {
  it("resolves the ABI by address regardless of input case", () => {
    setupConfigDirectory({ [scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)]: { name: "Lido", abi: LIDO_ABI } });
    assert.deepEqual(loadAbiFromFile(ETH_CHAIN_ID, "Lido", PROXY_ADDRESS), LIDO_ABI);
  });

  it("normalizes uppercase store keys on load", () => {
    setupConfigDirectory({ [`${ETH_CHAIN_ID}:${PROXY_ADDRESS}`]: { name: "Lido", abi: LIDO_ABI } });
    assert.deepEqual(loadAbiFromFile(ETH_CHAIN_ID, "Lido", PROXY_ADDRESS.toLowerCase()), LIDO_ABI);
  });

  it("exits when the stored name differs from the expected one", () => {
    setupConfigDirectory({ [scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)]: { name: "Lido", abi: LIDO_ABI } });
    const message = expectExit(() => loadAbiFromFile(ETH_CHAIN_ID, "OssifiableProxy", PROXY_ADDRESS));
    assert.match(message, /belongs to/);
  });

  it("exits when the address has no entry", () => {
    setupConfigDirectory({ [scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)]: { name: "Lido", abi: LIDO_ABI } });
    const message = expectExit(() => loadAbiFromFile(ETH_CHAIN_ID, "Lido", IMPL_ADDRESS));
    assert.match(message, /ABI not found/);
  });

  it("exits when the store file is missing", () => {
    setupConfigDirectory();
    const message = expectExit(() => loadAbiFromFile(ETH_CHAIN_ID, "Lido", PROXY_ADDRESS));
    assert.match(message, /No consolidated ABI file found/);
  });

  it("exits on an entry without a name or a valid ABI", () => {
    setupConfigDirectory({ [scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)]: { abi: LIDO_ABI } });
    const message = expectExit(() => loadAbiFromFile(ETH_CHAIN_ID, "Lido", PROXY_ADDRESS));
    assert.match(message, /invalid entry/);
  });
});

describe("downloadAndCheckAllAbi", () => {
  it("does not query the explorer for an ABI that already exists", async () => {
    setupConfigDirectory({
      [scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)]: { name: "OssifiableProxy", abi: PROXY_ABI },
    });
    const fetchMock = mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
      if (/eth_gasPrice|eth-rpc|eth_chainId/.test(String(url))) {
        return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 83, result: "0x1" }) } as Response;
      }
      throw new Error("unexpected explorer request");
    });

    try {
      // a blockscout-style host: etherscan skips the chain probe anyway, so it could not prove
      // that a full store keeps the run silent
      await stateMate.downloadAndCheckAllAbi({
        deployed: { l1: [PROXY_ADDRESS] },
        l1: { rpcUrl: "http://localhost:1", explorerHostname: "idle.blockscout.example", chainId: 1 },
      } as EntireDocument);
      // with nothing to download, neither a source request nor a chain probe may fire: a full
      // store must not depend on the explorer being awake
      assert.equal(fetchMock.mock.calls.length, 0);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("does not let an existing ABI in one chain suppress the same address in another chain", async () => {
    const directory = setupConfigDirectory({
      [scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)]: { name: "ERC1967Proxy", abi: PROXY_ABI },
    });
    const fetchMock = mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
      if (/eth_gasPrice|eth-rpc|eth_chainId/.test(String(url))) {
        const chainId = String(url).includes("bscscan") ? BSC_CHAIN_ID : ETH_CHAIN_ID;
        return {
          ok: true,
          json: async () => ({ jsonrpc: "2.0", id: 83, result: `0x${Number(chainId).toString(16)}` }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          status: "1",
          message: "OK",
          result: [{ ABI: JSON.stringify(WORMHOLE_ABI), ContractName: "WormholeTransceiver", IsProxy: "false" }],
        }),
      } as Response;
    });

    try {
      await stateMate.downloadAndCheckAllAbi({
        deployed: { l1: [PROXY_ADDRESS], l2: [PROXY_ADDRESS] },
        l1: { rpcUrl: "http://localhost:1", explorerHostname: "api.etherscan.io", chainId: ETH_CHAIN_ID },
        l2: { rpcUrl: "http://localhost:2", explorerHostname: "api.bscscan.com", chainId: BSC_CHAIN_ID },
      } as EntireDocument);

      const sourceRequests = fetchMock.mock.calls.filter((c) => String(c.arguments[0]).includes("getsourcecode"));
      assert.equal(sourceRequests.length, 1);
      const store = readStore(directory);
      assert.deepEqual(store[scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)], {
        name: "ERC1967Proxy",
        abi: PROXY_ABI,
      });
      assert.deepEqual(store[scopedKey(BSC_CHAIN_ID, PROXY_ADDRESS)], {
        name: "WormholeTransceiver",
        abi: WORMHOLE_ABI,
      });
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("downloads a shared address once per --update-abi run, later configs reuse it", async () => {
    const directory = setupConfigDirectory();
    context.updateAbi = true;
    const fetchMock = mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
      if (/eth_gasPrice|eth-rpc|eth_chainId/.test(String(url))) {
        return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 83, result: "0x1" }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          status: "1",
          message: "OK",
          result: [{ ABI: JSON.stringify(WORMHOLE_ABI), ContractName: "WormholeTransceiver", IsProxy: "false" }],
        }),
      } as Response;
    });

    const jsonDocument = {
      deployed: { l1: [PROXY_ADDRESS] },
      l1: { rpcUrl: "http://localhost:1", explorerHostname: "api.etherscan.io", chainId: ETH_CHAIN_ID },
    } as unknown as EntireDocument;
    try {
      await stateMate.downloadAndCheckAllAbi(jsonDocument);
      // the next config of the directory run starts with a fresh cache but the same walked set
      resetAbiCache();
      await stateMate.downloadAndCheckAllAbi(jsonDocument);

      const sourceRequests = fetchMock.mock.calls.filter((c) => String(c.arguments[0]).includes("getsourcecode"));
      assert.equal(sourceRequests.length, 1);
      assert.equal(readStore(directory)[scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)].name, "WormholeTransceiver");
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("keeps stored ABIs of a section that has no explorer instead of dying under --update-abi", async () => {
    const directory = setupConfigDirectory({
      [scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)]: { name: "OssifiableProxy", abi: PROXY_ABI },
    });
    context.updateAbi = true;
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("no explorer should be contacted");
    });

    const originalExit = process.exit;
    let exited = false;
    process.exit = (() => {
      exited = true;
      throw new ExitSignal();
    }) as typeof process.exit;
    try {
      await stateMate.downloadAndCheckAllAbi({
        deployed: { l1: [PROXY_ADDRESS] },
        l1: { rpcUrl: "http://localhost:1", chainId: ETH_CHAIN_ID },
      } as EntireDocument);
    } catch (error) {
      if (!(error instanceof ExitSignal)) throw error;
    } finally {
      process.exit = originalExit;
      fetchMock.mock.restore();
    }
    assert.equal(exited, false, "a section without explorerHostname must not abort the rebuild");

    pruneAbiStores();
    const store = readStore(directory);
    assert.equal(store[scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)].name, "OssifiableProxy");
  });

  it("refuses to download from an explorer that does not confirm the chain, unless allowed", async () => {
    // the store key takes chainId from the YAML, so an ABI served by an explorer of another
    // network would be filed under the wrong chain and verify the wrong contract
    const directory = setupConfigDirectory();
    const fetchMock = mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
      if (/eth-rpc|eth_chainId/.test(String(url))) {
        return { ok: true, json: async () => ({ status: "0", message: "NOTOK", result: "no rpc here" }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          status: "1",
          message: "OK",
          result: [{ ABI: JSON.stringify(WORMHOLE_ABI), ContractName: "ForeignChainContract" }],
        }),
      } as Response;
    });
    const jsonDocument = {
      deployed: { l1: [PROXY_ADDRESS] },
      l1: { rpcUrl: "http://localhost:1", explorerHostname: "unverified.blockscout.example", chainId: ETH_CHAIN_ID },
    } as EntireDocument;

    const originalExit = process.exit;
    let exited = false;
    process.exit = (() => {
      exited = true;
      throw new ExitSignal();
    }) as typeof process.exit;
    try {
      await stateMate.downloadAndCheckAllAbi(jsonDocument);
    } catch (error) {
      if (!(error instanceof ExitSignal)) throw error;
    } finally {
      process.exit = originalExit;
    }
    assert.equal(exited, true, "a missing ABI plus an unconfirmed explorer must stop the run");
    assert.equal(fs.existsSync(path.join(directory, "abis.json.gz")), false, "nothing may reach the store");

    // the flag is the deliberate bypass
    context.allowUnverifiedExplorer = true;
    try {
      await stateMate.downloadAndCheckAllAbi(jsonDocument);
    } finally {
      fetchMock.mock.restore();
    }
    assert.equal(readStore(directory)[scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)].name, "ForeignChainContract");
  });

  it("reaches the blockscout v2 download when the flag bypasses a dead chain-id probe", async () => {
    // mirrors a live blockscout host: both v1 probe routes are gone while /api/v2 answers
    const directory = setupConfigDirectory();
    const fetchMock = mockFetch((url) => {
      if (/eth-rpc|eth_chainId/.test(url)) return { status: 400 };
      if (url.endsWith("/api/v2/config/backend-version")) return { body: { backend_version: "v11.2.8" } };
      return { body: { name: "OssifiableProxy", is_verified: true, abi: PROXY_ABI } };
    });
    context.allowUnverifiedExplorer = true;
    try {
      await stateMate.downloadAndCheckAllAbi({
        deployed: { l1: [PROXY_ADDRESS] },
        l1: { rpcUrl: "http://localhost:1", explorerHostname: "chain.blockscout.com", chainId: ETH_CHAIN_ID },
      } as EntireDocument);
    } finally {
      fetchMock.mock.restore();
    }
    const abiRequests = fetchMock.mock.calls
      .map((call) => String(call.arguments[0]))
      .filter((url) => url.includes("/api/v2/smart-contracts/"));
    assert.equal(abiRequests.length, 1, "the ABI must come from the v2 route");
    assert.equal(readStore(directory)[scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)].name, "OssifiableProxy");
  });

  it("downloads the ABI pinned at implementation: even when the proxy itself is stored", async () => {
    // a Safe singleton lives in implementation: and nowhere in deployed; a store that already
    // holds the proxy must not suppress the singleton download
    const directory = setupConfigDirectory({
      [scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)]: { name: "SafeProxy", abi: PROXY_ABI },
    });
    const fetchMock = mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
      if (/eth_gasPrice|eth-rpc|eth_chainId/.test(String(url))) {
        return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 83, result: "0x1" }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          status: "1",
          message: "OK",
          result: [{ ABI: JSON.stringify(LIDO_ABI), ContractName: "GnosisSafe" }],
        }),
      } as Response;
    });

    try {
      await stateMate.downloadAndCheckAllAbi({
        deployed: { l1: [PROXY_ADDRESS] },
        l1: {
          rpcUrl: "http://localhost:1",
          explorerHostname: "api.etherscan.io",
          chainId: ETH_CHAIN_ID,
          contracts: {
            multisig: {
              name: "GnosisSafe",
              address: PROXY_ADDRESS,
              proxyName: "SafeProxy",
              implementation: IMPL_ADDRESS,
              proxyChecks: {},
              checks: {},
            },
          },
        },
      } as unknown as EntireDocument);

      const sourceRequests = fetchMock.mock.calls.filter((c) => String(c.arguments[0]).includes("getsourcecode"));
      assert.equal(sourceRequests.length, 1);
      assert.ok(String(sourceRequests[0].arguments[0]).toLowerCase().includes(IMPL_ADDRESS.toLowerCase()));
      assert.equal(readStore(directory)[scopedKey(ETH_CHAIN_ID, IMPL_ADDRESS)].name, "GnosisSafe");
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("keeps a stored ABI the explorer refuses to serve and sweeps unreferenced ones", async () => {
    const directory = setupConfigDirectory({
      [scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)]: { name: "SignatureRedeemQueue", abi: PROXY_ABI },
      [scopedKey(ETH_CHAIN_ID, CROSS_CHAIN_ADDRESS)]: { name: "Orphan", abi: WORMHOLE_ABI },
    });
    context.updateAbi = true;
    const fetchMock = mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
      if (/eth_gasPrice|eth-rpc|eth_chainId/.test(String(url))) {
        return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 83, result: "0x1" }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({ status: "0", message: "NOTOK", result: "Contract source code not verified" }),
      } as Response;
    });

    try {
      await stateMate.downloadAndCheckAllAbi({
        deployed: { l1: [PROXY_ADDRESS] },
        l1: { rpcUrl: "http://localhost:1", explorerHostname: "api.etherscan.io", chainId: ETH_CHAIN_ID },
      } as EntireDocument);
      pruneAbiStores();

      const store = readStore(directory);
      assert.equal(store[scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)].name, "SignatureRedeemQueue");
      assert.equal(store[scopedKey(ETH_CHAIN_ID, CROSS_CHAIN_ADDRESS)], undefined);
    } finally {
      fetchMock.mock.restore();
    }
  });
});

describe("getAbiNameForAddress", () => {
  it("only finds an existing ABI in the requested chain", () => {
    setupConfigDirectory({
      [scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)]: { name: "OssifiableProxy", abi: PROXY_ABI },
    });
    assert.equal(getAbiNameForAddress(ETH_CHAIN_ID, PROXY_ADDRESS), "OssifiableProxy");
    assert.equal(getAbiNameForAddress(BSC_CHAIN_ID, PROXY_ADDRESS), undefined);
  });
});

describe("keepStoredAbi + pruneAbiStores", () => {
  it("keeps an ABI the checks loaded even when its address is outside deployed", async () => {
    // a proxyChecks ABI resolves at an address the config keeps in parameters, not in deployed;
    // the sweep must not treat what the run actually used as unreferenced
    const directory = setupConfigDirectory({
      [scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)]: { name: "OssifiableProxy", abi: PROXY_ABI },
    });
    context.updateAbi = true;

    await checkAllAbi(ETH_CHAIN_ID, {
      contractName: "WormholeTransceiver",
      address: BSC_PROXY_ADDRESS,
      abi: WORMHOLE_ABI,
    });
    loadAbiFromFile(ETH_CHAIN_ID, "OssifiableProxy", PROXY_ADDRESS);
    flushAbiUpdates();
    pruneAbiStores();

    const store = readStore(directory);
    assert.equal(store[scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)].name, "OssifiableProxy");
  });

  it("rebuilds an unreadable store from scratch under --update-abi and keeps a backup", async () => {
    // the pre-consolidation format kept bare ABI arrays; --update-abi is the upgrade path, and
    // the original archive must survive a partial rebuild
    const directory = setupConfigDirectory({ [PROXY_ADDRESS.toLowerCase()]: PROXY_ABI });
    const original = fs.readFileSync(path.join(directory, "abis.json.gz"));
    context.updateAbi = true;

    assert.equal(getAbiNameForAddress(ETH_CHAIN_ID, PROXY_ADDRESS), undefined);

    await checkAllAbi(ETH_CHAIN_ID, {
      contractName: "WormholeTransceiver",
      address: BSC_PROXY_ADDRESS,
      abi: WORMHOLE_ABI,
    });
    flushAbiUpdates();

    const store = readStore(directory);
    assert.equal(store[scopedKey(ETH_CHAIN_ID, BSC_PROXY_ADDRESS)].name, "WormholeTransceiver");
    const backup = path.join(directory, "abis.json.gz.invalid");
    assert.ok(fs.existsSync(backup), "the unreadable archive must be preserved as a backup");
    assert.deepEqual(fs.readFileSync(backup), original);
  });

  it("keeps the earlier backup when recovery runs twice", async () => {
    const directory = setupConfigDirectory({ [PROXY_ADDRESS.toLowerCase()]: PROXY_ABI });
    const original = fs.readFileSync(path.join(directory, "abis.json.gz"));
    context.updateAbi = true;

    assert.equal(getAbiNameForAddress(ETH_CHAIN_ID, PROXY_ADDRESS), undefined);

    // the store turns unreadable again after the first recovery
    fs.writeFileSync(path.join(directory, "abis.json.gz"), "not gzip at all");
    resetAbiCache();
    assert.equal(getAbiNameForAddress(ETH_CHAIN_ID, PROXY_ADDRESS), undefined);

    assert.deepEqual(fs.readFileSync(path.join(directory, "abis.json.gz.invalid")), original);
    assert.ok(
      fs.existsSync(path.join(directory, "abis.json.gz.invalid.1")),
      "the second backup must not overwrite the first",
    );
  });

  it("leaves the store intact when the pruned copy cannot be written in full", async () => {
    const directory = setupConfigDirectory({
      [scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)]: { name: "OssifiableProxy", abi: PROXY_ABI },
      [scopedKey(ETH_CHAIN_ID, CROSS_CHAIN_ADDRESS)]: { name: "Orphan", abi: WORMHOLE_ABI },
    });
    context.updateAbi = true;
    loadAbiFromFile(ETH_CHAIN_ID, "OssifiableProxy", PROXY_ADDRESS);

    const realWrite = fs.writeFileSync.bind(fs);
    const writeMock = mock.method(fs, "writeFileSync", ((
      file: Parameters<typeof fs.writeFileSync>[0],
      data: Parameters<typeof fs.writeFileSync>[1],
    ) => {
      if (String(file).includes("abis.json.gz")) {
        // a full disk cuts the write short
        realWrite(file, (data as Buffer).subarray(0, 7));
        throw new Error("ENOSPC: no space left on device");
      }
      return realWrite(file, data);
    }) as typeof fs.writeFileSync);
    try {
      pruneAbiStores();
    } finally {
      writeMock.mock.restore();
    }

    // the sweep failed, so nothing was dropped, but the archive must still be readable
    const store = readStore(directory);
    assert.equal(store[scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)].name, "OssifiableProxy");
    assert.equal(store[scopedKey(ETH_CHAIN_ID, CROSS_CHAIN_ADDRESS)].name, "Orphan");
  });

  it("re-downloads under --update-abi an ABI a sibling config only read", async () => {
    // config A loading an ABI for its checks must not convince config B the address was
    // already re-downloaded
    setupConfigDirectory({
      [scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)]: { name: "WormholeTransceiver", abi: WORMHOLE_ABI },
    });
    context.updateAbi = true;
    loadAbiFromFile(ETH_CHAIN_ID, "WormholeTransceiver", PROXY_ADDRESS);

    const fetchMock = mock.method(globalThis, "fetch", async () => {
      return {
        ok: true,
        json: async () => ({
          status: "1",
          message: "OK",
          result: [{ ABI: JSON.stringify(WORMHOLE_ABI), ContractName: "WormholeTransceiver", IsProxy: "false" }],
        }),
      } as Response;
    });
    try {
      await stateMate.downloadAndCheckAllAbi({
        deployed: { l1: [PROXY_ADDRESS] },
        l1: { rpcUrl: "http://localhost:1", explorerHostname: "api.etherscan.io", chainId: ETH_CHAIN_ID },
      } as EntireDocument);
      const sourceRequests = fetchMock.mock.calls.filter((c) => String(c.arguments[0]).includes("getsourcecode"));
      assert.equal(sourceRequests.length, 1);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("warns and keeps going when a store cannot be pruned", async () => {
    const directory = setupConfigDirectory();
    context.updateAbi = true;
    await checkAllAbi(ETH_CHAIN_ID, {
      contractName: "OssifiableProxy",
      address: PROXY_ADDRESS,
      abi: PROXY_ABI,
    });
    flushAbiUpdates();
    // the store turns unreadable between the flush and the sweep
    fs.writeFileSync(path.join(directory, "abis.json.gz"), "not gzip at all");

    const originalExit = process.exit;
    let exited = false;
    process.exit = (() => {
      exited = true;
      throw new ExitSignal();
    }) as typeof process.exit;
    try {
      pruneAbiStores();
    } catch (error) {
      if (!(error instanceof ExitSignal)) throw error;
    } finally {
      process.exit = originalExit;
    }
    assert.equal(exited, false, "pruneAbiStores must not exit the process on a broken store");
  });
});

describe("fetchExplorerChainId", () => {
  it("reports the explorer's chain as a decimal string", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 83, result: "0x38" }) } as Response;
    });
    try {
      assert.equal(await fetchExplorerChainId("api.bscscan.com"), "56");
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("returns undefined when the explorer cannot answer", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      return { ok: true, json: async () => ({ status: "0", message: "NOTOK", result: "Invalid API URL" }) } as Response;
    });
    try {
      assert.equal(await fetchExplorerChainId("api.bscscan.com"), undefined);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("retries the eth-rpc route instead of abandoning it for a fallback that cannot answer", async () => {
    // the eth-rpc route is the one blockscout hosts serve; the legacy fallback answers
    // "Unknown module" there, so one flaked primary request must not decide the probe
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const fetchMock = mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
      if (String(url).includes("eth-rpc")) {
        primaryCalls++;
        if (primaryCalls === 1) {
          return { ok: false, status: 429, statusText: "Too Many Requests" } as Response;
        }
        return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 83, result: "0x38" }) } as Response;
      }
      fallbackCalls++;
      return { ok: true, json: async () => ({ status: "0", message: "NOTOK", result: "Unknown module" }) } as Response;
    });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pending = fetchExplorerChainId("api.bscscan.com");
      for (let round = 0; round < 8; round++) {
        await new Promise((resolve) => setImmediate(resolve));
        mock.timers.tick(7000);
      }
      assert.equal(await pending, "56");
      assert.equal(primaryCalls, 2);
      assert.equal(fallbackCalls, 0);
    } finally {
      mock.timers.reset();
      fetchMock.mock.restore();
    }
  });

  it("retries the fallback after a rate limit served as HTTP 200", async () => {
    // free tiers complain about the rate limit in a JSON body, not in the HTTP status
    let fallbackCalls = 0;
    const fetchMock = mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
      if (String(url).includes("eth-rpc")) {
        return { ok: true, json: async () => ({ status: "0", message: "NOTOK", result: "no rpc here" }) } as Response;
      }
      fallbackCalls++;
      if (fallbackCalls === 1) {
        return {
          ok: true,
          json: async () => ({ status: "0", message: "NOTOK", result: "Max Rate limit reached" }),
        } as Response;
      }
      return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 83, result: "0x38" }) } as Response;
    });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pending = fetchExplorerChainId("api.bscscan.com");
      for (let round = 0; round < 8; round++) {
        await new Promise((resolve) => setImmediate(resolve));
        mock.timers.tick(7000);
      }
      assert.equal(await pending, "56");
      assert.equal(fallbackCalls, 2);
    } finally {
      mock.timers.reset();
      fetchMock.mock.restore();
    }
  });

  it("retries a flaked fallback probe instead of blocking downloads on it", async () => {
    // an unanswered probe makes the download gate fatal, so one 429 must not decide it
    let fallbackCalls = 0;
    const fetchMock = mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
      if (String(url).includes("eth-rpc")) {
        return { ok: true, json: async () => ({ status: "0", message: "NOTOK", result: "no rpc here" }) } as Response;
      }
      fallbackCalls++;
      if (fallbackCalls === 1) {
        return { ok: false, status: 429, statusText: "Too Many Requests" } as Response;
      }
      return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 83, result: "0x38" }) } as Response;
    });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pending = fetchExplorerChainId("api.bscscan.com");
      for (let round = 0; round < 8; round++) {
        await new Promise((resolve) => setImmediate(resolve));
        mock.timers.tick(7000);
      }
      assert.equal(await pending, "56");
      assert.equal(fallbackCalls, 2);
    } finally {
      mock.timers.reset();
      fetchMock.mock.restore();
    }
  });

  it("gives the fallback probe two attempts at most", async () => {
    let fallbackCalls = 0;
    const fetchMock = mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
      if (String(url).includes("eth-rpc")) {
        return { ok: true, json: async () => ({ status: "0", message: "NOTOK", result: "no rpc here" }) } as Response;
      }
      fallbackCalls++;
      return { ok: false, status: 429, statusText: "Too Many Requests" } as Response;
    });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pending = fetchExplorerChainId("api.bscscan.com");
      for (let round = 0; round < 8; round++) {
        await new Promise((resolve) => setImmediate(resolve));
        mock.timers.tick(7000);
      }
      assert.equal(await pending, undefined);
      assert.equal(fallbackCalls, 2);
    } finally {
      mock.timers.reset();
      fetchMock.mock.restore();
    }
  });
});

describe("checkAllAbi + flushAbiUpdates", () => {
  const proxyInfo: ContractInfo = {
    contractName: "OssifiableProxy",
    address: PROXY_ADDRESS,
    abi: PROXY_ABI,
  };
  const implementationInfo: ContractInfo = { contractName: "Lido", address: IMPL_ADDRESS, abi: LIDO_ABI };

  it("creates the store with proxy and implementation entries under chain-scoped lowercase keys", async () => {
    const directory = setupConfigDirectory();
    await checkAllAbi(ETH_CHAIN_ID, proxyInfo);
    await checkAllAbi(ETH_CHAIN_ID, implementationInfo);
    flushAbiUpdates();

    const store = readStore(directory);
    assert.deepEqual(store[scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)], {
      name: "OssifiableProxy",
      abi: PROXY_ABI,
    });
    assert.deepEqual(store[scopedKey(ETH_CHAIN_ID, IMPL_ADDRESS)], { name: "Lido", abi: LIDO_ABI });
    assert.equal(Object.keys(store).length, 2);

    // ABIs downloaded in this run are immediately usable for checks
    assert.deepEqual(loadAbiFromFile(ETH_CHAIN_ID, "Lido", IMPL_ADDRESS), LIDO_ABI);
  });

  it("keeps an existing proxy ABI and saves its implementation fetched separately", async () => {
    const directory = setupConfigDirectory({
      [scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)]: { name: "OssifiableProxy", abi: PROXY_ABI },
    });
    const differentAbi: Abi = [{ type: "function", name: "other", inputs: [], stateMutability: "view" }];
    await checkAllAbi(ETH_CHAIN_ID, { ...proxyInfo, abi: differentAbi });
    await checkAllAbi(ETH_CHAIN_ID, implementationInfo);
    flushAbiUpdates();

    const store = readStore(directory);
    assert.deepEqual(store[scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)].abi, PROXY_ABI);
    assert.deepEqual(store[scopedKey(ETH_CHAIN_ID, IMPL_ADDRESS)], { name: "Lido", abi: LIDO_ABI });
  });

  it("re-downloads an existing entry with --update-abi", async () => {
    const directory = setupConfigDirectory({
      [scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)]: { name: "OssifiableProxy", abi: PROXY_ABI },
    });
    const freshAbi: Abi = [{ type: "function", name: "fresh", inputs: [], stateMutability: "view" }];
    context.updateAbi = true;

    await checkAllAbi(ETH_CHAIN_ID, { ...proxyInfo, abi: freshAbi });
    flushAbiUpdates();

    assert.deepEqual(readStore(directory)[scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)].abi, freshAbi);
  });

  it("drops entries the run did not walk when rebuilding with --update-abi", async () => {
    const directory = setupConfigDirectory({
      [scopedKey(ETH_CHAIN_ID, CROSS_CHAIN_ADDRESS)]: { name: "Orphan", abi: WORMHOLE_ABI },
    });
    context.updateAbi = true;

    await checkAllAbi(ETH_CHAIN_ID, proxyInfo);
    await checkAllAbi(ETH_CHAIN_ID, implementationInfo);
    flushAbiUpdates();
    pruneAbiStores();

    const store = readStore(directory);
    assert.deepEqual(
      new Set(Object.keys(store)),
      new Set([scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS), scopedKey(ETH_CHAIN_ID, IMPL_ADDRESS)]),
    );
  });

  it("keeps what an earlier config in the same directory rebuilt", async () => {
    const directory = setupConfigDirectory({
      [scopedKey(ETH_CHAIN_ID, CROSS_CHAIN_ADDRESS)]: { name: "Orphan", abi: WORMHOLE_ABI },
    });
    context.updateAbi = true;

    await checkAllAbi(ETH_CHAIN_ID, proxyInfo);
    await checkAllAbi(ETH_CHAIN_ID, implementationInfo);
    flushAbiUpdates();
    // the next config of a directory run: same store, its own addresses
    resetAbiCache();
    await checkAllAbi(BSC_CHAIN_ID, {
      contractName: "WormholeTransceiver",
      address: BSC_PROXY_ADDRESS,
      abi: WORMHOLE_ABI,
    });
    flushAbiUpdates();
    pruneAbiStores();

    const store = readStore(directory);
    assert.equal(store[scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)].name, "OssifiableProxy");
    assert.equal(store[scopedKey(BSC_CHAIN_ID, BSC_PROXY_ADDRESS)].name, "WormholeTransceiver");
    assert.equal(store[scopedKey(ETH_CHAIN_ID, CROSS_CHAIN_ADDRESS)], undefined);
  });

  it("keeps an entry the explorer refuses to serve when a later config of the directory walks it", async () => {
    const directory = setupConfigDirectory({
      [scopedKey(BSC_CHAIN_ID, BSC_PROXY_ADDRESS)]: { name: "SignatureRedeemQueue", abi: LIDO_ABI },
    });
    context.updateAbi = true;

    // first config of the directory downloads its own addresses
    await checkAllAbi(ETH_CHAIN_ID, proxyInfo);
    await checkAllAbi(ETH_CHAIN_ID, implementationInfo);
    flushAbiUpdates();
    // second config walks an address the explorer no longer serves
    resetAbiCache();
    assert.equal(keepStoredAbi(BSC_CHAIN_ID, BSC_PROXY_ADDRESS), "SignatureRedeemQueue");
    assert.equal(keepStoredAbi(BSC_CHAIN_ID, PROXY_ADDRESS), undefined);
    flushAbiUpdates();
    pruneAbiStores();

    const store = readStore(directory);
    assert.equal(store[scopedKey(BSC_CHAIN_ID, BSC_PROXY_ADDRESS)].name, "SignatureRedeemQueue");
    assert.equal(store[scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)].name, "OssifiableProxy");
  });

  it("stores different ABIs for the same address on different chains", async () => {
    const directory = setupConfigDirectory();

    await checkAllAbi(ETH_CHAIN_ID, {
      contractName: "ERC1967Proxy",
      address: CROSS_CHAIN_ADDRESS,
      abi: PROXY_ABI,
    });
    await checkAllAbi(BSC_CHAIN_ID, {
      contractName: "ERC1967Proxy",
      address: BSC_PROXY_ADDRESS,
      abi: PROXY_ABI,
    });
    await checkAllAbi(BSC_CHAIN_ID, {
      contractName: "WormholeTransceiver",
      address: CROSS_CHAIN_ADDRESS,
      abi: WORMHOLE_ABI,
    });
    flushAbiUpdates();

    const store = readStore(directory);
    assert.deepEqual(store[scopedKey(ETH_CHAIN_ID, CROSS_CHAIN_ADDRESS)], {
      name: "ERC1967Proxy",
      abi: PROXY_ABI,
    });
    assert.deepEqual(store[scopedKey(BSC_CHAIN_ID, CROSS_CHAIN_ADDRESS)], {
      name: "WormholeTransceiver",
      abi: WORMHOLE_ABI,
    });
    assert.deepEqual(loadAbiFromFile(ETH_CHAIN_ID, "ERC1967Proxy", CROSS_CHAIN_ADDRESS), PROXY_ABI);
    assert.deepEqual(loadAbiFromFile(BSC_CHAIN_ID, "WormholeTransceiver", CROSS_CHAIN_ADDRESS), WORMHOLE_ABI);
  });

  it("does not create the store file when nothing was staged", () => {
    const directory = setupConfigDirectory();
    flushAbiUpdates();
    assert.equal(fs.existsSync(path.join(directory, "abis.json.gz")), false);
  });
});

describe("checks ABI resolution", () => {
  class ProbeValidator extends SectionValidatorBase {
    override async validateSection(): Promise<void> {}
    resolve(entry: ContractEntry): Abi {
      return this._loadContractAbi(entry);
    }
  }
  const validator = new ProbeValidator(new JsonRpcProvider("http://localhost:1"), EntryField.checks, ETH_CHAIN_ID);

  it("uses the implementation ABI for a proxy entry", () => {
    setupConfigDirectory({
      [scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)]: { name: "OssifiableProxy", abi: PROXY_ABI },
      [scopedKey(ETH_CHAIN_ID, IMPL_ADDRESS)]: { name: "Lido", abi: LIDO_ABI },
    });
    const proxyEntry = {
      name: "Lido",
      address: PROXY_ADDRESS,
      proxyName: "OssifiableProxy",
      implementation: IMPL_ADDRESS,
      checks: {},
      implementationChecks: {},
    } as unknown as ContractEntry;
    assert.deepEqual(validator.resolve(proxyEntry), LIDO_ABI);
  });

  it("uses the contract's own ABI for a regular entry", () => {
    setupConfigDirectory({ [scopedKey(ETH_CHAIN_ID, IMPL_ADDRESS)]: { name: "Lido", abi: LIDO_ABI } });
    const regularEntry = { name: "Lido", address: IMPL_ADDRESS, checks: {} } as unknown as ContractEntry;
    assert.deepEqual(validator.resolve(regularEntry), LIDO_ABI);
  });
});

describe("tuple checks", () => {
  class ProbeValidator extends SectionValidatorBase {
    override async validateSection(): Promise<void> {}
    check(contract: unknown, method: string, expected: unknown): Promise<void> {
      return this._checkViewFunction(contract as never, method, { result: expected } as never);
    }
  }
  const validator = new ProbeValidator(new JsonRpcProvider("http://localhost:1"), EntryField.checks, ETH_CHAIN_ID);
  const contractReturning = (value: unknown) => ({ getFunction: () => ({ staticCall: async () => value }) }) as unknown;

  it("skips tuple elements pinned as null and verifies the rest", async () => {
    resetStats();
    await validator.check(contractReturning([250n, 1n, 240n, 247n, 250n]), "limits", [250, 1, 240, null, null]);
    assert.equal(stats.errors, 0);
    assert.equal(stats.totalChecks, 1);
  });

  it("still fails when a pinned tuple element drifts", async () => {
    resetStats();
    await validator.check(contractReturning([250n, 2n, 240n, 247n, 250n]), "limits", [250, 1, 240, null, null]);
    assert.equal(stats.errors, 1);
  });
});

it("keeps repository ABI archives chain-scoped", () => {
  const archives = findAbiArchives(path.resolve(__dirname, "../configs"));
  assert.ok(archives.length > 0);

  for (const archive of archives) {
    const store = JSON.parse(zlib.gunzipSync(fs.readFileSync(archive)).toString("utf8")) as Record<string, unknown>;
    for (const key of Object.keys(store)) {
      assert.match(key, /^\d+:0x[\da-f]{40}$/, `${archive} contains an invalid ABI key: ${key}`);
    }
  }
});
