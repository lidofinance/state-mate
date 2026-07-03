import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEPLOYED_SPEC } from "../deployed-addresses";
import { INPUTS_OVERRIDES_SPEC, INPUTS_SPEC } from "../inputs";
import { composeWithSiblings, resolveExplicitFilePath } from "../sibling-delegation";

// Convenience over the generic engine: a main config + its `.inputs` file + an overrides overlay.
const composeWithOverrides = (mainText: string, inputsText: string, overridesText: string) => {
  const { document, labels, overlayLabels } = composeWithSiblings(
    mainText,
    [{ text: inputsText, spec: INPUTS_SPEC }],
    [{ text: overridesText, spec: INPUTS_OVERRIDES_SPEC }],
  );
  return { document, labels: labels[0], overlayLabels: overlayLabels[0] };
};

// Same full-delegation fixtures as inputs.test.ts: the main config is wiring only; the .inputs file
// is the source of the `config` knobs and the `externals` facts. An overrides file REDEFINES some of
// those values without introducing new labels.
const MAIN_CONFIG = `
misc:
  - &ZERO "0x0000000000000000000000000000000000000000"
l1:
  rpcUrl: MAIN_RPC_URL
  chainId: *chainId
  contracts:
    fooContract:
      name: Foo
      address: *ZERO
      checks:
        name: *lidoName
        limits: *oracleReportLimits
        deposit: *depositContract
`;
const INPUTS = `
config:
  - &lidoName "Liquid staked Ether 2.0"
  - &oracleReportLimits [3600, 1800, 1000, 50]
externals:
  - &depositContract "0x00000000219ab540356cBB839Cbe05303d7705Fa"
  - &chainId 560048
`;

type ComposedDocument = {
  l1: {
    chainId: string;
    contracts: { fooContract: { checks: { name: string; limits: string[]; deposit: string } } };
  };
} & Record<string, unknown>;

test("override: redefines a config scalar; the main alias resolves to the override value", () => {
  const overrides = `
config:
  - &lidoName "stETH"
`;
  const { document, overlayLabels } = composeWithOverrides(MAIN_CONFIG, INPUTS, overrides);
  const document_ = document as ComposedDocument;
  assert.equal(document_.l1.contracts.fooContract.checks.name, "stETH");
  assert.deepEqual(overlayLabels, ["lidoName"]);
  // The other (non-overridden) .inputs values are untouched.
  assert.equal(document_.l1.contracts.fooContract.checks.deposit, "0x00000000219ab540356cBB839Cbe05303d7705Fa");
  assert.equal(document_.l1.chainId, "560048");
});

test("override: redefines an externals address (still address-validated) and resolves", () => {
  const overrides = `
externals:
  - &depositContract "0x1111111111111111111111111111111111111111"
`;
  const { document } = composeWithOverrides(MAIN_CONFIG, INPUTS, overrides);
  assert.equal(
    (document as ComposedDocument).l1.contracts.fooContract.checks.deposit,
    "0x1111111111111111111111111111111111111111",
  );
});

test("override: redefines a config array; resolves to the new array", () => {
  const overrides = `
config:
  - &oracleReportLimits [1, 2, 3, 4]
`;
  const { document } = composeWithOverrides(MAIN_CONFIG, INPUTS, overrides);
  assert.deepEqual((document as ComposedDocument).l1.contracts.fooContract.checks.limits, ["1", "2", "3", "4"]);
});

test("override: redefines a numeric chainId and resolves", () => {
  const overrides = `
externals:
  - &chainId 1
`;
  const { document } = composeWithOverrides(MAIN_CONFIG, INPUTS, overrides);
  assert.equal((document as ComposedDocument).l1.chainId, "1");
});

test("override: the synthetic overlay wrapper key does not leak into the composed document", () => {
  const overrides = `
config:
  - &lidoName "stETH"
`;
  const { document } = composeWithOverrides(MAIN_CONFIG, INPUTS, overrides);
  assert.ok(!("__state_mate_overrides__" in (document as Record<string, unknown>)));
});

test("rule #1: an override label not defined in .inputs is rejected (no new labels)", () => {
  const overrides = `
config:
  - &unknownKnob "x"
`;
  assert.throws(() => composeWithOverrides(MAIN_CONFIG, INPUTS, overrides), /not defined in the .inputs file/);
});

test("rule #2: an override identical to the .inputs value (no-op) is rejected", () => {
  const overrides = `
config:
  - &lidoName "Liquid staked Ether 2.0"
`;
  assert.throws(() => composeWithOverrides(MAIN_CONFIG, INPUTS, overrides), /no-op override.*&lidoName/);
});

test("rule #2: a format-only override (unquoted vs quoted chainId) is a no-op and rejected", () => {
  const overrides = `
externals:
  - &chainId "560048"
`;
  assert.throws(() => composeWithOverrides(MAIN_CONFIG, INPUTS, overrides), /no-op override.*&chainId/);
});

test("rule #2: a same-order array override is a no-op and rejected", () => {
  const overrides = `
config:
  - &oracleReportLimits [3600, 1800, 1000, 50]
`;
  assert.throws(() => composeWithOverrides(MAIN_CONFIG, INPUTS, overrides), /no-op override.*&oracleReportLimits/);
});

test("rule #2: a reordered array is a genuine change and is accepted", () => {
  const overrides = `
config:
  - &oracleReportLimits [1800, 3600, 1000, 50]
`;
  const { document } = composeWithOverrides(MAIN_CONFIG, INPUTS, overrides);
  assert.deepEqual((document as ComposedDocument).l1.contracts.fooContract.checks.limits, [
    "1800",
    "3600",
    "1000",
    "50",
  ]);
});

test("section move: overriding an externals label under config: is rejected", () => {
  const overrides = `
config:
  - &depositContract "0x1111111111111111111111111111111111111111"
`;
  assert.throws(() => composeWithOverrides(MAIN_CONFIG, INPUTS, overrides), /placed under a different section/);
});

test("section move: overriding a config label under externals: is rejected", () => {
  // lidoName is a config knob in .inputs; placing it under externals: would wrongly address-check it.
  const overrides = `
externals:
  - &lidoName "0x1111111111111111111111111111111111111111"
`;
  assert.throws(() => composeWithOverrides(MAIN_CONFIG, INPUTS, overrides), /placed under a different section/);
});

test("per-file: a duplicate label within the overrides file names the overrides file", () => {
  const overrides = `
config:
  - &lidoName "stETH"
  - &lidoName "wstETH"
`;
  assert.throws(
    () => composeWithOverrides(MAIN_CONFIG, INPUTS, overrides),
    /duplicate label &lidoName in the overrides file/,
  );
});

test("per-file: a non-address externals override is rejected", () => {
  const overrides = `
externals:
  - &depositContract "REPLACEME"
`;
  assert.throws(() => composeWithOverrides(MAIN_CONFIG, INPUTS, overrides), /&depositContract is not a valid address/);
});

test("per-file: an override entry without an &label is rejected", () => {
  const overrides = `
config:
  - "stETH"
`;
  assert.throws(() => composeWithOverrides(MAIN_CONFIG, INPUTS, overrides), /has no &label anchor/);
});

test("per-file: a nested anchor inside an override array is rejected", () => {
  const overrides = `
config:
  - &oracleReportLimits [3600, &shadow 1800, 1000, 50]
`;
  assert.throws(
    () => composeWithOverrides(MAIN_CONFIG, INPUTS, overrides),
    /anchor\(s\) in the overrides file defined outside/,
  );
});

test("per-file: the overrides file may only contain config:/externals: sections", () => {
  const overrides = `
config:
  - &lidoName "stETH"
roles:
  - &ADMIN "0x0000000000000000000000000000000000000000000000000000000000000000"
`;
  assert.throws(() => composeWithOverrides(MAIN_CONFIG, INPUTS, overrides), /the overrides file may only contain/);
});

test("per-file: an empty/section-less overrides file is rejected", () => {
  assert.throws(() => composeWithOverrides(MAIN_CONFIG, INPUTS, "{}\n"), /the overrides file must contain/);
});

test("base presence: an overrides file with no .inputs in play is rejected", () => {
  // A `.deployed` sibling satisfies the main aliases (so the alias-resolution check passes); the
  // overlay then has no `.inputs` base to override.
  const main = `
l1:
  contracts:
    fooContract:
      address: *foo
      checks: {}
`;
  const deployed = `
deployed:
  l1:
    - &foo "0x1111111111111111111111111111111111111111"
`;
  const overrides = `
config:
  - &lidoName "stETH"
`;
  assert.throws(
    () =>
      composeWithSiblings(
        main,
        [{ text: deployed, spec: DEPLOYED_SPEC }],
        [{ text: overrides, spec: INPUTS_OVERRIDES_SPEC }],
      ),
    /needs the .inputs file to override/,
  );
});

test("markers: a leading --- in the overrides file composes", () => {
  const overrides = `---
config:
  - &lidoName "stETH"
`;
  const { document } = composeWithOverrides(MAIN_CONFIG, INPUTS, overrides);
  assert.equal((document as ComposedDocument).l1.contracts.fooContract.checks.name, "stETH");
});

test("markers: a mid-file document marker in the overrides file is rejected", () => {
  const overrides = `
config:
  - &lidoName "stETH"
---
more: stuff
`;
  assert.throws(
    () => composeWithOverrides(MAIN_CONFIG, INPUTS, overrides),
    /the overrides file must be a single YAML document/,
  );
});

test("markers: CRLF line endings in the overrides file compose", () => {
  const toCrlf = (text: string) => text.replaceAll("\n", "\r\n");
  const overrides = `
config:
  - &lidoName "stETH"
`;
  const { document } = composeWithSiblings(
    toCrlf(MAIN_CONFIG),
    [{ text: toCrlf(INPUTS), spec: INPUTS_SPEC }],
    [{ text: toCrlf(overrides), spec: INPUTS_OVERRIDES_SPEC }],
  );
  assert.equal((document as ComposedDocument).l1.contracts.fooContract.checks.name, "stETH");
});

test("multi-sibling: .deployed + .inputs + overrides compose together (override wins)", () => {
  const main = `
misc:
  - &ZERO "0x0000000000000000000000000000000000000000"
l1:
  chainId: *chainId
  contracts:
    fooContract:
      address: *foo
      checks:
        name: *lidoName
        deposit: *depositContract
`;
  const deployed = `
deployed:
  l1:
    - &foo "0x1111111111111111111111111111111111111111"
`;
  const inputs = `
config:
  - &lidoName "stETH"
externals:
  - &depositContract "0x00000000219ab540356cBB839Cbe05303d7705Fa"
  - &chainId 560048
`;
  const overrides = `
config:
  - &lidoName "wstETH"
`;
  const { document, labels, overlayLabels } = composeWithSiblings(
    main,
    [
      { text: deployed, spec: DEPLOYED_SPEC },
      { text: inputs, spec: INPUTS_SPEC },
    ],
    [{ text: overrides, spec: INPUTS_OVERRIDES_SPEC }],
  );
  const document_ = document as {
    l1: { chainId: string; contracts: { fooContract: { address: string; checks: { name: string; deposit: string } } } };
  };
  assert.equal(document_.l1.contracts.fooContract.address, "0x1111111111111111111111111111111111111111");
  assert.equal(document_.l1.contracts.fooContract.checks.name, "wstETH"); // override beats the .inputs "stETH"
  assert.equal(document_.l1.contracts.fooContract.checks.deposit, "0x00000000219ab540356cBB839Cbe05303d7705Fa");
  assert.equal(document_.l1.chainId, "560048");
  assert.deepEqual(labels[0].toSorted(), ["foo"]);
  assert.deepEqual(labels[1].toSorted(), ["chainId", "depositContract", "lidoName"]);
  assert.deepEqual(overlayLabels[0], ["lidoName"]);
});

test("multi-sibling: overriding a .deployed-only label is rejected (overrides target .inputs)", () => {
  const main = `
l1:
  contracts:
    fooContract:
      address: *foo
      checks:
        name: *lidoName
`;
  const deployed = `
deployed:
  l1:
    - &foo "0x1111111111111111111111111111111111111111"
`;
  const inputs = `
config:
  - &lidoName "stETH"
`;
  const overrides = `
config:
  - &foo "0x2222222222222222222222222222222222222222"
`;
  assert.throws(
    () =>
      composeWithSiblings(
        main,
        [
          { text: deployed, spec: DEPLOYED_SPEC },
          { text: inputs, spec: INPUTS_SPEC },
        ],
        [{ text: overrides, spec: INPUTS_OVERRIDES_SPEC }],
      ),
    /not defined in the .inputs file/,
  );
});

test("multi-overlay: two overlays with distinct labels both apply (one synthetic block, no key clash)", () => {
  const overridesA = `
config:
  - &lidoName "stETH"
`;
  const overridesB = `
externals:
  - &chainId 1
`;
  const { document, overlayLabels } = composeWithSiblings(
    MAIN_CONFIG,
    [{ text: INPUTS, spec: INPUTS_SPEC }],
    [
      { text: overridesA, spec: INPUTS_OVERRIDES_SPEC },
      { text: overridesB, spec: INPUTS_OVERRIDES_SPEC },
    ],
  );
  const document_ = document as ComposedDocument;
  assert.equal(document_.l1.contracts.fooContract.checks.name, "stETH");
  assert.equal(document_.l1.chainId, "1");
  assert.deepEqual(overlayLabels, [["lidoName"], ["chainId"]]);
});

test("multi-overlay: the same label redefined by two overlays is rejected", () => {
  const overridesA = `
config:
  - &lidoName "stETH"
`;
  const overridesB = `
config:
  - &lidoName "wstETH"
`;
  assert.throws(
    () =>
      composeWithSiblings(
        MAIN_CONFIG,
        [{ text: INPUTS, spec: INPUTS_SPEC }],
        [
          { text: overridesA, spec: INPUTS_OVERRIDES_SPEC },
          { text: overridesB, spec: INPUTS_OVERRIDES_SPEC },
        ],
      ),
    /overridden by more than one overrides file/,
  );
});

test("non-regression: composeWithSiblings without overlays still composes (overlayLabels empty)", () => {
  const { document, overlayLabels } = composeWithSiblings(MAIN_CONFIG, [{ text: INPUTS, spec: INPUTS_SPEC }]);
  assert.deepEqual(overlayLabels, []);
  assert.equal((document as ComposedDocument).l1.contracts.fooContract.checks.name, "Liquid staked Ether 2.0");
});

test("resolveExplicitFilePath: returns the resolved path, errors on missing or non-file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "state-mate-overrides-"));
  try {
    const file = path.join(directory, "lido.overrides.yaml");
    fs.writeFileSync(file, 'config:\n  - &lidoName "stETH"\n');
    assert.equal(resolveExplicitFilePath("--overrides", file), file);
    assert.throws(() => resolveExplicitFilePath("--overrides", path.join(directory, "missing.yaml")), /not found/);
    assert.throws(() => resolveExplicitFilePath("--overrides", directory), /is not a file/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
