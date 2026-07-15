import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { loadContractInfoFromSourcify } from "../src/explorers/sourcify";

const PROXY = "0x5e362eB2c0706Bd1d134689eC75176018385430B";
const IMPL = "0x0000007563180C9066693110667e2232962D93a1";
const ABI = [{ name: "owner", type: "function", stateMutability: "view", inputs: [] }];

describe("loadContractInfoFromSourcify", () => {
  it("resolves a proxy to its implementation", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
      const isProxy = String(url).toLowerCase().includes(PROXY.toLowerCase());
      return {
        ok: true,
        json: async () =>
          isProxy
            ? {
                abi: ABI,
                compilation: { name: "TransparentUpgradeableProxy" },
                proxyResolution: { isProxy: true, implementations: [{ address: IMPL }] },
              }
            : {
                abi: ABI,
                compilation: { name: "DVV" },
                proxyResolution: { isProxy: false, implementations: [] },
              },
      } as Response;
    });

    try {
      const info = await loadContractInfoFromSourcify(PROXY, 56);
      assert.equal(info?.contractName, "TransparentUpgradeableProxy");
      assert.equal(info?.implementation?.contractName, "DVV");
      assert.equal(info?.implementation?.address, IMPL);
    } finally {
      fetchMock.mock.restore();
    }
  });
});
