import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";

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
import { beginConfig, beginContract, buildReport, endContract, resetReport } from "../src/report";
import { resetContractCounters, setErrorContext } from "../src/section-validators/base";
import { ChecksSectionValidator } from "../src/section-validators/checks";
import type { StaticCallCheck } from "../src/typebox";
import { callError, NO_STATE, REVERT } from "./helpers/rpc-errors";

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
              { args: ["0"], value: "0xaaa" },
              { args: ["1"], value: "0xbbb" },
            ],
            owner: [{ value: "0xOwner" }],
            adapters: [{ args: ["9"], reverted: "execution reverted" }],
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
    assert.deepEqual(toPlain([null, 3, 4n, "x", false]), [null, "3", "4", "x", false]);
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
    getFunction: () => ({ fragment: NO_INPUTS, staticCall: () => Promise.reject(callError(REVERT)) }),
  } as unknown as Contract;
  const refused = {
    getFunction: () => ({ fragment: NO_INPUTS, staticCall: () => Promise.reject(callError(NO_STATE)) }),
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
    resetReport();
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

  it("words an empty revert the same whether the backend sends data 0x or none", async () => {
    context.observedPath = "state.observed.yaml";
    const withEmptyData = {
      getFunction: () => ({
        fragment: NO_INPUTS,
        staticCall: () => Promise.reject(callError({ ...REVERT, code: 3, data: "0x" })),
      }),
    } as unknown as Contract;
    await validator.run(reverts, "canSendAssets", { result: null } as unknown as StaticCallCheck);
    await validator.run(withEmptyData, "canSendAssets", { result: null } as unknown as StaticCallCheck);

    const [none, empty] = (
      buildObservedDocument("state.yaml").sections.robinhood.contracts.vault.checks as Record<string, ObservedCall[]>
    ).canSendAssets;
    assert.deepEqual(empty, none);
  });

  it("records a read the node did not serve as an error, not as a revert, and warns about it", async () => {
    context.observedPath = "state.observed.yaml";
    beginConfig("state.yaml");
    beginContract("robinhood/vault", "Vault", "0xVault");
    await validator.run(refused, "canSendAssets", { result: null } as unknown as StaticCallCheck);
    endContract();

    assert.deepEqual(buildReport(0).configs[0].contracts?.[0]?.warnings, [
      {
        check: ".canSendAssets",
        message: `not read: the call FAILED with: historical state 0x${"ab".repeat(32)} is not available`,
      },
    ]);

    const [call] = (
      buildObservedDocument("state.yaml").sections.robinhood.contracts.vault.checks as Record<string, ObservedCall[]>
    ).canSendAssets;
    assert.equal(call.reverted, undefined);
    assert.match(String(call.error), /historical state .* is not available/);
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

  it("is refused for a directory and leaves no file behind", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "state-mate-observed-"));
    const observed = path.join(directory, "out.observed.yaml");
    try {
      const run = runCli(directory, "--observed", observed);

      assert.equal(run.status, 1);
      assert.match(`${run.stdout}${run.stderr}`, /--observed option requires a single config file/);
      assert.equal(fs.existsSync(observed), false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  // the RPC variables are unset: a run that gets past the refusals stops before its first read
  const CONFIG = [
    "deployed:\n  l1: []\n  l2: []",
    "l1:\n  rpcUrl: STATE_MATE_TEST_UNSET_L1_RPC_URL\n  chainId: 1\n  contracts: {}",
    "l2:\n  rpcUrl: STATE_MATE_TEST_UNSET_L2_RPC_URL\n  chainId: 10\n  contracts: {}\n",
  ].join("\n");

  for (const [stop, args] of [
    ["stops before its first read", ["-o", "l1"]],
    ["stops before its first read under --json", ["-o", "l1", "--json"]],
    ["refuses a --block for a config that spans two chains", ["--block", "16"]],
  ] as const) {
    it(`leaves the file of an earlier run as it was when it ${stop}`, () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "state-mate-observed-"));
      const config = path.join(directory, "cfg.yaml");
      const observed = path.join(directory, "cfg.observed.yaml");
      fs.writeFileSync(config, CONFIG);
      fs.writeFileSync(observed, "previous run\n");
      try {
        const run = runCli(config, "--observed", observed, ...args);

        assert.equal(run.status, 1);
        assert.equal(fs.readFileSync(observed, "utf8"), "previous run\n");
        assert.deepEqual(fs.readdirSync(directory).sort(), ["cfg.observed.yaml", "cfg.yaml"]);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

describe("an observed file that cannot be written", () => {
  it("fails the run in the JSON report too, not only in the process status", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "state-mate-observed-"));
    // an RPC that answers 0x1 to everything: chain 1, head 1, and a section the run gets to read
    const server = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      const reply = (call: { id: number }) => ({ jsonrpc: "2.0", id: call.id, result: "0x1" });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(Array.isArray(payload) ? payload.map(reply) : reply(payload)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const config = path.join(directory, "cfg.yaml");
      fs.writeFileSync(
        config,
        `deployed: {l1: []}\nl1: {rpcUrl: "http://127.0.0.1:${port}", chainId: 1, contracts: {}}\n`,
      );
      // a directory where the file should go
      const observed = path.join(directory, "taken");
      fs.mkdirSync(observed);

      const run = await promisify(execFile)(
        process.execPath,
        [
          ...["--require", "ts-node/register", "--require", "tsconfig-paths/register", "src/state-mate.ts", config],
          ...["--json", "--observed", observed],
        ],
        { cwd: path.resolve(__dirname, ".."), env: { ...process.env, NO_COLOR: "1" } },
      ).then(
        ({ stdout }) => ({ code: 0, stdout }),
        (error: { code: number; stdout: string }) => error,
      );

      const report = JSON.parse(run.stdout);
      assert.deepEqual(
        { exit_code: report.exit_code, process: run.code, status: report.status },
        { exit_code: 1, process: 1, status: "error" },
      );
      assert.match(report.error, /Could not write the observed file/);
      assert.deepEqual(
        fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")),
        [],
      );
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
