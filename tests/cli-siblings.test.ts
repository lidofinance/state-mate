import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { DEPLOYED_SPEC } from "../src/deployed-addresses";
import { INPUTS_SPEC } from "../src/inputs";
import { composeWithSiblings } from "../src/sibling-delegation";
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
    assert.match(output, /Unresolved aliases in .*: \*chainId, \*fooAddress, \*lidoName\./);
    assert.match(output, /If they belong to separate files, supply --deployed \/ --inputs/);
    assert.match(output, /never loaded automatically/);
    assert.doesNotMatch(output, /Loaded \d+ deployed address\(es\)/);
    assert.doesNotMatch(output, /Loaded \d+ input anchor\(s\)/);
  });
});

for (const json of [false, true]) {
  test(`a standalone alias typo retains its name${json ? " in JSON" : ""}`, () => {
    withTemporaryDirectory("state-mate-cli-", (directory) => {
      const mainPath = path.join(directory, "typo.yaml");
      fs.writeFileSync(mainPath, "value: &foo true\nref: *fooo\n");
      const run = runStateMate(mainPath, ...(json ? ["--json"] : []));
      const message = json ? JSON.parse(run.stdout).configs[0].error : run.output;
      assertStoppedBeforeSchema(run.output);
      assert.match(message, /Unresolved aliases in .*: \*fooo\./);
      assert.match(message, /Define their anchors before use/);
      assert.match(message, /If they belong to separate files, supply --deployed \/ --inputs/);
      assert.doesNotMatch(message, /delegates anchors/);
    });
  });
}

test("standalone forward aliases retain the native parser diagnostic", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const mainPath = path.join(directory, "forward.yaml");
    fs.writeFileSync(mainPath, "ref: *foo\nvalue: &foo true\n");
    const { output } = runStateMate(mainPath);
    assert.match(output, /Unresolved alias \(the anchor must be set before the alias\): foo/);
    assert.doesNotMatch(output, /sibling files/);
  });
});

test("JSON records both selected sibling paths resolved from the working directory", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const { mainPath, deployedPath, inputsPath } = writeConfigSet(directory);
    const run = runStateMate(
      mainPath,
      "--deployed",
      path.relative(REPOSITORY_ROOT, deployedPath),
      "--inputs",
      path.relative(REPOSITORY_ROOT, inputsPath),
      "--json",
    );
    const report = JSON.parse(run.stdout);
    assert.match(report.error, new RegExp(`Env var ${RPC_ENV_VAR} is not set`));
    assert.deepEqual(report.configs[0].deployed, [deployedPath]);
    assert.deepEqual(report.configs[0].inputs, [inputsPath]);
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

// The kind order is the CLI's: `.deployed` files come before `.inputs` files in the composed
// document whatever the flag order, so an input array may alias a deployed address.
test("an input array aliases a deployed address even when --inputs precedes --deployed", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const { mainPath, deployedPath, inputsPath } = writeConfigSet(directory);
    fs.writeFileSync(mainPath, MAIN_CONFIG.replace("name: *lidoName", "name: *lidoName\n        allowed: *allowed"));
    fs.writeFileSync(inputsPath, INPUTS.replace("externals:", "  - &allowed [*fooAddress]\nexternals:"));
    const { output } = runStateMate(mainPath, "--inputs", inputsPath, "--deployed", deployedPath);

    assert.match(output, /Loaded 1 deployed address\(es\)/);
    assert.match(output, /Loaded 3 input anchor\(s\)/);
    assert.match(output, /Schema validation passed/);
    assert.match(output, new RegExp(`Env var ${RPC_ENV_VAR} is not set`));
  });
});

// Shared-plus-per-network layout: one wiring config, a common address file and a network one.
const L2_MAIN_CONFIG = `
l1:
  rpcUrl: ${RPC_ENV_VAR}
  chainId: 560048
  contracts:
    workflow:
      name: Workflow
      address: *l1Workflow
      checks:
        bridge: *l2Bridge
l2:
  rpcUrl: ${RPC_ENV_VAR}
  chainId: 11155420
  contracts:
    bridge:
      name: Bridge
      address: *l2Bridge
      checks:
        workflow: *l1Workflow
`;
const COMMON_DEPLOYED = 'deployed:\n  l1:\n    - &l1Workflow "0x1111111111111111111111111111111111111111"\n';
const OPTIMISM_DEPLOYED = 'deployed:\n  l2:\n    - &l2Bridge "0x2222222222222222222222222222222222222222"\n';

function writeL2ConfigSet(directory: string): { mainPath: string; commonPath: string; optimismPath: string } {
  const mainPath = path.join(directory, "l2.yaml");
  const commonPath = path.join(directory, "common.deployed.yaml");
  const optimismPath = path.join(directory, "optimism.deployed.yaml");
  fs.writeFileSync(mainPath, L2_MAIN_CONFIG);
  fs.writeFileSync(commonPath, COMMON_DEPLOYED);
  fs.writeFileSync(optimismPath, OPTIMISM_DEPLOYED);
  return { mainPath, commonPath, optimismPath };
}

test("two --deployed files compose one address book and the run reaches the RPC stop", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const { mainPath, commonPath, optimismPath } = writeL2ConfigSet(directory);
    const { output } = runStateMate(mainPath, "--deployed", commonPath, "--deployed", optimismPath);
    assertLoaded(output);
    const loaded = output.match(/Loaded 1 deployed address\(es\) from (\S+)/g);
    assert.deepEqual(loaded, [
      `Loaded 1 deployed address(es) from ${path.relative(REPOSITORY_ROOT, commonPath)}`,
      `Loaded 1 deployed address(es) from ${path.relative(REPOSITORY_ROOT, optimismPath)}`,
    ]);
  });
});

test("a JSON report lists every selected --deployed file in argument order", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const { mainPath, commonPath, optimismPath } = writeL2ConfigSet(directory);
    const run = runStateMate(
      mainPath,
      "--deployed",
      path.relative(REPOSITORY_ROOT, optimismPath),
      "--deployed",
      commonPath,
      "--json",
    );
    const [entry] = JSON.parse(run.stdout).configs;
    assert.deepEqual(entry.deployed, [optimismPath, commonPath]);
  });
});

test("a single --deployed file is listed the same way, as a one-element list", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const { mainPath, deployedPath } = writeConfigSet(directory);
    const run = runStateMate(mainPath, "--deployed", deployedPath, "--json");
    const [entry] = JSON.parse(run.stdout).configs;
    assert.deepEqual(entry.deployed, [deployedPath]);
  });
});

test("selecting the same --deployed file twice is rejected before anything loads", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const { mainPath, commonPath, optimismPath } = writeL2ConfigSet(directory);
    const relative = path.relative(REPOSITORY_ROOT, commonPath);
    const run = runStateMate(
      mainPath,
      "--deployed",
      commonPath,
      "--deployed",
      optimismPath,
      "--deployed",
      relative,
      "--json",
    );
    const report = JSON.parse(run.stdout);
    assert.equal(report.status, "error");
    assert.equal(
      report.error,
      `The --deployed file is selected more than once: ${relative} (the same file as ${commonPath})`,
    );
    assert.deepEqual(
      report.configs[0].deployed,
      [commonPath, optimismPath, relative].map((file) => path.resolve(file)),
    );
    assertStoppedBeforeSchema(run.output);
  });
});

test("a label defined in two --deployed files is rejected, and unresolved aliases name both files", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const { mainPath, commonPath, optimismPath } = writeL2ConfigSet(directory);
    fs.appendFileSync(optimismPath, '  l1:\n    - &l1Workflow "0x3333333333333333333333333333333333333333"\n');
    const duplicate = runStateMate(mainPath, "--deployed", commonPath, "--deployed", optimismPath);
    assertStoppedBeforeSchema(duplicate.output);
    assert.match(
      duplicate.output,
      /label\(s\) defined in more than one delegated file: &l1Workflow \(in the \.deployed file \S*common\.deployed\.yaml and the \.deployed file \S*optimism\.deployed\.yaml\)/,
    );

    fs.writeFileSync(optimismPath, OPTIMISM_DEPLOYED);
    fs.appendFileSync(mainPath, "misc: [*l2Token]\n");
    const missing = runStateMate(mainPath, "--deployed", commonPath, "--deployed", optimismPath);
    assertStoppedBeforeSchema(missing.output);
    const common = path.relative(REPOSITORY_ROOT, commonPath);
    const optimism = path.relative(REPOSITORY_ROOT, optimismPath);
    assert.ok(
      missing.output.includes(
        `defined neither in it nor in the .deployed file ${common} / the .deployed file ${optimism}: &l2Token`,
      ),
      missing.output,
    );
  });
});

test("two --inputs files compose config: and externals: lists, alongside two --deployed files", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const { mainPath, commonPath, optimismPath } = writeL2ConfigSet(directory);
    fs.writeFileSync(
      mainPath,
      L2_MAIN_CONFIG.replace("chainId: 560048", "chainId: *l1ChainId")
        .replace("chainId: 11155420", "chainId: *l2ChainId")
        .replace("bridge: *l2Bridge", "bridge: *l2Bridge\n        name: *workflowName\n        limits: *limits"),
    );
    const commonInputs = path.join(directory, "common.inputs.yaml");
    const optimismInputs = path.join(directory, "optimism.inputs.yaml");
    fs.writeFileSync(commonInputs, 'config:\n  - &workflowName "Workflow"\nexternals:\n  - &l1ChainId 560048\n');
    fs.writeFileSync(optimismInputs, "config:\n  - &limits [1, 2]\nexternals:\n  - &l2ChainId 11155420\n");
    const run = runStateMate(
      mainPath,
      "--inputs",
      commonInputs,
      "--deployed",
      commonPath,
      "--inputs",
      optimismInputs,
      "--deployed",
      optimismPath,
      "--json",
    );
    const report = JSON.parse(run.stdout);
    assert.match(report.error, new RegExp(`Env var ${RPC_ENV_VAR} is not set`));
    const [entry] = report.configs;
    assert.deepEqual(entry.inputs, [commonInputs, optimismInputs]);
    assert.deepEqual(entry.deployed, [commonPath, optimismPath]);

    const { document } = composeWithSiblings(fs.readFileSync(mainPath, "utf8"), [
      { text: fs.readFileSync(commonInputs, "utf8"), spec: INPUTS_SPEC },
      { text: fs.readFileSync(optimismInputs, "utf8"), spec: INPUTS_SPEC },
      { text: COMMON_DEPLOYED, spec: DEPLOYED_SPEC },
      { text: OPTIMISM_DEPLOYED, spec: DEPLOYED_SPEC },
    ]);
    const composed = document as { config: unknown[]; externals: string[]; l2: { chainId: string } };
    assert.deepEqual(composed.config, ["Workflow", ["1", "2"]]);
    assert.deepEqual(composed.externals, ["560048", "11155420"]);
    assert.equal(composed.l2.chainId, "11155420");
  });
});

test("selecting the same --inputs file twice is rejected, and a cross-file duplicate label names both", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const { mainPath, inputsPath } = writeConfigSet(directory);
    const twice = runStateMate(mainPath, "--inputs", inputsPath, "--inputs", inputsPath, "--json");
    const report = JSON.parse(twice.stdout);
    assert.equal(report.status, "error");
    assert.equal(report.error, `The --inputs file is selected more than once: ${inputsPath}`);
    assertStoppedBeforeSchema(twice.output);

    const otherPath = path.join(directory, "other.inputs.yaml");
    fs.writeFileSync(otherPath, 'config:\n  - &lidoName "Other"\n');
    const duplicate = runStateMate(mainPath, "--inputs", inputsPath, "--inputs", otherPath);
    assertStoppedBeforeSchema(duplicate.output);
    assert.match(
      duplicate.output,
      /label\(s\) defined in more than one delegated file: &lidoName \(in the \.inputs file \S+ and the \.inputs file \S*other\.inputs\.yaml\)/,
    );
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
    assert.doesNotMatch(output, /Unresolved aliases|sibling files/);
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
    assert.match(output, /holds top-level `externals:` \/ `config:` section\(s\) inline/);
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

test("auto-loading requires a directory and cannot be mixed with explicit siblings", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const { mainPath, deployedPath, inputsPath } = writeConfigSet(directory);
    const fileRun = runStateMate(mainPath, "--auto-load-deployed-and-inputs", "--json");
    assert.match(JSON.parse(fileRun.stdout).error, /requires a directory/);
    for (const [flag, selected] of [
      ["--deployed", deployedPath],
      ["--inputs", inputsPath],
    ]) {
      const run = runStateMate(directory, "--auto-load-deployed-and-inputs", flag, selected, "--json");
      assert.match(JSON.parse(run.stdout).error, /cannot be combined/);
    }
  });
});

test("directory auto-loading still fails on a missing sibling instead of skipping the config", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    fs.writeFileSync(path.join(directory, "wiring.yaml"), MAIN_CONFIG);
    const run = runStateMate(directory, "--auto-load-deployed-and-inputs", "--json");
    const report = JSON.parse(run.stdout);
    assert.equal(report.status, "error");
    assert.equal(report.configs.length, 1);
    assert.match(report.error, /Unresolved aliases/);
  });
});

test("directory auto-loading reports ambiguous siblings as a JSON error", () => {
  withTemporaryDirectory("state-mate-cli-", (directory) => {
    const { deployedPath } = writeConfigSet(directory);
    fs.copyFileSync(deployedPath, deployedPath.replace(/\.yaml$/, ".yml"));
    const run = runStateMate(directory, "--auto-load-deployed-and-inputs", "--json");
    assert.equal(run.stderr, "");
    const report = JSON.parse(run.stdout);
    assert.equal(report.status, "error");
    assert.match(report.error, /Ambiguous deployed siblings/);
    assert.equal(report.configs.length, 1);
    assert.equal(report.configs[0].status, "error");
    assert.equal(report.configs[0].error, report.error);
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
      assert.deepEqual(report.configs[0].inputs, [selectedPath]);
      assert.equal("deployed" in report.configs[0], false);
      assert.equal(report.summary.checks, 0);
      assertStoppedBeforeSchema(run.output);
      if (failure === "missing path") assert.ok(report.error.includes(selectedPath), report.error);
      if (failure === "unused label") {
        assert.match(report.error, /never referenced/);
        assert.match(report.error, /&unused/);
      }
      if (failure === "cross-source aliases") {
        const inputsLabel = `the .inputs file ${path.relative(REPOSITORY_ROOT, inputsPath)}`;
        for (const diagnostic of CROSS_SOURCE_ERRORS.diagnostics(inputsLabel))
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
