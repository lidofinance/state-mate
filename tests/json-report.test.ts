import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import chalk from "chalk";

import { context, resetStats, stats } from "../src/context";
import { FatalError, LogCommand, logErrorAndExit } from "../src/logger";
import { beginConfig, beginContract, buildReport, endConfig, endContract, resetReport } from "../src/report";
import { incChecks, incErrors, resetContractCounters, setErrorContext } from "../src/section-validators/base";

const ADDRESS = "0x7305bB45aF91893B7BCaF0Ad8Eae37cb16820Bb8";

// What a consumer parses: undefined keys are gone once the report is serialized
const rendered = (exitCode: number, error?: string) => JSON.parse(JSON.stringify(buildReport(exitCode, error)));

describe("--json report", () => {
  beforeEach(() => {
    resetStats();
    resetContractCounters();
    resetReport();
    context.json = true;
  });

  afterEach(() => {
    context.json = false;
  });

  it("reduces a clean run to the verdict and the counters, listing no contract", () => {
    beginConfig("cfg.yaml");
    beginContract("l1/vault", "Vault", ADDRESS);
    incChecks();
    incChecks();
    endContract();
    endConfig();

    const report = rendered(0);
    assert.equal(report.status, "passed");
    assert.deepEqual(report.summary, { configs: 1, checks: 2, errors: 0, skipped: 0, warnings: 0 });
    assert.deepEqual(report.configs, [{ config: "cfg.yaml", status: "passed", checks: 2, errors: 0, skipped: 0 }]);
    assert.equal("filter" in report, false);
    assert.equal("error" in report, false);
  });

  it("lists a failed check under its contract with the section type and a colour-free message", () => {
    beginConfig("cfg.yaml");
    beginContract("l1/ok", "Ok", ADDRESS);
    incChecks();
    endContract();
    beginContract("l1/vault", "Vault", ADDRESS);
    incChecks();
    setErrorContext({ checksType: "checks", method: "owner" });
    incErrors(`Expected ${chalk.yellow("0x1")} to equal actual ${chalk.red("0x2")}`);
    endContract();
    endConfig();

    const report = rendered(1);
    assert.equal(report.status, "failed");
    assert.equal(report.configs[0].status, "failed");
    assert.deepEqual(report.configs[0].contracts, [
      {
        path: "l1/vault",
        name: "Vault",
        address: ADDRESS,
        failures: [{ check: "owner", message: "Expected 0x1 to equal actual 0x2", type: "checks" }],
      },
    ]);
  });

  it("keeps a check that could not run visible as a warning on its contract", () => {
    beginConfig("cfg.yaml");
    beginContract("l1/vault", "Vault", ADDRESS);
    new LogCommand("exhaustive ACL scan").warning("no log source is known for chainId 7");
    endContract();
    endConfig();

    const report = rendered(0);
    assert.equal(report.status, "passed");
    assert.equal(report.summary.warnings, 1);
    assert.deepEqual(report.configs[0].contracts[0].warnings, [
      { check: "exhaustive ACL scan", message: "no log source is known for chainId 7" },
    ]);
  });

  it("marks the config an aborted run left open as error and carries the message to the top", () => {
    beginConfig("cfg.yaml");
    beginContract("l1/vault", "Vault", ADDRESS);
    stats.totalChecks = 4;

    const report = rendered(1, `Env var ${chalk.yellow("ETH_RPC_URL")} is not set`);
    assert.equal(report.status, "error");
    assert.equal(report.exit_code, 1);
    assert.equal(report.error, "Env var ETH_RPC_URL is not set");
    assert.equal(report.configs[0].status, "error");
    assert.equal(report.configs[0].error, "Env var ETH_RPC_URL is not set");
    assert.equal(report.configs[0].checks, 4);
  });

  it("keeps the failures of the contract an abort interrupted", () => {
    beginConfig("cfg.yaml");
    beginContract("l1/vault", "Vault", ADDRESS);
    setErrorContext({ checksType: "implementation", method: "implementation" });
    incErrors("delegates to 0x1, while the config expects 0x2");

    const report = rendered(1, "No consolidated ABI file found");
    assert.equal(report.configs[0].status, "error");
    assert.deepEqual(report.configs[0].contracts[0].failures, [
      { check: "implementation", message: "delegates to 0x1, while the config expects 0x2", type: "implementation" },
    ]);
  });

  it("turns a run-ending error into an exception instead of exiting the process", () => {
    assert.throws(() => logErrorAndExit("boom"), FatalError);
  });

  const runCli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ["--require", "ts-node/register", "--require", "tsconfig-paths/register", "src/state-mate.ts", ...args],
      { cwd: path.resolve(__dirname, ".."), encoding: "utf8" },
    );

  it("reports a usage error commander rejects, such as a missing config path", () => {
    const run = runCli("--json");

    assert.equal(run.status, 1);
    assert.equal(run.stderr, "");
    assert.equal(JSON.parse(run.stdout).status, "error");
    assert.match(JSON.parse(run.stdout).error, /config-path/);
  });

  it("reports a malformed --only filter instead of exiting with a stack trace", () => {
    const run = runCli("no/such.yaml", "--json", "-o", "a/b/c/d/e");

    assert.equal(run.status, 1);
    assert.equal(run.stderr, "");
    assert.equal(JSON.parse(run.stdout).status, "error");
    assert.match(JSON.parse(run.stdout).error, /checkOnly/);
    assert.equal(JSON.parse(run.stdout).filter, "a/b/c/d/e");
  });

  it("writes nothing but the report to stdout when the run aborts before any config", () => {
    const run = runCli("no/such.yaml", "--json");

    assert.equal(run.status, 1);
    assert.equal(run.stderr, "");
    const report = JSON.parse(run.stdout);
    assert.equal(report.status, "error");
    assert.match(report.error, /no\/such\.yaml/);
    assert.deepEqual(report.configs, []);
  });
});
