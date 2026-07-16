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
  loadAbiFromFile,
  resetAbiCache,
} from "../src/abi-provider";
import { EntryField } from "../src/common";
import { context } from "../src/context";
import { fetchExplorerChainId } from "../src/explorer-provider";
import { SectionValidatorBase } from "../src/section-validators/base";
import * as stateMate from "../src/state-mate";
import { ContractEntry, SeedDocument } from "../src/typebox";
import { Abi, ContractInfo } from "../src/types";

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

  it("reads a legacy address-only entry", () => {
    setupConfigDirectory({ [PROXY_ADDRESS.toLowerCase()]: { name: "Lido", abi: LIDO_ABI } });
    assert.deepEqual(loadAbiFromFile(ETH_CHAIN_ID, "Lido", PROXY_ADDRESS), LIDO_ABI);
  });

  it("does not use a legacy entry as a fallback in a partially scoped store", () => {
    setupConfigDirectory({
      [PROXY_ADDRESS.toLowerCase()]: { name: "Lido", abi: LIDO_ABI },
      [scopedKey(ETH_CHAIN_ID, IMPL_ADDRESS)]: { name: "Lido", abi: LIDO_ABI },
    });
    const message = expectExit(() => loadAbiFromFile(BSC_CHAIN_ID, "Lido", PROXY_ADDRESS));
    assert.match(message, /ABI not found/);
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
      if (String(url).includes("chainlist")) {
        return { ok: true, json: async () => ({ result: [{ chainid: "1" }] }) } as Response;
      }
      if (/eth_gasPrice|eth-rpc|eth_chainId/.test(String(url))) {
        return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 83, result: "0x1" }) } as Response;
      }
      throw new Error("unexpected explorer request");
    });

    try {
      await stateMate.downloadAndCheckAllAbi({
        deployed: { l1: [PROXY_ADDRESS] },
        l1: { rpcUrl: "http://localhost:1", explorerHostname: "api.etherscan.io", chainId: 1 },
      } as SeedDocument);
      const sourceRequests = fetchMock.mock.calls.filter((c) => String(c.arguments[0]).includes("getsourcecode"));
      assert.equal(sourceRequests.length, 0);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("does not let an existing ABI in one chain suppress the same address in another chain", async () => {
    const directory = setupConfigDirectory({
      [scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)]: { name: "ERC1967Proxy", abi: PROXY_ABI },
    });
    const fetchMock = mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
      if (String(url).includes("chainlist")) {
        return { ok: true, json: async () => ({ result: [{ chainid: String(ETH_CHAIN_ID) }] }) } as Response;
      }
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
      } as SeedDocument);

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

describe("fetchExplorerChainId", () => {
  it("reports the explorer's chain as a decimal string", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 83, result: "0x38" }) } as Response;
    });
    try {
      assert.equal(await fetchExplorerChainId("api.bscscan.com", 56), "56");
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("returns undefined when the explorer cannot answer", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      return { ok: true, json: async () => ({ status: "0", message: "NOTOK", result: "Invalid API URL" }) } as Response;
    });
    try {
      assert.equal(await fetchExplorerChainId("api.bscscan.com", 56), undefined);
    } finally {
      fetchMock.mock.restore();
    }
  });
});

describe("checkAllAbi + flushAbiUpdates", () => {
  const contractInfo: ContractInfo = {
    contractName: "OssifiableProxy",
    address: PROXY_ADDRESS,
    abi: PROXY_ABI,
    implementation: { contractName: "Lido", address: IMPL_ADDRESS, abi: LIDO_ABI },
  };

  it("creates the store with proxy and implementation entries under chain-scoped lowercase keys", async () => {
    const directory = setupConfigDirectory();
    await checkAllAbi(ETH_CHAIN_ID, contractInfo);
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

  it("keeps an existing proxy ABI and saves its newly discovered implementation", async () => {
    const directory = setupConfigDirectory({
      [scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)]: { name: "OssifiableProxy", abi: PROXY_ABI },
    });
    const differentAbi: Abi = [{ type: "function", name: "other", inputs: [], stateMutability: "view" }];
    await checkAllAbi(ETH_CHAIN_ID, { ...contractInfo, abi: differentAbi });
    flushAbiUpdates();

    const store = readStore(directory);
    assert.deepEqual(store[scopedKey(ETH_CHAIN_ID, PROXY_ADDRESS)].abi, PROXY_ABI);
    assert.deepEqual(store[scopedKey(ETH_CHAIN_ID, IMPL_ADDRESS)], { name: "Lido", abi: LIDO_ABI });
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
      implementation: {
        contractName: "WormholeTransceiver",
        address: CROSS_CHAIN_ADDRESS,
        abi: WORMHOLE_ABI,
      },
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
