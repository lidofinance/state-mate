import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

import { DEFAULT_USER_AGENT, loadContractInfo, resetBlockscoutHostProbes, resetRequestSlots } from "../src/explorer";
import type { Abi } from "../src/types";
import { mockFetch } from "./helpers/fetch-mock";

const ADDRESS = "0x2bd3d5965b26b51814ac95127b2b80dd6ccc0fa1";
const BLOCKSCOUT_HOST = "robinhoodchain.blockscout.com";
const IRM_ABI: Abi = [{ type: "function", name: "borrowRateView", inputs: [], stateMutability: "view" }];
const PROBE_SUFFIX = "/api/v2/config/backend-version";
const PROBE_ANSWER = { body: { backend_version: "v11.2.8" } };

// the invoking shell may carry the override; the header test asserts the default
delete process.env.STATE_MATE_USER_AGENT;

beforeEach(() => {
  resetRequestSlots();
  resetBlockscoutHostProbes();
});

describe("blockscout v2 ABI download", () => {
  it("detects a blockscout host by probing /api/v2 and downloads through /api/v2/smart-contracts", async () => {
    const fetchMock = mockFetch((url) =>
      url.endsWith(PROBE_SUFFIX)
        ? PROBE_ANSWER
        : { body: { name: "AdaptiveCurveIrm", is_verified: true, abi: IRM_ABI } },
    );
    try {
      const contract = await loadContractInfo(ADDRESS, BLOCKSCOUT_HOST);
      assert.deepEqual(
        fetchMock.mock.calls.map((call) => String(call.arguments[0])),
        [`https://${BLOCKSCOUT_HOST}${PROBE_SUFFIX}`, `https://${BLOCKSCOUT_HOST}/api/v2/smart-contracts/${ADDRESS}`],
      );
      assert.deepEqual(contract, { abi: IRM_ABI, address: ADDRESS, contractName: "AdaptiveCurveIrm" });
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("treats a challenged probe as not-blockscout and lets the legacy route report the challenge", async () => {
    const fetchMock = mockFetch(() => ({ status: 403, headers: { "cf-mitigated": "challenge" } }));
    try {
      await assert.rejects(loadContractInfo(ADDRESS, BLOCKSCOUT_HOST), /STATE_MATE_USER_AGENT/);
      assert.deepEqual(
        fetchMock.mock.calls.map((call) => String(call.arguments[0])),
        [
          `https://${BLOCKSCOUT_HOST}${PROBE_SUFFIX}`,
          `https://${BLOCKSCOUT_HOST}/api?module=contract&action=getsourcecode&address=${ADDRESS}`,
        ],
        "a 403 on the probe alone must not outrank the legacy route",
      );
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("re-probes after a verdict built from flakes instead of pinning the legacy route", async () => {
    let probeCalls = 0;
    const fetchMock = mockFetch((url) => {
      if (url.endsWith(PROBE_SUFFIX)) return ++probeCalls <= 2 ? { status: 429 } : PROBE_ANSWER;
      if (url.includes("/api/v2/smart-contracts/"))
        return { body: { name: "AdaptiveCurveIrm", is_verified: true, abi: IRM_ABI } };
      return { body: { status: "0", message: "NOTOK", result: "legacy quota exhausted" } };
    });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pending = loadContractInfo(ADDRESS, BLOCKSCOUT_HOST);
      for (let round = 0; round < 12; round++) {
        await new Promise((resolve) => setImmediate(resolve));
        mock.timers.tick(7000);
      }
      const contract = await pending;
      assert.equal(probeCalls, 3, "the flaked verdict must not be memoized");
      assert.equal(contract?.contractName, "AdaptiveCurveIrm");
    } finally {
      mock.timers.reset();
      fetchMock.mock.restore();
    }
  });

  it("probes a host once and reuses the verdict", async () => {
    const fetchMock = mockFetch((url) =>
      url.endsWith(PROBE_SUFFIX)
        ? PROBE_ANSWER
        : { body: { name: "AdaptiveCurveIrm", is_verified: true, abi: IRM_ABI } },
    );
    try {
      await loadContractInfo(ADDRESS, BLOCKSCOUT_HOST);
      await loadContractInfo(ADDRESS, BLOCKSCOUT_HOST);
      const probes = fetchMock.mock.calls.filter((call) => String(call.arguments[0]).endsWith(PROBE_SUFFIX));
      assert.equal(probes.length, 1);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("accepts the documented form where the ABI arrives as a JSON string", async () => {
    const fetchMock = mockFetch((url) =>
      url.endsWith(PROBE_SUFFIX)
        ? PROBE_ANSWER
        : { body: { name: "AdaptiveCurveIrm", is_verified: true, abi: JSON.stringify(IRM_ABI) } },
    );
    try {
      const contract = await loadContractInfo(ADDRESS, BLOCKSCOUT_HOST);
      assert.deepEqual(contract, { abi: IRM_ABI, address: ADDRESS, contractName: "AdaptiveCurveIrm" });
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("rejects an answer without a usable ABI as final, with no second request", async () => {
    const rejected: Record<string, unknown> = {
      "a missing name": { is_verified: true, abi: IRM_ABI },
      "a missing ABI": { name: "AdaptiveCurveIrm", is_verified: false },
      "a malformed ABI string": { name: "AdaptiveCurveIrm", is_verified: true, abi: "not json [" },
      "an ABI of the wrong shape": { name: "AdaptiveCurveIrm", is_verified: true, abi: [42] },
    };
    for (const [label, body] of Object.entries(rejected)) {
      const fetchMock = mockFetch((url) => (url.endsWith(PROBE_SUFFIX) ? PROBE_ANSWER : { body }));
      try {
        assert.equal(await loadContractInfo(ADDRESS, BLOCKSCOUT_HOST), undefined, `${label} must yield no contract`);
        const abiCalls = fetchMock.mock.calls.filter((call) => !String(call.arguments[0]).endsWith(PROBE_SUFFIX));
        assert.equal(abiCalls.length, 1, `${label} must not be retried`);
      } finally {
        fetchMock.mock.restore();
      }
    }
  });

  it("treats HTTP 404 as the final answer, with no second request", async () => {
    const fetchMock = mockFetch((url) => (url.endsWith(PROBE_SUFFIX) ? PROBE_ANSWER : { status: 404 }));
    try {
      assert.equal(await loadContractInfo(ADDRESS, BLOCKSCOUT_HOST), undefined);
      const abiCalls = fetchMock.mock.calls.filter((call) => !String(call.arguments[0]).endsWith(PROBE_SUFFIX));
      assert.equal(abiCalls.length, 1);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("retries HTTP 429 once and settles for what the retry serves", async () => {
    let calls = 0;
    const fetchMock = mockFetch((url) =>
      url.endsWith(PROBE_SUFFIX)
        ? PROBE_ANSWER
        : ++calls === 1
          ? { status: 429 }
          : { body: { name: "AdaptiveCurveIrm", is_verified: true, abi: IRM_ABI } },
    );
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pending = loadContractInfo(ADDRESS, BLOCKSCOUT_HOST);
      for (let round = 0; round < 8; round++) {
        await new Promise((resolve) => setImmediate(resolve));
        mock.timers.tick(7000);
      }
      const contract = await pending;
      assert.equal(contract?.contractName, "AdaptiveCurveIrm");
      assert.equal(calls, 2);
    } finally {
      mock.timers.reset();
      fetchMock.mock.restore();
    }
  });

  it("sends the browser User-Agent to the v2 endpoint", async () => {
    const fetchMock = mockFetch((url) =>
      url.endsWith(PROBE_SUFFIX)
        ? PROBE_ANSWER
        : { body: { name: "AdaptiveCurveIrm", is_verified: true, abi: IRM_ABI } },
    );
    try {
      await loadContractInfo(ADDRESS, BLOCKSCOUT_HOST);
      for (const call of fetchMock.mock.calls) {
        const headers = (call.arguments[1] as RequestInit | undefined)?.headers as Record<string, string>;
        assert.equal(headers["User-Agent"], DEFAULT_USER_AGENT, String(call.arguments[0]));
      }
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("keeps etherscan on the v2 aggregator URL", async () => {
    const fetchMock = mockFetch(() => ({
      body: {
        status: "1",
        message: "OK",
        result: [{ ABI: JSON.stringify(IRM_ABI), ContractName: "AdaptiveCurveIrm" }],
      },
    }));
    try {
      const contract = await loadContractInfo(ADDRESS, "api.etherscan.io", undefined, 1);
      assert.deepEqual(
        fetchMock.mock.calls.map((call) => String(call.arguments[0])),
        [`https://api.etherscan.io/v2/api?chainId=1&module=contract&action=getsourcecode&address=${ADDRESS}`],
        "an etherscan host must not be probed",
      );
      assert.equal(contract?.contractName, "AdaptiveCurveIrm");
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("keeps a host that fails the probe on the legacy getsourcecode URL", async () => {
    const fetchMock = mockFetch((url) =>
      url.endsWith(PROBE_SUFFIX)
        ? { status: 404 }
        : {
            body: {
              status: "1",
              message: "OK",
              result: [{ ABI: JSON.stringify(IRM_ABI), ContractName: "AdaptiveCurveIrm" }],
            },
          },
    );
    try {
      const contract = await loadContractInfo(ADDRESS, "api.bscscan.com");
      assert.deepEqual(
        fetchMock.mock.calls.map((call) => String(call.arguments[0])),
        [
          `https://api.bscscan.com${PROBE_SUFFIX}`,
          `https://api.bscscan.com/api?module=contract&action=getsourcecode&address=${ADDRESS}`,
        ],
      );
      assert.equal(contract?.contractName, "AdaptiveCurveIrm");
    } finally {
      fetchMock.mock.restore();
    }
  });
});
