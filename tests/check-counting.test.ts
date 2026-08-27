import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Contract, JsonRpcProvider } from "ethers";

import { EntryField } from "../src/common";
import { resetStats, stats } from "../src/context";
import { resetContractCounters } from "../src/section-validators/base";
import { ChecksSectionValidator } from "../src/section-validators/checks";
import type { StaticCallCheck } from "../src/typebox";

// A null result never reaches the chain; a mustRevert entry needs a function that reverts
const CONTRACT = {
  getFunction: () => ({
    staticCall: () => Promise.reject(new Error("execution reverted")),
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
