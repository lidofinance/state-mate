import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import packageJson from "../package.json";
import {
  createProvider,
  DEFAULT_USER_AGENT,
  fetchExplorerChainId,
  httpGetAsync,
  isTransientExplorerHttpError,
  loadContractInfo,
  resetRequestSlots,
  userAgent,
} from "../src/explorer";
import { mockFetch } from "./helpers/fetch-mock";

const ADDRESS = "0x2bd3d5965b26b51814ac95127b2b80dd6ccc0fa1";
const BLOCKSCOUT_HOST = "robinhoodchain.blockscout.com";

// the invoking shell may carry the override; default-value tests must not depend on it
delete process.env.STATE_MATE_USER_AGENT;

type FetchCall = { arguments: Parameters<typeof fetch> };

function headerOf(call: FetchCall | undefined, name: string): string | undefined {
  const headers = (call?.arguments[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined;
  if (!headers) return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

beforeEach(() => {
  resetRequestSlots();
});

afterEach(() => {
  delete process.env.STATE_MATE_USER_AGENT;
});

describe("user agent", () => {
  it("defaults to a browser prefix with the state-mate token in the tail", () => {
    assert.match(DEFAULT_USER_AGENT, /^Mozilla\/5\.0/);
    assert.ok(DEFAULT_USER_AGENT.endsWith(` state-mate/${packageJson.version}`));
    assert.equal(userAgent(), DEFAULT_USER_AGENT);
  });

  it("honors the STATE_MATE_USER_AGENT override", () => {
    process.env.STATE_MATE_USER_AGENT = "custom-agent/1.2.3";
    assert.equal(userAgent(), "custom-agent/1.2.3");
  });

  it("falls back to the default when the override is blank", () => {
    process.env.STATE_MATE_USER_AGENT = "   ";
    assert.equal(userAgent(), DEFAULT_USER_AGENT);
  });
});

describe("explorer request headers", () => {
  it("sends the User-Agent on ABI requests", async () => {
    const fetchMock = mockFetch(() => ({ body: { result: "0x1" } }));
    try {
      await httpGetAsync("https://robinhoodchain.blockscout.com/api?module=contract&action=getabi");
      assert.equal(headerOf(fetchMock.mock.calls[0], "User-Agent"), DEFAULT_USER_AGENT);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("sends the overridden User-Agent on ABI requests", async () => {
    process.env.STATE_MATE_USER_AGENT = "custom-agent/1.2.3";
    const fetchMock = mockFetch(() => ({ body: { result: "0x1" } }));
    try {
      await httpGetAsync("https://robinhoodchain.blockscout.com/api?module=contract&action=getabi");
      assert.equal(headerOf(fetchMock.mock.calls[0], "User-Agent"), "custom-agent/1.2.3");
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("sends the User-Agent on the Blockscout chain-id probe", async () => {
    const fetchMock = mockFetch(() => ({ body: { result: "0x1237" } }));
    try {
      assert.equal(await fetchExplorerChainId(BLOCKSCOUT_HOST), "4663");
      const probe = fetchMock.mock.calls.find((call) => String(call.arguments[0]).endsWith("/api/eth-rpc"));
      assert.equal(headerOf(probe, "User-Agent"), DEFAULT_USER_AGENT);
      assert.equal(headerOf(probe, "Content-Type"), "application/json");
    } finally {
      fetchMock.mock.restore();
    }
  });
});

describe("explorer challenges", () => {
  it("reports a challenge as a short non-transient error naming the override", async () => {
    const fetchMock = mockFetch(() => ({ status: 403, headers: { "cf-mitigated": "challenge" } }));
    try {
      await assert.rejects(httpGetAsync("https://robinhoodchain.blockscout.com/api"), (error: unknown) => {
        assert.match((error as Error).message, /STATE_MATE_USER_AGENT/);
        assert.equal(isTransientExplorerHttpError(error), false);
        return true;
      });
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("treats a bare 403 without the challenge marker as a challenge too", async () => {
    const fetchMock = mockFetch(() => ({ status: 403 }));
    try {
      await assert.rejects(httpGetAsync("https://robinhoodchain.blockscout.com/api"), /STATE_MATE_USER_AGENT/);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("propagates a challenge from the chain-id probe", async () => {
    const fetchMock = mockFetch(() => ({ status: 403, headers: { "cf-mitigated": "challenge" } }));
    try {
      await assert.rejects(fetchExplorerChainId(BLOCKSCOUT_HOST), /STATE_MATE_USER_AGENT/);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("propagates a challenge from the chain-id fallback route", async () => {
    const fetchMock = mockFetch((url) =>
      url.endsWith("/api/eth-rpc") ? { status: 400 } : { status: 403, headers: { "cf-mitigated": "challenge" } },
    );
    try {
      await assert.rejects(fetchExplorerChainId(BLOCKSCOUT_HOST), /STATE_MATE_USER_AGENT/);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("propagates a challenge from an ABI download instead of skipping the address", async () => {
    const fetchMock = mockFetch(() => ({ status: 403, headers: { "cf-mitigated": "challenge" } }));
    try {
      await assert.rejects(loadContractInfo(ADDRESS, BLOCKSCOUT_HOST), /STATE_MATE_USER_AGENT/);
      assert.equal(fetchMock.mock.calls.length, 1, "a challenge must not be retried");
    } finally {
      fetchMock.mock.restore();
    }
  });
});

describe("rpc provider", () => {
  it("carries the User-Agent on RPC requests", () => {
    const provider = createProvider("http://localhost:8545");
    try {
      assert.equal(provider._getConnection().getHeader("user-agent"), DEFAULT_USER_AGENT);
    } finally {
      provider.destroy();
    }
  });
});
