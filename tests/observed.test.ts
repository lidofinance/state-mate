import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Contract, JsonRpcProvider } from "ethers";
import { Result } from "ethers";
import * as YAML from "yaml";

import { EntryField } from "../src/common";
import { context, resetStats, stats } from "../src/context";
import type { ObservedCall } from "../src/observed";
import {
  beginObservedSection,
  buildObservedDocument,
  recordObservedCall,
  recordObservedStorage,
  resetObserved,
  toPlain,
  writeObservedFile,
} from "../src/observed";
import { resetContractCounters, setErrorContext } from "../src/section-validators/base";
import { ChecksSectionValidator } from "../src/section-validators/checks";
import type { StaticCallCheck } from "../src/typebox";

const POSITION = { section: "robinhood", contract: "vault", contractAddress: "0xVault", checksType: "checks" };

describe("observed values", () => {
  beforeEach(() => {
    resetObserved();
    context.json = true;
    context.observedPath = "state.observed.yaml";
  });

  afterEach(() => {
    context.json = false;
    context.observedPath = undefined;
  });

  it("keeps what the chain answered under the section, contract and method the config names", () => {
    beginObservedSection("robinhood", "46630", 65439916, true);
    recordObservedCall(POSITION, "marketIds", [0], { value: "0xaaa" });
    recordObservedCall(POSITION, "marketIds", [1n], { value: "0xbbb" });
    recordObservedCall(POSITION, "owner", undefined, { value: "0xOwner" });
    recordObservedCall(POSITION, "adapters", [9], { reverted: "execution reverted" });
    recordObservedCall({ ...POSITION, checksType: "proxyChecks" }, "proxy__getAdmin", [], { value: "0xAdmin" });
    recordObservedStorage({ ...POSITION, checksType: "storage" }, "0x00", "0x01");

    const document = buildObservedDocument("state.yaml");

    assert.equal(document.config, "state.yaml");
    assert.deepEqual(document.sections.robinhood, {
      chainId: "46630",
      block: 65439916,
      pinned: true,
      contracts: {
        vault: {
          address: "0xVault",
          checks: {
            marketIds: [
              { args: [0], value: "0xaaa" },
              { args: ["1"], value: "0xbbb" },
            ],
            owner: [{ value: "0xOwner" }],
            adapters: [{ args: [9], reverted: "execution reverted" }],
          },
          proxyChecks: { proxy__getAdmin: [{ value: "0xAdmin" }] },
          storage: { "0x00": "0x01" },
        },
      },
    });
  });

  it("names the hash of a section pinned by hash", () => {
    beginObservedSection("robinhood", "4663", 65439916, true, `0x${"ab".repeat(32)}`);
    const section = buildObservedDocument("state.yaml").sections.robinhood;
    assert.deepEqual(
      { block: section.block, blockHash: section.blockHash, pinned: section.pinned },
      { block: 65439916, blockHash: `0x${"ab".repeat(32)}`, pinned: true },
    );
  });

  it("keeps nothing without --observed, so a run does not hold every answer it asserted", () => {
    context.observedPath = undefined;
    beginObservedSection("robinhood", "4663", 1, false);
    recordObservedCall(POSITION, "owner", undefined, { value: "0x1" });
    recordObservedStorage({ ...POSITION, checksType: "storage" }, "0x00", "0x01");
    assert.deepEqual(buildObservedDocument("state.yaml").sections, {});
  });

  it("turns bigint, named and unnamed results into plain values", () => {
    assert.equal(toPlain(10n), "10");
    assert.deepEqual(toPlain(Result.fromItems([1n, "0xabc"], ["cap", "adapter"])), { cap: "1", adapter: "0xabc" });
    assert.deepEqual(toPlain(Result.fromItems([1n, [2n, true]])), ["1", ["2", true]]);
    assert.deepEqual(toPlain(Result.fromItems(["0xabc"], ["_"])), ["0xabc"]);
    assert.deepEqual(toPlain(Result.fromItems([])), []);
    assert.deepEqual(toPlain(Result.fromItems([Result.fromItems(["0xabc"], ["_"])], ["vaults"])), {
      vaults: ["0xabc"],
    });
    assert.deepEqual(toPlain([null, 3, "x", false]), [null, 3, "x", false]);
  });

  it("keeps a read whose section was never announced instead of dropping it", () => {
    recordObservedCall(POSITION, "owner", undefined, { value: "0x1" });

    const section = buildObservedDocument("cfg.yaml").sections.robinhood;
    assert.deepEqual({ block: section.block, pinned: section.pinned }, { block: null, pinned: false });
    assert.deepEqual(section.contracts.vault.checks, { owner: [{ value: "0x1" }] });
  });

  it("writes a YAML file that loads back, creating the directory it names", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "observed-"));
    const file = path.join(directory, "nested", "observed.yaml");
    beginObservedSection("l1", "1", 100, false);
    recordObservedCall({ ...POSITION, section: "l1" }, "totalSupply", undefined, { value: 5n });

    writeObservedFile(file, "cfg.yaml");

    const loaded = YAML.parse(fs.readFileSync(file, "utf8"));
    assert.equal(loaded.config, "cfg.yaml");
    assert.deepEqual(loaded.sections.l1.contracts.vault.checks.totalSupply, [{ value: "5" }]);
    assert.deepEqual(
      { block: loaded.sections.l1.block, pinned: loaded.sections.l1.pinned },
      { block: 100, pinned: false },
    );
    fs.rmSync(directory, { recursive: true });
  });
});

describe("a check the config declines to assert", () => {
  const NO_INPUTS = { inputs: [] };
  const answered = {
    getFunction: () => ({ fragment: NO_INPUTS, staticCall: () => Promise.resolve("0xTotal") }),
  } as unknown as Contract;
  const reverts = {
    getFunction: () => ({ fragment: NO_INPUTS, staticCall: () => Promise.reject(new Error("execution reverted")) }),
  } as unknown as Contract;

  class Exposed extends ChecksSectionValidator {
    public run(contract: Contract, method: string, check: StaticCallCheck) {
      return this._checkViewFunction(contract, method, check);
    }

    public supplies(methods: string[]) {
      this.undeclared = new Set(methods);
    }
  }

  const validator = new Exposed({} as JsonRpcProvider, 1, EntryField.checks);

  beforeEach(() => {
    resetObserved();
    resetStats();
    resetContractCounters();
    setErrorContext(POSITION);
  });

  afterEach(() => {
    context.observedPath = undefined;
    validator.supplies([]);
  });

  it("is read and recorded when the run keeps what the chain answered", async () => {
    context.observedPath = "state.observed.yaml";
    await validator.run(answered, "_totalAssets", { result: null } as unknown as StaticCallCheck);

    assert.deepEqual(buildObservedDocument("state.yaml").sections.robinhood.contracts.vault.checks, {
      _totalAssets: [{ value: "0xTotal" }],
    });
    // still not a check: nothing was asserted
    assert.deepEqual({ checks: stats.totalChecks, skipped: stats.skipped }, { checks: 0, skipped: 1 });
  });

  it("records a revert as a revert, and is not an error", async () => {
    context.observedPath = "state.observed.yaml";
    await validator.run(reverts, "canSendAssets", { result: null } as unknown as StaticCallCheck);

    const checks = buildObservedDocument("state.yaml").sections.robinhood.contracts.vault.checks as Record<
      string,
      ObservedCall[]
    >;
    assert.deepEqual(Object.keys(checks), ["canSendAssets"]);
    assert.match(String(checks.canSendAssets[0].reverted), /execution reverted/);
    assert.equal(stats.errors, 0);
  });

  it("is not read at all without the observed file", async () => {
    let calls = 0;
    const counted = {
      getFunction: () => ({
        fragment: NO_INPUTS,
        staticCall: () => {
          calls += 1;
          return Promise.resolve("0x0");
        },
      }),
    } as unknown as Contract;

    await validator.run(counted, "_totalAssets", { result: null } as unknown as StaticCallCheck);

    assert.equal(calls, 0);
    assert.deepEqual(buildObservedDocument("state.yaml").sections, {});
  });

  it("is not read when the function takes arguments the config does not give", async () => {
    // `balanceOf: null` names no account; calling it bare would record ethers' complaint as a revert
    context.observedPath = "state.observed.yaml";
    let calls = 0;
    const balanceOf = {
      getFunction: () => ({
        fragment: { inputs: [{ type: "address" }] },
        staticCall: () => {
          calls += 1;
          return Promise.reject(new Error("missing argument"));
        },
      }),
    } as unknown as Contract;

    await validator.run(balanceOf, "balanceOf", { result: null } as unknown as StaticCallCheck);

    assert.equal(calls, 0);
    assert.deepEqual(buildObservedDocument("state.yaml").sections, {});
  });

  it("is not read when its bare name matches several overloads", async () => {
    // ethers resolves the fragment lazily and throws for an ambiguous name; the run must go on
    context.observedPath = "state.observed.yaml";
    let calls = 0;
    const overloaded = {
      getFunction: () => ({
        get fragment(): never {
          throw new Error('ambiguous function description (i.e. matches "getFee(uint32)", "getFee(uint16)")');
        },
        staticCall: () => {
          calls += 1;
          return Promise.resolve("0x0");
        },
      }),
    } as unknown as Contract;

    await validator.run(overloaded, "getFee", { result: null } as unknown as StaticCallCheck);

    assert.equal(calls, 0);
    assert.deepEqual(buildObservedDocument("state.yaml").sections, {});
    assert.deepEqual({ errors: stats.errors, skipped: stats.skipped }, { errors: 0, skipped: 1 });
  });

  it("is not read when the run, not the config, supplied it", async () => {
    // implementationChecks fills every view of the implementation ABI the config leaves out with null
    context.observedPath = "state.observed.yaml";
    validator.supplies(["getRoleMember"]);

    await validator.run(answered, "getRoleMember", { result: null } as unknown as StaticCallCheck);
    await validator.run(answered, "_totalAssets", { result: null } as unknown as StaticCallCheck);

    assert.deepEqual(Object.keys(buildObservedDocument("state.yaml").sections.robinhood.contracts.vault.checks), [
      "_totalAssets",
    ]);
  });
});

describe("an aborted run", () => {
  const runCli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ["--require", "ts-node/register", "--require", "tsconfig-paths/register", "src/state-mate.ts", ...args],
      { cwd: path.resolve(__dirname, ".."), encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
    );

  for (const mode of [[], ["--json"]]) {
    it(`still writes the observed file${mode.length ? " under --json" : ""}`, () => {
      // the section's RPC variable is unset, so the run exits before its first read
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "state-mate-observed-"));
      const config = path.join(directory, "cfg.yaml");
      const observed = path.join(directory, "out", "cfg.observed.yaml");
      fs.writeFileSync(
        config,
        "deployed:\n  l1: []\nl1:\n  rpcUrl: STATE_MATE_TEST_UNSET_RPC_URL\n  chainId: 1\n  contracts: {}\n",
      );
      try {
        const run = runCli(config, "--observed", observed, ...mode);

        assert.equal(run.status, 1);
        const document = YAML.parse(fs.readFileSync(observed, "utf8"));
        assert.equal(document.config, config);
        assert.deepEqual(document.sections, {});
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
