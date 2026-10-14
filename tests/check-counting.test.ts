import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { type Contract, Contract as EthersContract, JsonRpcProvider } from "ethers";

import { EntryField } from "../src/common";
import { context, resetStats, stats } from "../src/context";
import { resetContractCounters, setErrorContext } from "../src/section-validators/base";
import { ChecksSectionValidator } from "../src/section-validators/checks";
import type { StaticCallCheck } from "../src/typebox";
import { callError, NO_STATE, REVERT } from "./helpers/rpc-errors";

// A null result never reaches the chain; a mustRevert entry needs a function that reverts
const CONTRACT = {
  getFunction: () => ({
    staticCall: () => Promise.reject(callError(REVERT)),
  }),
} as unknown as Contract;

class ExposedChecks extends ChecksSectionValidator {
  public run(method: string, check: StaticCallCheck) {
    return this._checkViewFunction(CONTRACT, method, check);
  }
}

describe("check accounting", () => {
  const validator = new ExposedChecks({} as JsonRpcProvider, 1, EntryField.checks);

  beforeEach(() => {
    resetStats();
    resetContractCounters();
  });

  it("does not count a method the config left unpinned as a passed check", async () => {
    await validator.run("getSomething", { result: null } as unknown as StaticCallCheck);

    assert.deepEqual({ checks: stats.totalChecks, skipped: stats.skipped }, { checks: 0, skipped: 1 });
  });

  it("keeps the two tallies apart across a mix of pinned and unpinned methods", async () => {
    await validator.run("a", { result: null } as unknown as StaticCallCheck);
    await validator.run("b", { result: null } as unknown as StaticCallCheck);
    await validator.run("c", { mustRevert: true } as unknown as StaticCallCheck);

    assert.deepEqual(
      { checks: stats.totalChecks, skipped: stats.skipped, errors: stats.errors },
      { checks: 1, skipped: 2, errors: 0 },
    );
  });
});

describe("filter selection accounting", () => {
  const validator = new ExposedChecks({} as JsonRpcProvider, 1, EntryField.checks);

  beforeEach(() => {
    resetStats();
    resetContractCounters();
    context.checkOnly = { section: "l1", contract: "vault", checksType: "checks", method: "ownre" };
  });

  afterEach(() => {
    context.checkOnly = null;
  });

  it("does not let an automatic check stand in for a method the filter named", async () => {
    setErrorContext({ checksType: "proxyAdmin" });
    await validator.run("proxyAdmin", { mustRevert: true } as unknown as StaticCallCheck);

    assert.deepEqual({ checks: stats.totalChecks, selected: stats.selected }, { checks: 1, selected: 0 });
  });

  it("counts a check under the named checks type as selected, skipped ones included", async () => {
    setErrorContext({ checksType: "checks" });
    await validator.run("owner", { mustRevert: true } as unknown as StaticCallCheck);
    await validator.run("nonce", { result: null } as unknown as StaticCallCheck);

    assert.equal(stats.selected, 2);
  });
});

describe("a mustRevert check", () => {
  const failingWith = (error: Error) =>
    ({ getFunction: () => ({ staticCall: () => Promise.reject(error) }) }) as unknown as Contract;

  class Exposed extends ChecksSectionValidator {
    public run(contract: Contract, method: string) {
      return this._checkViewFunction(contract, method, { mustRevert: true } as unknown as StaticCallCheck);
    }
  }

  const validator = new Exposed({} as JsonRpcProvider, 1, EntryField.checks);

  beforeEach(() => {
    resetStats();
    resetContractCounters();
  });

  it("passes when the EVM reverts the call", async () => {
    await validator.run(failingWith(callError(REVERT)), "subvaultAt");

    assert.equal(stats.errors, 0);
  });

  it("passes on a halt the EVM made, however the node words it", async () => {
    const halts = {
      "geth and Erigon": [
        "invalid opcode: INVALID",
        "invalid opcode: opcode 0x5f not defined",
        "out of gas",
        "stack underflow (0 <=> 1)",
        "stack limit reached 1024 (1023)",
        "invalid jump destination",
        "write protection",
      ],
      "revm and reth": [
        "EVM error: InvalidFEOpcode",
        "EVM error: OpcodeNotFound",
        "EVM error: OutOfGas(Basic)",
        "EVM error: StackUnderflow",
        "EVM error: InvalidJump",
        "EVM error: StateChangeDuringStaticCall",
      ],
      Nethermind: ["invalid instruction", "bad instruction", "stack overflow", "static call violation"],
      Besu: ["INVALID_OPERATION", "INSUFFICIENT_GAS", "INSUFFICIENT_STACK_ITEMS", "ILLEGAL_STATE_CHANGE"],
    };
    for (const [client, messages] of Object.entries(halts)) {
      for (const message of messages) {
        await validator.run(failingWith(callError({ code: -32000, message })), "getTotalPooledEther");
        assert.equal(stats.errors, 0, `${client}: ${message}`);
      }
    }
  });

  it("passes when ethers refuses the call before it reaches a node, as before", async () => {
    const contract = new EthersContract(
      "0x0000000000000000000000000000000000000001",
      ["function renounceRole(bytes32 role, address account)"],
      new JsonRpcProvider("http://localhost:0", undefined, { staticNetwork: true }),
    );
    await validator.run(contract, "renounceRole");

    assert.equal(stats.errors, 0);
  });

  it("fails when the node refuses the request", async () => {
    await validator.run(
      failingWith(Object.assign(new Error("server response 403 Forbidden"), { code: "SERVER_ERROR" })),
      "observers",
    );

    assert.equal(stats.errors, 1);
  });

  it("fails when the node has no state to run the call at", async () => {
    // a node that kept the header of a pinned block but not its state refuses every eth_call
    await validator.run(failingWith(callError(NO_STATE)), "subvaultAt");

    assert.equal(stats.errors, 1);
    assert.match(stats.errorDetails[0].message, /historical state .* is not available/);
  });
});
