import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { composeWithDeployedAddresses, DEPLOYED_SPEC, resolveDeployedFilePath } from "../deployed-addresses";
import { deriveSiblingPath, isSiblingFileName } from "../sibling-delegation";

// Full-delegation model: the main config holds ONLY wiring (`*label` aliases) plus its own constant
// anchors (e.g. `&ZERO` in `misc:`). It has no `deployed:` section. The .deployed file is the sole
// source of the address anchors `&foo` / `&bar`.
const MAIN_CONFIG = `
misc:
  - &ZERO "0x0000000000000000000000000000000000000000"
l1:
  rpcUrl: MAIN_RPC_URL
  explorerHostname: api.etherscan.io
  contracts:
    fooContract:
      name: Foo
      address: *foo
      checks:
        bar: *bar
        zero: *ZERO
`;
const DEPLOYED = `
deployed:
  l1:
    - &foo "0x1111111111111111111111111111111111111111"
    - &bar "0x2222222222222222222222222222222222222222"
`;

test("composes cross-file: aliases resolve to .deployed addresses and the deployed section is present", () => {
  const { document, labels } = composeWithDeployedAddresses(MAIN_CONFIG, DEPLOYED);
  const document_ = document as {
    deployed: { l1: string[] };
    l1: { contracts: { fooContract: { address: string; checks: { bar: string; zero: string } } } };
  };
  assert.deepEqual(labels.sort(), ["bar", "foo"]);
  assert.equal(document_.deployed.l1[0], "0x1111111111111111111111111111111111111111");
  assert.equal(document_.l1.contracts.fooContract.address, "0x1111111111111111111111111111111111111111");
  assert.equal(document_.l1.contracts.fooContract.checks.bar, "0x2222222222222222222222222222222222222222");
  // The main config's own anchor still resolves.
  assert.equal(document_.l1.contracts.fooContract.checks.zero, "0x0000000000000000000000000000000000000000");
});

test("invariant #1: an address in .deployed without an &label is rejected", () => {
  const deployed = `
deployed:
  l1:
    - &foo "0x1111111111111111111111111111111111111111"
    - "0x2222222222222222222222222222222222222222"
`;
  assert.throws(() => composeWithDeployedAddresses(MAIN_CONFIG, deployed), /has no &label anchor/);
});

test("invariant #1: a non-scalar entry in .deployed is rejected", () => {
  const deployed = `
deployed:
  l1:
    - &foo "0x1111111111111111111111111111111111111111"
    - &bar
      nested: "0x2222222222222222222222222222222222222222"
`;
  assert.throws(() => composeWithDeployedAddresses(MAIN_CONFIG, deployed), /must be a scalar address/);
});

test("invariant #2: a label never referenced in the main config is rejected", () => {
  const deployed = `
deployed:
  l1:
    - &foo "0x1111111111111111111111111111111111111111"
    - &bar "0x2222222222222222222222222222222222222222"
    - &unused "0x3333333333333333333333333333333333333333"
`;
  assert.throws(() => composeWithDeployedAddresses(MAIN_CONFIG, deployed), /never referenced in the main config/);
});

test("invariant #3: a main config that still has a deployed: section is rejected", () => {
  const main = `
deployed:
  l1:
    - &foo "0x1111111111111111111111111111111111111111"
l1:
  contracts:
    fooContract:
      address: *foo
      checks: {}
`;
  assert.throws(() => composeWithDeployedAddresses(main, DEPLOYED), /move every address to the .deployed file/);
});

test("invariant #4: a duplicate label within the .deployed file is rejected", () => {
  const deployed = `
deployed:
  l1:
    - &foo "0x1111111111111111111111111111111111111111"
  l2:
    - &foo "0x2222222222222222222222222222222222222222"
`;
  assert.throws(() => composeWithDeployedAddresses(MAIN_CONFIG, deployed), /duplicate label &foo/);
});

test("invariant #4: a label colliding with a main-config anchor is rejected", () => {
  const main = `
misc:
  - &foo "0x9999999999999999999999999999999999999999"
l1:
  contracts:
    fooContract:
      address: *foo
      checks:
        bar: *bar
`;
  assert.throws(() => composeWithDeployedAddresses(main, DEPLOYED), /defined in both/);
});

test("a main alias defined neither in main nor .deployed is reported clearly", () => {
  const main = `
l1:
  contracts:
    fooContract:
      address: *foo
      checks:
        bar: *bar
        missing: *nowhere
`;
  assert.throws(() => composeWithDeployedAddresses(main, DEPLOYED), /neither in it nor in the .deployed file/);
});

test("the .deployed file may only contain a deployed: section", () => {
  const deployed = `
deployed:
  l1:
    - &foo "0x1111111111111111111111111111111111111111"
    - &bar "0x2222222222222222222222222222222222222222"
roles:
  - &ADMIN "0x0000000000000000000000000000000000000000000000000000000000000000"
`;
  assert.throws(() => composeWithDeployedAddresses(MAIN_CONFIG, deployed), /may only contain a/);
});

test("a leading --- document marker in the main config is handled (still composes)", () => {
  const main = `---\n${MAIN_CONFIG}`;
  const { document } = composeWithDeployedAddresses(main, DEPLOYED);
  const document_ = document as { l1: { contracts: { fooContract: { address: string } } } };
  assert.equal(document_.l1.contracts.fooContract.address, "0x1111111111111111111111111111111111111111");
});

test("a leading '--- # comment' document marker in the main config is handled (still composes)", () => {
  const main = `--- # lido mainnet\n${MAIN_CONFIG}`;
  const { document } = composeWithDeployedAddresses(main, DEPLOYED);
  const document_ = document as { l1: { contracts: { fooContract: { address: string } } } };
  assert.equal(document_.l1.contracts.fooContract.address, "0x1111111111111111111111111111111111111111");
});

test("H3: a mid-file document marker in .deployed is rejected with a file-targeted error", () => {
  const deployed = `${DEPLOYED}---\nmore: stuff\n`;
  assert.throws(
    () => composeWithDeployedAddresses(MAIN_CONFIG, deployed),
    /\.deployed file must be a single YAML document/,
  );
});

test("H3: a trailing ... document-end marker in .deployed still composes", () => {
  const { document } = composeWithDeployedAddresses(MAIN_CONFIG, `${DEPLOYED}...\n`);
  const document_ = document as { l1: { contracts: { fooContract: { address: string } } } };
  assert.equal(document_.l1.contracts.fooContract.address, "0x1111111111111111111111111111111111111111");
});

test("H3: a trailing '... # comment' document-end marker in .deployed still composes", () => {
  const { document } = composeWithDeployedAddresses(MAIN_CONFIG, `${DEPLOYED}... # end\n`);
  const document_ = document as { l1: { contracts: { fooContract: { address: string } } } };
  assert.equal(document_.l1.contracts.fooContract.address, "0x1111111111111111111111111111111111111111");
});

test("H3: CRLF line endings compose correctly", () => {
  const toCrlf = (text: string) => text.replaceAll("\n", "\r\n");
  const { document } = composeWithDeployedAddresses(toCrlf(MAIN_CONFIG), toCrlf(DEPLOYED));
  const document_ = document as { l1: { contracts: { fooContract: { address: string } } } };
  assert.equal(document_.l1.contracts.fooContract.address, "0x1111111111111111111111111111111111111111");
});

test("H4: a non-address value under deployed: is rejected with a file-targeted error", () => {
  const deployed = `
deployed:
  l1:
    - &foo "REPLACEME"
    - &bar "0x2222222222222222222222222222222222222222"
`;
  assert.throws(() => composeWithDeployedAddresses(MAIN_CONFIG, deployed), /&foo is not a valid address/);
});

test("H2: a directory passed as --deployed is rejected as not a file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "state-mate-deployed-"));
  try {
    const mainPath = path.join(directory, "lido.yaml");
    const subdir = path.join(directory, "subdir");
    fs.writeFileSync(mainPath, MAIN_CONFIG);
    fs.mkdirSync(subdir);
    assert.throws(() => resolveDeployedFilePath(mainPath, subdir), /is not a file/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("deriveSiblingPath inserts the .deployed infix before the extension", () => {
  assert.equal(deriveSiblingPath("/a/b/lido.yaml", DEPLOYED_SPEC.infix), path.join("/a/b", "lido.deployed.yaml"));
  assert.equal(deriveSiblingPath("lido.yml", DEPLOYED_SPEC.infix), "lido.deployed.yml");
});

test("isSiblingFileName recognises .deployed files only", () => {
  assert.equal(isSiblingFileName("lido.deployed.yaml", DEPLOYED_SPEC.infix), true);
  assert.equal(isSiblingFileName("lido.yaml", DEPLOYED_SPEC.infix), false);
  assert.equal(isSiblingFileName("lido.seed.yaml", DEPLOYED_SPEC.infix), false);
});

test("resolveDeployedFilePath: flag wins, convention discovers, missing flag throws", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "state-mate-deployed-"));
  try {
    const mainPath = path.join(directory, "lido.yaml");
    const siblingPath = path.join(directory, "lido.deployed.yaml");
    const variantPath = path.join(directory, "lido.hoodi.deployed.yaml");
    fs.writeFileSync(mainPath, MAIN_CONFIG);

    // No sibling yet, no flag -> standalone.
    assert.equal(resolveDeployedFilePath(mainPath), null);

    // Convention sibling is discovered once it exists.
    fs.writeFileSync(siblingPath, DEPLOYED);
    assert.equal(resolveDeployedFilePath(mainPath), siblingPath);

    // Explicit flag overrides the convention.
    fs.writeFileSync(variantPath, DEPLOYED);
    assert.equal(resolveDeployedFilePath(mainPath, variantPath), variantPath);

    // A main config that is itself a .deployed file never gets its own sibling.
    assert.equal(resolveDeployedFilePath(siblingPath), null);

    // An explicit but missing path is a hard error.
    assert.throws(() => resolveDeployedFilePath(mainPath, path.join(directory, "missing.yaml")), /not found/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
