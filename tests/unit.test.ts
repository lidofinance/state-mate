import assert from "node:assert/strict";
import test from "node:test";

import { getNonMutables, printError, readUrlOrFromEnvironment } from "../src/common";
import { ExplorerSectionTB, isTypeOfTB, NetworkSectionTB, SeedDocumentTB, StaticCallCheckTB } from "../src/typebox";
import { isCommonResponseOkResult, isResponseBad, isResponseOk, isValidAbi, type Abi } from "../src/types";

const ADDRESS = "0x0000000000000000000000000000000000000001";

test("getNonMutables returns non-mutating functions with argument counts", () => {
  const abi = [
    {
      type: "function",
      name: "balanceOf",
      stateMutability: "view",
      inputs: [{ type: "address", name: "account" }],
    },
    {
      type: "function",
      name: "DOMAIN_SEPARATOR",
      stateMutability: "pure",
      inputs: [],
    },
    {
      type: "function",
      name: "transfer",
      stateMutability: "nonpayable",
      inputs: [{ type: "address", name: "to" }],
    },
    {
      type: "function",
      name: "deposit",
      stateMutability: "payable",
      inputs: [],
    },
    {
      type: "event",
      name: "Transfer",
      stateMutability: "nonpayable",
      inputs: [],
    },
    {
      type: "function",
      stateMutability: "view",
    },
  ] as unknown as Abi;

  assert.deepEqual(getNonMutables(abi), [
    { name: "balanceOf", numArgs: 1 },
    { name: "DOMAIN_SEPARATOR", numArgs: 0 },
    { name: "", numArgs: 0 },
  ]);
});

test("printError returns a stable message for errors and non-errors", () => {
  assert.equal(printError(new Error("boom")), "boom");
  assert.equal(printError("plain failure"), "plain failure");
});

test("readUrlOrFromEnvironment accepts direct URLs and environment variable names", (context) => {
  const environmentKey = "STATE_MATE_UNIT_TEST_RPC_URL";
  const previousValue = process.env[environmentKey];

  context.after(() => {
    if (previousValue === undefined) {
      delete process.env[environmentKey];
    } else {
      process.env[environmentKey] = previousValue;
    }
  });

  process.env[environmentKey] = "http://localhost:8545";

  assert.equal(readUrlOrFromEnvironment("https://rpc.example.test"), "https://rpc.example.test");
  assert.equal(readUrlOrFromEnvironment(environmentKey), "http://localhost:8545");
});

test("ABI guards accept valid ABI fragments and reject invalid input", () => {
  assert.equal(
    isValidAbi([
      { type: "function", name: "owner", stateMutability: "view", inputs: [] },
      { type: "event", name: "OwnershipTransferred", inputs: [] },
    ]),
    true,
  );
  assert.equal(isValidAbi([{ type: 12, name: "owner" }]), false);
  assert.equal(isValidAbi("[]"), false);
});

test("explorer response guards distinguish ok, common result, and bad responses", () => {
  const okResponse = {
    status: "1",
    message: "OK",
    result: [{ ContractName: "Token", ABI: "[]" }],
  };

  assert.equal(isResponseOk(okResponse), true);
  assert.equal(isCommonResponseOkResult(okResponse.result[0]), true);
  assert.equal(isResponseOk({ ...okResponse, result: "[]" }), false);
  assert.equal(isCommonResponseOkResult({ ContractName: "Token", ABI: [] }), false);
  assert.equal(isResponseBad({ status: "0", message: "NOTOK", result: "Contract source code not verified" }), true);
  assert.equal(isResponseBad({ status: "0", message: "NOTOK", result: [] }), false);
});

test("typebox schemas validate static calls and reject extra properties", () => {
  assert.equal(isTypeOfTB({ result: ["0x1234", [1, null], [["nested"]]] }, StaticCallCheckTB), true);
  assert.equal(isTypeOfTB({ mustRevert: true, args: [ADDRESS] }, StaticCallCheckTB), true);
  assert.equal(isTypeOfTB({ mustRevert: true, result: null }, StaticCallCheckTB), false);
  assert.equal(isTypeOfTB({ result: [], unexpected: true }, StaticCallCheckTB), false);
});

test("typebox schemas validate seed and network sections", () => {
  assert.equal(isTypeOfTB({ rpcUrl: "RPC_URL", chainId: "1" }, ExplorerSectionTB), true);
  assert.equal(isTypeOfTB({ rpcUrl: "RPC_URL", unknown: true }, ExplorerSectionTB), false);

  assert.equal(
    isTypeOfTB(
      {
        deployed: { l1: [ADDRESS] },
        l1: { rpcUrl: "RPC_URL" },
      },
      SeedDocumentTB,
    ),
    true,
  );

  assert.equal(
    isTypeOfTB(
      {
        rpcUrl: "https://rpc.example.test",
        contracts: {
          token: {
            name: "Token",
            address: ADDRESS,
            checks: {
              totalSupply: "1000",
            },
          },
        },
      },
      NetworkSectionTB,
    ),
    true,
  );
});
