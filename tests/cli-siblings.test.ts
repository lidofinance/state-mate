import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { CROSS_SOURCE_ERRORS, composeWithInputs, withTemporaryDirectory } from "./delegation-helpers";

// Exercise CLI loading in a subprocess because validation failures exit the process.
const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(REPOSITORY_ROOT, "src/state-mate.ts");
// Leave RPC unconfigured so successful loading stops before network calls.
const RPC_ENV_VAR = "STATE_MATE_TEST_RPC_URL_UNSET";

function runStateMate(configPath: string, ...cliArguments: string[]) {
  const environment = { ...process.env };
  delete environment[RPC_ENV_VAR];
  const result = spawnSync(
    process.execPath,
    ["--require", "ts-node/register", "--require", "tsconfig-paths/register", ENTRY, configPath, ...cliArguments],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", env: environment, timeout: 30_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, "CLI must terminate normally");
  // Every fixture either fails validation or intentionally stops at the unset RPC variable.
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  return { ...result, output: `${result.stdout}${result.stderr}` };
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
    const { output } = runStateMate(mainPath);

    assertStoppedBeforeSchema(output);
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
    const { output } = runStateMate(mainPath, "--deployed", deployedPath, "--inputs", inputsPath);

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
    const { output } = runStateMate(mainPath);

    assert.match(output, /Schema validation passed/);
    assert.doesNotMatch(output, /delegates anchors/);
    assert.match(output, new RegExp(`Env var ${RPC_ENV_VAR} is not set`));
  });
});

test("an inline config:/externals: section without --inputs is rejected", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const mainPath = path.join(directory, "inline.yaml");
    fs.writeFileSync(
      mainPath,
      `${INPUTS}${MAIN_CONFIG.replace("*fooAddress", '"0x1111111111111111111111111111111111111111"')}`,
    );
    const { output } = runStateMate(mainPath);

    assertStoppedBeforeSchema(output);
    assert.match(output, /holds top-level `config:` \/ `externals:` section\(s\) inline/);
    assert.match(output, /only allowed in the \.inputs file/);
  });
});

test("removed --generate option is rejected", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const { mainPath } = writeConfigSet(directory);
    const { output } = runStateMate(mainPath, "--generate");
    assertStoppedBeforeSchema(output);
    assert.match(output, /unknown option '--generate'/);
  });
});

test("sibling flags require a single config file", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const { inputsPath } = writeConfigSet(directory);
    const { output } = runStateMate(directory, "--inputs", inputsPath);
    assertStoppedBeforeSchema(output);
    assert.match(output, /require a single config file/);
  });
});

function assertStoppedBeforeSchema(output: string) {
  assert.doesNotMatch(output, /Schema validation passed|Env var .* is not set/);
}

function assertLoaded(output: string) {
  assert.match(output, /Schema validation passed/);
  assert.match(output, new RegExp(`Env var ${RPC_ENV_VAR} is not set`));
}

for (const selection of ["deployed", "inputs"] as const) {
  test(`${selection} can be selected independently and passes schema before the RPC stop`, () => {
    withTemporaryDirectory("state-mate-cli-", (directory) => {
      const { mainPath, deployedPath, inputsPath } = writeConfigSet(directory);
      const main =
        selection === "deployed"
          ? MAIN_CONFIG.replace("*chainId", "560048").replace("*lidoName", '"Foo"')
          : DEPLOYED + MAIN_CONFIG;
      fs.writeFileSync(mainPath, main);
      const { output } = runStateMate(mainPath, `--${selection}`, selection === "deployed" ? deployedPath : inputsPath);
      assertLoaded(output);
      assert.match(output, selection === "deployed" ? /Loaded 1 deployed address/ : /Loaded 2 input anchor/);
      assert.doesNotMatch(output, selection === "deployed" ? /Loaded .* input anchor/ : /Loaded .* deployed address/);
    });
  });

  test(`selecting only ${selection} does not discover the other conventional sibling`, () => {
    withTemporaryDirectory("state-mate-cli-", (directory) => {
      const { mainPath, deployedPath, inputsPath } = writeConfigSet(directory);
      const { output } = runStateMate(mainPath, `--${selection}`, selection === "deployed" ? deployedPath : inputsPath);
      assertStoppedBeforeSchema(output);
      assert.match(output, /defined neither in it nor in/);
      for (const label of selection === "deployed" ? ["chainId", "lidoName"] : ["fooAddress"]) {
        assert.ok(output.includes(`&${label}`), output);
      }
      assert.doesNotMatch(output, /Loaded .* (input anchor|deployed address)/);
    });
  });
}

for (const sections of ["config", "externals", "both"]) {
  test(`deployed-only selection rejects inline ${sections}`, () => {
    withTemporaryDirectory("state-mate-cli-", (directory) => {
      const { mainPath, deployedPath } = writeConfigSet(directory);
      const config = sections !== "externals" ? 'config: [&lidoName "Foo"]\n' : "";
      const externals = sections !== "config" ? "externals: [&chainId 560048]\n" : "";
      const main = MAIN_CONFIG.replace("*chainId", externals ? "*chainId" : "560048").replace(
        "*lidoName",
        config ? "*lidoName" : '"Foo"',
      );
      fs.writeFileSync(mainPath, config + externals + main);
      const { output } = runStateMate(mainPath, "--deployed", deployedPath);
      assertStoppedBeforeSchema(output);
      assert.match(output, /holds top-level .* section\(s\) inline/);
      assert.match(output, /only allowed in the \.inputs file/);
    });
  });
}

for (const fixture of [
  { name: "scalar array", value: "[true, false, 7, 16015286601757825753]", valid: true },
  { name: "array containing an object", value: "[{foo: bar}]", valid: false },
  { name: "nonnumeric chainId", value: '"not-a-chain"', valid: false },
]) {
  test(`composed ${fixture.name} is checked by the downstream schema`, () => {
    withTemporaryDirectory("state-mate-cli-", (directory) => {
      const { mainPath, inputsPath } = writeConfigSet(directory);
      const chainCase = fixture.name === "nonnumeric chainId";
      const main =
        DEPLOYED +
        MAIN_CONFIG.replace("*chainId", chainCase ? "*value" : "560048").replace(
          "*lidoName",
          chainCase ? '"Foo"' : "*value",
        );
      const inputs = `config: [&value ${fixture.value}]\n`;
      fs.writeFileSync(mainPath, main);
      fs.writeFileSync(inputsPath, inputs);
      const { document } = composeWithInputs(main, inputs);
      const resolved = document as {
        config: unknown[];
        l1: { contracts: { fooContract: { checks: { name: unknown } } } };
      };
      if (fixture.valid) {
        const expected = [true, false, "7", "16015286601757825753"];
        assert.deepEqual(resolved.config, [expected]);
        assert.deepEqual(resolved.l1.contracts.fooContract.checks.name, expected);
      }
      const { output } = runStateMate(mainPath, "--inputs", inputsPath);
      assert.match(output, /Loaded 1 input anchor/);
      if (fixture.valid) assertLoaded(output);
      else {
        assertStoppedBeforeSchema(output);
        assert.match(output, /do not comply with the JSON schema/);
        assert.match(output, chainCase ? /\/l1\/chainId/ : /\/l1\/contracts\/fooContract\/checks\/name/);
      }
    });
  });
}

for (const failure of ["missing path", "unused label", "cross-source aliases"]) {
  test(`JSON sibling failure preserves the report contract: ${failure}`, () => {
    withTemporaryDirectory("state-mate-cli-", (directory) => {
      const { mainPath, inputsPath } = writeConfigSet(directory);
      fs.writeFileSync(
        mainPath,
        failure === "cross-source aliases" ? CROSS_SOURCE_ERRORS.main : DEPLOYED + MAIN_CONFIG,
      );
      if (failure === "unused label") fs.appendFileSync(inputsPath, '  - &unused "123"\n');
      if (failure === "cross-source aliases") fs.writeFileSync(inputsPath, CROSS_SOURCE_ERRORS.inputs);
      const selectedPath = failure === "missing path" ? path.join(directory, "missing.inputs.yaml") : inputsPath;
      const run = runStateMate(mainPath, "--inputs", selectedPath, "--json");
      const report = JSON.parse(run.stdout);
      assert.equal(report.status, "error");
      assert.equal(report.exit_code, run.status);
      assert.equal(report.configs.length, 1);
      assert.equal(report.configs[0].status, "error");
      assert.equal(report.configs[0].error, report.error);
      assert.equal(report.configs[0].config, mainPath);
      assert.equal(report.summary.checks, 0);
      assertStoppedBeforeSchema(run.output);
      if (failure === "missing path") assert.ok(report.error.includes(selectedPath), report.error);
      if (failure === "unused label") {
        assert.match(report.error, /never referenced/);
        assert.match(report.error, /&unused/);
      }
      if (failure === "cross-source aliases") {
        for (const diagnostic of CROSS_SOURCE_ERRORS.diagnostics)
          assert.ok(report.error.includes(diagnostic), report.error);
      }
    });
  });
}

test("the existing deep-array schema admits an object inside delegated config when its consumer permits it", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const { mainPath, inputsPath } = writeConfigSet(directory);
    fs.writeFileSync(inputsPath, "config: [&value [{foo: bar}]]\n");
    fs.writeFileSync(
      mainPath,
      `${DEPLOYED}misc: [*value]\n${MAIN_CONFIG.replace("*chainId", "560048").replace("*lidoName", '"Foo"')}`,
    );
    const { output } = runStateMate(mainPath, "--inputs", inputsPath);
    assertLoaded(output);
  });
});
