import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { withTemporaryDirectory } from "./delegation-helpers";

// Exercise CLI loading in a subprocess because validation failures exit the process.
const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(REPOSITORY_ROOT, "src/state-mate.ts");
// Leave RPC unconfigured so successful loading stops before network calls.
const RPC_ENV_VAR = "STATE_MATE_TEST_RPC_URL_UNSET";

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

test("removed --generate option is rejected", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const { mainPath } = writeConfigSet(directory);
    assert.match(runStateMate(mainPath, "--generate"), /unknown option '--generate'/);
  });
});

test("sibling flags require a single config file", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const { inputsPath } = writeConfigSet(directory);
    assert.match(runStateMate(directory, "--inputs", inputsPath), /require a single config file/);
  });
});
