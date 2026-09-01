import { mock } from "node:test";

type MockedResponse = { status?: number; body?: unknown; headers?: Record<string, string> };

/** Stubs global fetch for one test; the caller restores it via the returned mock's `.mock.restore()`. */
export function mockFetch(handler: (url: string) => MockedResponse) {
  return mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
    const { status = 200, body = {}, headers = {} } = handler(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `HTTP ${status}`,
      headers: new Headers(headers),
      json: async () => body,
    } as Response;
  });
}
