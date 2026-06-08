import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { composeWithDeployedAddresses, DEPLOYED_SPEC } from "../deployed-addresses";
import { composeWithInputs, INPUTS_SPEC, resolveInputsFilePath } from "../inputs";
import { composeWithSiblings } from "../sibling-delegation";

// Full-delegation model: the main config holds ONLY wiring (`*label` aliases) plus its own constant
// anchors (e.g. `&ZERO` in `misc:`). It has no `config:`/`externals:` sections. The .inputs file is
// the sole source of the project-chosen `config` knobs and the fixed `externals` facts.
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

test("composes cross-file: aliases resolve to .inputs config knobs and externals", () => {
  const { document, labels } = composeWithInputs(MAIN_CONFIG, INPUTS);
  const document_ = document as {
    config: unknown[];
    externals: unknown[];
    l1: {
      chainId: string;
      contracts: { fooContract: { checks: { name: string; limits: string[]; deposit: string } } };
    };
  };
  assert.deepEqual(labels.sort(), ["chainId", "depositContract", "lidoName", "oracleReportLimits"]);
  const checks = document_.l1.contracts.fooContract.checks;
  assert.equal(checks.name, "Liquid staked Ether 2.0");
  // Numeric YAML values are stringified by the shared bigint reviver (as chainId is below).
  assert.deepEqual(checks.limits, ["3600", "1800", "1000", "50"]);
  assert.equal(checks.deposit, "0x00000000219ab540356cBB839Cbe05303d7705Fa");
  // chainId is a numeric external; it composes and resolves at l1.chainId (stringified by the reviver).
  assert.equal(document_.l1.chainId, "560048");
  // Both delegated sections are present in the composed document.
  assert.ok(Array.isArray(document_.config) && Array.isArray(document_.externals));
});

test("config: allows an anchored array and scalar, with no address-format check", () => {
  // `oracleReportLimits` is an anchored array and `lidoName` is a non-address string — both fine in config.
  const { labels } = composeWithInputs(MAIN_CONFIG, INPUTS);
  assert.ok(labels.includes("oracleReportLimits"));
  assert.ok(labels.includes("lidoName"));
});

test("externals: a non-address string value is rejected", () => {
  const inputs = `
config:
  - &lidoName "Liquid staked Ether 2.0"
  - &oracleReportLimits [3600, 1800, 1000, 50]
externals:
  - &depositContract "REPLACEME"
  - &chainId 560048
`;
  assert.throws(() => composeWithInputs(MAIN_CONFIG, inputs), /&depositContract is not a valid address/);
});

test("externals: a numeric chainId is accepted (exempt from the address check) and resolves", () => {
  const { document } = composeWithInputs(MAIN_CONFIG, INPUTS);
  const document_ = document as { l1: { chainId: string } };
  assert.equal(document_.l1.chainId, "560048");
});

test("externals: a QUOTED chainId (the existing config convention) is accepted", () => {
  // Existing configs write chainId quoted, e.g. `&CHAIN_ID "560048"`. Must not be rejected as a non-address.
  const inputs = INPUTS.replace("&chainId 560048", '&chainId "560048"');
  const { document } = composeWithInputs(MAIN_CONFIG, inputs);
  const document_ = document as { l1: { chainId: string } };
  assert.equal(document_.l1.chainId, "560048");
});

test("externals: an UNQUOTED hex address (parsed by YAML to a non-address bigint) is rejected", () => {
  const inputs = INPUTS.replace(
    '&depositContract "0x00000000219ab540356cBB839Cbe05303d7705Fa"',
    "&depositContract 0x00000000219ab540356cBB839Cbe05303d7705Fa",
  );
  assert.throws(() => composeWithInputs(MAIN_CONFIG, inputs), /&depositContract is not a valid address/);
});

test("externals: a null/empty value is rejected", () => {
  const inputs = INPUTS.replace('&depositContract "0x00000000219ab540356cBB839Cbe05303d7705Fa"', "&depositContract");
  assert.throws(() => composeWithInputs(MAIN_CONFIG, inputs), /&depositContract is not a valid address/);
});

test("invariant: an entry without an &label is rejected", () => {
  const inputs = `
config:
  - &lidoName "Liquid staked Ether 2.0"
  - &oracleReportLimits [3600, 1800, 1000, 50]
externals:
  - "0x00000000219ab540356cBB839Cbe05303d7705Fa"
  - &chainId 560048
`;
  assert.throws(() => composeWithInputs(MAIN_CONFIG, inputs), /has no &label anchor/);
});

test("invariant: a label never referenced in the main config is rejected", () => {
  const inputs = `${INPUTS}  - &unused "0x3333333333333333333333333333333333333333"\n`;
  assert.throws(() => composeWithInputs(MAIN_CONFIG, inputs), /never referenced in the main config/);
});

test("invariant: a main config that still has a config:/externals: section is rejected", () => {
  const main = `
config:
  - &lidoName "Liquid staked Ether 2.0"
l1:
  contracts:
    fooContract:
      checks:
        name: *lidoName
`;
  assert.throws(() => composeWithInputs(main, INPUTS), /move every value to the .inputs file/);
});

test("invariant: a duplicate label within the .inputs file is rejected", () => {
  const inputs = `
config:
  - &lidoName "Liquid staked Ether 2.0"
externals:
  - &lidoName "0x00000000219ab540356cBB839Cbe05303d7705Fa"
`;
  assert.throws(() => composeWithInputs(MAIN_CONFIG, inputs), /duplicate label &lidoName/);
});

test("invariant: a label colliding with a main-config anchor is rejected", () => {
  const main = `
misc:
  - &lidoName "0x9999999999999999999999999999999999999999"
l1:
  chainId: *chainId
  contracts:
    fooContract:
      checks:
        name: *lidoName
        limits: *oracleReportLimits
        deposit: *depositContract
`;
  assert.throws(() => composeWithInputs(main, INPUTS), /defined in both/);
});

test("the .inputs file may only contain config:/externals: sections", () => {
  const inputs = `
config:
  - &lidoName "Liquid staked Ether 2.0"
roles:
  - &ADMIN "0x0000000000000000000000000000000000000000000000000000000000000000"
`;
  assert.throws(() => composeWithInputs(MAIN_CONFIG, inputs), /may only contain/);
});

test("a leading --- document marker in the .inputs file is handled (still composes)", () => {
  const { document } = composeWithInputs(MAIN_CONFIG, `---\n${INPUTS}`);
  const document_ = document as { l1: { contracts: { fooContract: { checks: { name: string } } } } };
  assert.equal(document_.l1.contracts.fooContract.checks.name, "Liquid staked Ether 2.0");
});

test("H3: a mid-file document marker in .inputs is rejected with a file-targeted error", () => {
  const inputs = `${INPUTS}---\nmore: stuff\n`;
  assert.throws(() => composeWithInputs(MAIN_CONFIG, inputs), /\.inputs file must be a single YAML document/);
});

test("H3: a trailing ... document-end marker in .inputs still composes", () => {
  const { document } = composeWithInputs(MAIN_CONFIG, `${INPUTS}...\n`);
  const document_ = document as { l1: { contracts: { fooContract: { checks: { name: string } } } } };
  assert.equal(document_.l1.contracts.fooContract.checks.name, "Liquid staked Ether 2.0");
});

test("H3: CRLF line endings compose correctly", () => {
  const toCrlf = (text: string) => text.replaceAll("\n", "\r\n");
  const { document } = composeWithInputs(toCrlf(MAIN_CONFIG), toCrlf(INPUTS));
  const document_ = document as { l1: { contracts: { fooContract: { checks: { deposit: string } } } } };
  assert.equal(document_.l1.contracts.fooContract.checks.deposit, "0x00000000219ab540356cBB839Cbe05303d7705Fa");
});

test("resolveInputsFilePath: flag wins, convention discovers, missing flag throws", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "state-mate-inputs-"));
  try {
    const mainPath = path.join(directory, "lido.yaml");
    const siblingPath = path.join(directory, "lido.inputs.yaml");
    const variantPath = path.join(directory, "lido.hoodi.inputs.yaml");
    fs.writeFileSync(mainPath, MAIN_CONFIG);

    // No sibling yet, no flag -> standalone.
    assert.equal(resolveInputsFilePath(mainPath), null);

    // Convention sibling is discovered once it exists.
    fs.writeFileSync(siblingPath, INPUTS);
    assert.equal(resolveInputsFilePath(mainPath), siblingPath);

    // Explicit flag overrides the convention.
    fs.writeFileSync(variantPath, INPUTS);
    assert.equal(resolveInputsFilePath(mainPath, variantPath), variantPath);

    // A main config that is itself a .inputs file never gets its own sibling.
    assert.equal(resolveInputsFilePath(siblingPath), null);

    // An explicit but missing path is a hard error.
    assert.throws(() => resolveInputsFilePath(mainPath, path.join(directory, "missing.yaml")), /not found/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("multi-sibling: a .deployed and a .inputs file compose together", () => {
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
  const { document, labels } = composeWithSiblings(main, [
    { text: deployed, spec: DEPLOYED_SPEC },
    { text: inputs, spec: INPUTS_SPEC },
  ]);
  const document_ = document as {
    l1: { chainId: string; contracts: { fooContract: { address: string; checks: { name: string; deposit: string } } } };
  };
  assert.deepEqual(labels[0].sort(), ["foo"]);
  assert.deepEqual(labels[1].sort(), ["chainId", "depositContract", "lidoName"]);
  assert.equal(document_.l1.contracts.fooContract.address, "0x1111111111111111111111111111111111111111");
  assert.equal(document_.l1.contracts.fooContract.checks.name, "stETH");
  assert.equal(document_.l1.chainId, "560048");
});

test("multi-sibling: a label colliding across the two sibling files is rejected", () => {
  const main = `
l1:
  contracts:
    fooContract:
      address: *shared
      checks: {}
`;
  const deployed = `
deployed:
  l1:
    - &shared "0x1111111111111111111111111111111111111111"
`;
  const inputs = `
externals:
  - &shared "0x2222222222222222222222222222222222222222"
`;
  assert.throws(
    () =>
      composeWithSiblings(main, [
        { text: deployed, spec: DEPLOYED_SPEC },
        { text: inputs, spec: INPUTS_SPEC },
      ]),
    /defined in more than one delegated file/,
  );
});

// Sanity: the existing .deployed wrapper still works through the shared engine.
test("the .deployed wrapper composes via the shared engine", () => {
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
  const { document } = composeWithDeployedAddresses(main, deployed);
  const document_ = document as { l1: { contracts: { fooContract: { address: string } } } };
  assert.equal(document_.l1.contracts.fooContract.address, "0x1111111111111111111111111111111111111111");
});
