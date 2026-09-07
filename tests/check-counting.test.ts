import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Contract, JsonRpcProvider } from "ethers";

import { EntryField } from "../src/common";
import { context, resetStats, stats } from "../src/context";
import { resetContractCounters, setErrorContext } from "../src/section-validators/base";
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
