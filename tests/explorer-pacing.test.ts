import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { httpGetAsync, learnRateLimit, resetRequestSlots } from "../src/explorer";

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
    mock.timers.tick(668);
    await third;
    assert.deepEqual(times, [1_000_000, 1_030_000, 1_030_668]);
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

  it("does not cap an explicit server cooldown at the adaptive interval limit", () => {
    assert.equal(learnRateLimit(URL_A, new Headers({ "retry-after": "120" })), 120_000);
  });
});
