import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

import { DEFAULT_USER_AGENT, loadContractInfo, resetRequestSlots } from "../src/explorer";
import type { Abi } from "../src/types";
import { mockFetch } from "./helpers/fetch-mock";

const ADDRESS = "0x2bd3d5965b26b51814ac95127b2b80dd6ccc0fa1";
const BLOCKSCOUT_HOST = "robinhoodchain.blockscout.com";
const IRM_ABI: Abi = [{ type: "function", name: "borrowRateView", inputs: [], stateMutability: "view" }];

// the invoking shell may carry the override; the header test asserts the default
delete process.env.STATE_MATE_USER_AGENT;

beforeEach(() => {
  resetRequestSlots();
});

describe("blockscout v2 ABI download", () => {
  it("asks a blockscout host through /api/v2/smart-contracts and reads the ABI array", async () => {
    const fetchMock = mockFetch(() => ({ body: { name: "AdaptiveCurveIrm", is_verified: true, abi: IRM_ABI } }));
    try {
      const contract = await loadContractInfo(ADDRESS, BLOCKSCOUT_HOST);
      assert.equal(
        String(fetchMock.mock.calls[0].arguments[0]),
        `https://${BLOCKSCOUT_HOST}/api/v2/smart-contracts/${ADDRESS}`,
      );
      assert.deepEqual(contract, { abi: IRM_ABI, address: ADDRESS, contractName: "AdaptiveCurveIrm" });
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("accepts the documented form where the ABI arrives as a JSON string", async () => {
    const fetchMock = mockFetch(() => ({
      body: { name: "AdaptiveCurveIrm", is_verified: true, abi: JSON.stringify(IRM_ABI) },
    }));
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
      const fetchMock = mockFetch(() => ({ body }));
      try {
        assert.equal(await loadContractInfo(ADDRESS, BLOCKSCOUT_HOST), undefined, `${label} must yield no contract`);
        assert.equal(fetchMock.mock.calls.length, 1, `${label} must not be retried`);
      } finally {
        fetchMock.mock.restore();
      }
    }
  });

  it("treats HTTP 404 as the final answer, with no second request", async () => {
    const fetchMock = mockFetch(() => ({ status: 404 }));
    try {
      assert.equal(await loadContractInfo(ADDRESS, BLOCKSCOUT_HOST), undefined);
      assert.equal(fetchMock.mock.calls.length, 1);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("retries HTTP 429 once and settles for what the retry serves", async () => {
    let calls = 0;
    const fetchMock = mockFetch(() =>
      ++calls === 1 ? { status: 429 } : { body: { name: "AdaptiveCurveIrm", is_verified: true, abi: IRM_ABI } },
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
    const fetchMock = mockFetch(() => ({ body: { name: "AdaptiveCurveIrm", is_verified: true, abi: IRM_ABI } }));
    try {
      await loadContractInfo(ADDRESS, BLOCKSCOUT_HOST);
      const headers = (fetchMock.mock.calls[0].arguments[1] as RequestInit | undefined)?.headers as Record<
        string,
        string
      >;
      assert.equal(headers["User-Agent"], DEFAULT_USER_AGENT);
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
      assert.equal(
        String(fetchMock.mock.calls[0].arguments[0]),
        `https://api.etherscan.io/v2/api?chainId=1&module=contract&action=getsourcecode&address=${ADDRESS}`,
      );
      assert.equal(contract?.contractName, "AdaptiveCurveIrm");
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("keeps other etherscan-compatible hosts on the legacy getsourcecode URL", async () => {
    const fetchMock = mockFetch(() => ({
      body: {
        status: "1",
        message: "OK",
        result: [{ ABI: JSON.stringify(IRM_ABI), ContractName: "AdaptiveCurveIrm" }],
      },
    }));
    try {
      const contract = await loadContractInfo(ADDRESS, "api.bscscan.com");
      assert.equal(
        String(fetchMock.mock.calls[0].arguments[0]),
        `https://api.bscscan.com/api?module=contract&action=getsourcecode&address=${ADDRESS}`,
      );
      assert.equal(contract?.contractName, "AdaptiveCurveIrm");
    } finally {
      fetchMock.mock.restore();
    }
  });
});
