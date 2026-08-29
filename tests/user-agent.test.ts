import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import packageJson from "../package.json";
import {
  createProvider,
  DEFAULT_USER_AGENT,
  fetchExplorerChainId,
  httpGetAsync,
  isTransientExplorerHttpError,
  userAgent,
} from "../src/explorer";

type Recorded = { url: string; init: RequestInit | undefined };

const originalFetch = globalThis.fetch;

// the invoking shell may carry the override; default-value tests must not depend on it
delete process.env.STATE_MATE_USER_AGENT;

function recordFetch(body: unknown): Recorded[] {
  const calls: Recorded[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => body,
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return calls;
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  if (!headers) return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
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
    const calls = recordFetch({ result: "0x1" });

    await httpGetAsync("https://robinhoodchain.blockscout.com/api?module=contract&action=getabi");

    assert.equal(headerValue(calls[0]?.init, "User-Agent"), DEFAULT_USER_AGENT);
  });

  it("sends the overridden User-Agent on ABI requests", async () => {
    process.env.STATE_MATE_USER_AGENT = "custom-agent/1.2.3";
    const calls = recordFetch({ result: "0x1" });

    await httpGetAsync("https://robinhoodchain.blockscout.com/api?module=contract&action=getabi");

    assert.equal(headerValue(calls[0]?.init, "User-Agent"), "custom-agent/1.2.3");
  });

  it("sends the User-Agent on the Blockscout chain-id probe", async () => {
    const calls = recordFetch({ result: "0x1237" });

    assert.equal(await fetchExplorerChainId("robinhoodchain.blockscout.com"), "4663");
    const probe = calls.find((call) => call.url.endsWith("/api/eth-rpc"));
    assert.equal(headerValue(probe?.init, "User-Agent"), DEFAULT_USER_AGENT);
    assert.equal(headerValue(probe?.init, "Content-Type"), "application/json");
  });

  it("reports a challenge as a short non-transient error naming the override", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        headers: new Headers({ "cf-mitigated": "challenge" }),
      }) as unknown as Response) as typeof globalThis.fetch;

    await assert.rejects(httpGetAsync("https://robinhoodchain.blockscout.com/api"), (error: unknown) => {
      assert.match((error as Error).message, /STATE_MATE_USER_AGENT/);
      assert.equal(isTransientExplorerHttpError(error), false);
      return true;
    });
  });

  it("propagates a challenge from the chain-id probe", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        headers: new Headers({ "cf-mitigated": "challenge" }),
      }) as unknown as Response) as typeof globalThis.fetch;

    await assert.rejects(fetchExplorerChainId("robinhoodchain.blockscout.com"), /STATE_MATE_USER_AGENT/);
  });

  it("propagates a challenge from the chain-id fallback route", async () => {
    globalThis.fetch = (async (url: unknown) =>
      ({
        ok: false,
        status: String(url).endsWith("/api/eth-rpc") ? 400 : 403,
        statusText: "Bad Request",
        headers: new Headers(String(url).endsWith("/api/eth-rpc") ? {} : { "cf-mitigated": "challenge" }),
      }) as unknown as Response) as typeof globalThis.fetch;

    await assert.rejects(fetchExplorerChainId("robinhoodchain.blockscout.com"), /STATE_MATE_USER_AGENT/);
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

describe("http layer boundary", () => {
  it("keeps direct fetch calls inside src/explorer.ts", () => {
    const sourceRoot = path.join(__dirname, "../src");
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && /\bfetch\s*\(/.test(readFileSync(full, "utf8"))) offenders.push(full);
      }
    };
    walk(sourceRoot);
    assert.deepEqual(
      offenders.map((file) => path.relative(sourceRoot, file)),
      ["explorer.ts"],
    );
  });
});
