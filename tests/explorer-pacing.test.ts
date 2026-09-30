import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import {
  fetchExplorerChainId,
  httpGetAsync,
  learnRateLimit,
  loadContractInfo,
  resetRequestSlots,
} from "../src/explorer";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const URL_A = "https://one.example/api";
const URL_B = "https://two.example/api";

beforeEach(() => {
  resetRequestSlots();
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
});

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
  resetRequestSlots();
});

describe("explorer HTTP scheduling", () => {
  it("reschedules an already queued batch after numeric Retry-After", async () => {
    const times: number[] = [];
    mock.method(globalThis, "fetch", async () => {
      times.push(Date.now());
      return times.length === 1
        ? new Response("", { status: 429, headers: { "retry-after": "30" } })
        : Response.json({});
    });
    const first = httpGetAsync(URL_A).catch((error: unknown) => error);
    const second = httpGetAsync(URL_A);
    const third = httpGetAsync(URL_A);
    await flush();
    assert.ok((await first) instanceof Error);
    mock.timers.tick(334);
    await flush();
    assert.deepEqual(times, [1_000_000]);
    mock.timers.tick(29_666);
    await flush();
    await second;
    assert.deepEqual(times, [1_000_000, 1_030_000]);
    mock.timers.tick(334);
    await third;
    assert.deepEqual(times, [1_000_000, 1_030_000, 1_030_334]);
  });

  it("honors an HTTP-date Retry-After for waiting requests", async () => {
    const times: number[] = [];
    mock.method(globalThis, "fetch", async () => {
      times.push(Date.now());
      return times.length === 1
        ? new Response("", { status: 429, headers: { "retry-after": new Date(1_030_000).toUTCString() } })
        : Response.json({});
    });
    const first = httpGetAsync(URL_A).catch((error: unknown) => error);
    const second = httpGetAsync(URL_A);
    await first;
    mock.timers.tick(29_999);
    await flush();
    assert.deepEqual(times, [1_000_000]);
    mock.timers.tick(1);
    await second;
    assert.deepEqual(times, [1_000_000, 1_030_000]);
  });

  it("does not make another host wait for a throttled host", async () => {
    const sent: string[] = [];
    mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
      sent.push(String(url));
      return sent.length === 1
        ? new Response("", { status: 429, headers: { "retry-after": "30" } })
        : Response.json({});
    });
    const first = httpGetAsync(URL_A).catch((error: unknown) => error);
    const waiting = httpGetAsync(URL_A);
    await first;
    await httpGetAsync(URL_B);
    assert.deepEqual(sent, [URL_A, URL_B]);
    mock.timers.tick(30_000);
    await waiting;
    assert.deepEqual(sent, [URL_A, URL_B, URL_A]);
  });

  it("honors an explicit server cooldown longer than the default spacing", () => {
    assert.equal(learnRateLimit(URL_A, new Headers({ "retry-after": "120" })), 120_000);
  });
});

it("honors Blockscout reset milliseconds but not GitHub epoch seconds", () => {
  assert.equal(
    learnRateLimit(URL_A, new Headers({ "bypass-429-option": "no_bypass", "x-ratelimit-reset": "273095" })),
    273095,
  );
  assert.equal(learnRateLimit(URL_B, new Headers({ "x-ratelimit-reset": "1790776800" })), 6000);
  assert.equal(
    learnRateLimit(
      URL_B,
      new Headers({ "bypass-429-option": "no_bypass", "x-ratelimit-reset": "273095" }),
      Date.now(),
      500,
    ),
    6000,
  );
});

it("rejects an excessive cooldown without poisoning the host queue", async () => {
  assert.throws(() => learnRateLimit(URL_A, new Headers({ "retry-after": "9999999999" })), /budget/);
  mock.method(globalThis, "fetch", async () => Response.json({ ok: true }));
  assert.deepEqual(await httpGetAsync(URL_A), { ok: true });
});

it("rejects non-decimal Retry-After values", () => {
  for (const value of ["1e9", "+120", "1_20", "120.5"]) {
    resetRequestSlots();
    assert.equal(learnRateLimit(URL_A, new Headers({ "retry-after": value })), 6000);
  }
});

it("interprets obsolete HTTP dates as UTC", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    const now = Date.UTC(2026, 8, 30, 14, 0);
    assert.equal(learnRateLimit(URL_A, new Headers({ "retry-after": "Wed Sep 30 14:02:00 2026" }), now), 120000);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

it("does not persist exponential spacing after a cooldown", async () => {
  const times: number[] = [];
  mock.method(globalThis, "fetch", async () => {
    times.push(Date.now());
    return Response.json({});
  });
  learnRateLimit(URL_A, new Headers({ "retry-after": "1" }));
  const first = httpGetAsync(URL_A);
  await flush();
  mock.timers.tick(1000);
  await first;
  const second = httpGetAsync(URL_A);
  await flush();
  mock.timers.tick(334);
  await flush();
  assert.deepEqual(times, [1001000, 1001334]);
  await second;
});

it("bounds a queued request after the host extends its cooldown and releases the queue", async () => {
  const url = "https://api.etherscan.io/v2/api";
  let calls = 0;
  mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1 ? new Response("", { status: 429, headers: { "retry-after": "200" } }) : Response.json({});
  });
  const first = httpGetAsync(url).catch((error: unknown) => error);
  const waiting = httpGetAsync(url).catch((error: unknown) => error);
  await first;
  mock.timers.tick(150000);
  await flush();
  learnRateLimit(url, new Headers({ "retry-after": "160" }));
  mock.timers.tick(50000);
  await flush();
  assert.match(String(await waiting), /budget/);
  assert.equal(calls, 1);
  const next = httpGetAsync(url);
  await flush();
  mock.timers.tick(110000);
  await next;
  assert.equal(calls, 2);
});

it("shares the wait budget across the ABI download's single retry", async () => {
  let calls = 0;
  const host = "api.etherscan.io";
  mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("", { status: 429, headers: { "retry-after": "200" } });
  });
  const result = loadContractInfo("0x0000000000000000000000000000000000000001", host, undefined, 1);
  await flush();
  mock.timers.tick(150000);
  learnRateLimit(`https://${host}/api`, new Headers({ "retry-after": "160" }));
  mock.timers.tick(50000);
  await flush();
  assert.equal(await result, undefined);
  assert.equal(calls, 1);
});

it("leaves the ABI unresolved when the retry delay exceeds the remaining budget", async () => {
  const host = "api.etherscan.io";
  let calls = 0;
  mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("", { status: 429, headers: { "retry-after": "290" } });
  });
  learnRateLimit(`https://${host}/v2/api`, new Headers({ "retry-after": "20" }));
  const result = loadContractInfo("0x0000000000000000000000000000000000000001", host, "key", 1);
  await flush();
  mock.timers.tick(20000);
  await flush();
  assert.equal(await result, undefined);
  assert.equal(calls, 1);
});

it("stops the chain-id probe on a cooldown beyond the budget", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("", { status: 429, headers: { "retry-after": "3600" } });
  });
  assert.equal(await fetchExplorerChainId("one.example"), undefined);
  assert.equal(calls, 1);
});
