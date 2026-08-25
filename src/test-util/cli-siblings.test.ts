import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { withTemporaryDirectory } from "./delegation-helpers";

// End-to-end coverage of the CLI's sibling wiring (`loadStateWithOptionalSiblings`), which the
// engine-level suites cannot reach: it reads `g_Arguments` and exits the process on any violation.
// Each case runs the real entry point and asserts on what it printed before the run stops at the
// unset RPC env var — so the assertions cover the loading phase only, with no network access.
const REPOSITORY_ROOT = path.resolve(__dirname, "../..");
const ENTRY = path.join(REPOSITORY_ROOT, "src/state-mate.ts");
// A deliberately unset env var: the run must always stop here, never reach an RPC endpoint. It is
// removed from the child's environment so a stray value in the developer's `.env` cannot change that.
const RPC_ENV_VAR = "STATE_MATE_TEST_RPC_URL_UNSET";

/** Run the CLI on `configPath` and return its combined output (stdout + stderr). */
function runStateMate(configPath: string, ...cliArguments: string[]): string {
  const environment = { ...process.env };
  delete environment[RPC_ENV_VAR];
  const result = spawnSync(
    process.execPath,
    ["--require", "ts-node/register", "--require", "tsconfig-paths/register", ENTRY, configPath, ...cliArguments],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", env: environment },
  );
  return `${result.stdout}${result.stderr}`;
}

// Wiring only: every anchor it references lives in the sibling files below.
const MAIN_CONFIG = `
l1:
  rpcUrl: ${RPC_ENV_VAR}
  chainId: *chainId
  contracts:
    fooContract:
      name: Foo
      address: *fooAddress
      checks:
        name: *lidoName
`;
const DEPLOYED = `
deployed:
  l1:
    - &fooAddress "0x1111111111111111111111111111111111111111"
`;
const INPUTS = `
config:
  - &lidoName "Liquid staked Ether 2.0"
externals:
  - &chainId 560048
`;

/** Lay out a wiring-only config with both conventionally named siblings next to it. */
function writeConfigSet(directory: string): { mainPath: string; deployedPath: string; inputsPath: string } {
  const mainPath = path.join(directory, "lido.yaml");
  const deployedPath = path.join(directory, "lido.deployed.yaml");
  const inputsPath = path.join(directory, "lido.inputs.yaml");
  fs.writeFileSync(mainPath, MAIN_CONFIG);
  fs.writeFileSync(deployedPath, DEPLOYED);
  fs.writeFileSync(inputsPath, INPUTS);
  return { mainPath, deployedPath, inputsPath };
}

test("a conventionally named sibling next to the config is NOT loaded without its flag", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const { mainPath } = writeConfigSet(directory);
    const output = runStateMate(mainPath);

    // The whole point of explicit-only: the files are right there, and still nothing is loaded.
    assert.match(output, /delegates anchors to sibling file\(s\)/);
    assert.match(output, /pass --deployed \/ --inputs/);
    assert.match(output, /never loaded automatically/);
    assert.doesNotMatch(output, /Loaded \d+ deployed address\(es\)/);
    assert.doesNotMatch(output, /Loaded \d+ input anchor\(s\)/);
  });
});

test("both flags compose the config and it passes schema validation", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const { mainPath, deployedPath, inputsPath } = writeConfigSet(directory);
    const output = runStateMate(mainPath, "--deployed", deployedPath, "--inputs", inputsPath);

    assert.match(output, /Loaded 1 deployed address\(es\)/);
    assert.match(output, /Loaded 2 input anchor\(s\)/);
    assert.match(output, /Schema validation passed/);
    // The run gets past loading and stops only at the unset RPC env var — no network access.
    assert.match(output, new RegExp(`Env var ${RPC_ENV_VAR} is not set`));
  });
});

test("a self-contained config still runs standalone, with no flags and no sibling error", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const mainPath = path.join(directory, "standalone.yaml");
    fs.writeFileSync(
      mainPath,
      `${DEPLOYED}
l1:
  rpcUrl: ${RPC_ENV_VAR}
  chainId: 560048
  contracts:
    fooContract:
      name: Foo
      address: *fooAddress
      checks:
        name: "Foo"
`,
    );
    const output = runStateMate(mainPath);

    assert.match(output, /Schema validation passed/);
    assert.doesNotMatch(output, /delegates anchors/);
  });
});

test("an inline config:/externals: section without --inputs is rejected", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const mainPath = path.join(directory, "inline.yaml");
    fs.writeFileSync(
      mainPath,
      `${INPUTS}${MAIN_CONFIG.replace("*fooAddress", '"0x1111111111111111111111111111111111111111"')}`,
    );
    const output = runStateMate(mainPath);

    assert.match(output, /holds top-level `config:` \/ `externals:` section\(s\) inline/);
    assert.match(output, /only allowed in the \.inputs file/);
  });
});

test("--generate ignores an explicit sibling and rejects a wiring-only config", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const { mainPath, inputsPath } = writeConfigSet(directory);
    const output = runStateMate(mainPath, "--generate", "--inputs", inputsPath);

    assert.match(output, /Ignoring .*lido\.inputs\.yaml with --generate/);
    assert.match(output, /--generate works on self-contained \(seed\) configs only/);
  });
});
