import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { DEPLOYED_SPEC } from "../src/deployed-addresses";
import { getMissingConfigAliases, loadStateWithSiblings, resolveSiblingFilePath } from "../src/sibling-delegation";
import { composeWithDeployedAddresses, toCrlf, withTemporaryDirectory } from "./delegation-helpers";

const resolveDeployedFilePath = (deployedArgument?: string) => resolveSiblingFilePath(DEPLOYED_SPEC, deployedArgument);

// Include a main-file anchor alongside delegated addresses to exercise both alias sources.
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
  assert.deepEqual(
    labels.toSorted((a, b) => a.localeCompare(b)),
    ["bar", "foo"],
  );
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
  assert.throws(() => composeWithDeployedAddresses(main, DEPLOYED), /move every value to the .deployed file/);
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
  assert.throws(() => composeWithDeployedAddresses(MAIN_CONFIG, deployed), /may only contain/);
});

test("a .deployed file whose sections are all empty is rejected (zero anchors is a mistake)", () => {
  assert.throws(() => composeWithDeployedAddresses(MAIN_CONFIG, "deployed:\n  l1: []\n"), /defines no labeled entries/);
});

test("a .deployed file that is not a mapping is rejected with a file-targeted error", () => {
  assert.throws(
    () => composeWithDeployedAddresses(MAIN_CONFIG, "- just a list\n"),
    /must be a mapping with `deployed:`/,
  );
});

test("a `deployed:` section that is not a mapping of chains is rejected", () => {
  assert.throws(
    () => composeWithDeployedAddresses(MAIN_CONFIG, "deployed: []\n"),
    /must contain a `deployed:` mapping/,
  );
});

test("a chain key holding a mapping instead of a list of labeled addresses is rejected", () => {
  const deployed = `\ndeployed:\n  l1:\n    foo: "0x1111111111111111111111111111111111111111"\n`;
  assert.throws(
    () => composeWithDeployedAddresses(MAIN_CONFIG, deployed),
    /`deployed\.l1` must be a list of labeled addresses/,
  );
});

test("a wholly empty file is rejected with a file-targeted error (either side)", () => {
  // Distinct from the section-less/empty-section cases above: a truncated or placeholder file parses
  // to zero documents, and the error must still name which of the two files it was.
  assert.throws(() => composeWithDeployedAddresses(MAIN_CONFIG, ""), /the \.deployed file is empty/);
  assert.throws(() => composeWithDeployedAddresses("", DEPLOYED), /the main config is empty/);
});

test("a stray anchor on a .deployed collection is rejected (it would shadow other labels)", () => {
  // Anchors outside the labeled entries are invisible to the label collection, so they would bypass
  // the duplicate/collision invariants once the documents are composed.
  const onSection = `\ndeployed: &book\n  l1:\n    - &foo "0x1111111111111111111111111111111111111111"\n`;
  assert.throws(
    () => composeWithDeployedAddresses(MAIN_CONFIG, onSection),
    /defined outside the labeled entries: &book/,
  );
  const onList = DEPLOYED.replace("l1:", "l1: &l1List");
  assert.throws(
    () => composeWithDeployedAddresses(MAIN_CONFIG, onList),
    /defined outside the labeled entries: &l1List/,
  );
});

test("a syntax error in the main config is reported as a parse error, not an invariant violation", () => {
  // An unclosed quote swallows the rest of the file, so no aliases are visible; before the standalone
  // syntax check this surfaced as a bogus "label(s) never referenced in the main config" error.
  const main = `name: "unclosed\n${MAIN_CONFIG}`;
  assert.throws(() => composeWithDeployedAddresses(main, DEPLOYED), /Failed to parse the main config/);
});

test("a one-line flow main config after the --- marker composes with a block sibling", () => {
  const main = `--- {l1: {contracts: {fooContract: {address: *foo, checks: {bar: *bar}}}}}`;
  const { document } = composeWithDeployedAddresses(main, DEPLOYED);
  const result = document as { l1: { contracts: { fooContract: { address: string; checks: { bar: string } } } } };
  assert.equal(result.l1.contracts.fooContract.address, "0x1111111111111111111111111111111111111111");
  assert.equal(result.l1.contracts.fooContract.checks.bar, "0x2222222222222222222222222222222222222222");
});

test("a forward alias error retains the main file's own line and column", () => {
  const main = `refs: [*foo, *bar, *later]\nlocal: &later value\n`;
  assert.throws(
    () => composeWithDeployedAddresses(main, DEPLOYED),
    /Unresolved alias \*later:.*in the main config at line 1, column 20/,
  );
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

test("a %YAML directive in the main config is rejected with a targeted error", () => {
  // Composed sources must use the shared parsing semantics.
  const main = `%YAML 1.2\n---\n${MAIN_CONFIG}`;
  assert.throws(() => composeWithDeployedAddresses(main, DEPLOYED), /main config uses %YAML\/%TAG directives/);
});

test("a %TAG directive in the .deployed file is rejected with a targeted error", () => {
  const deployed = `%TAG !e! tag:example.com,2000:\n---\n${DEPLOYED}`;
  assert.throws(
    () => composeWithDeployedAddresses(MAIN_CONFIG, deployed),
    /\.deployed file uses %YAML\/%TAG directives/,
  );
});

test("a UTF-8 BOM on either file is accepted during parsing (still composes)", () => {
  // A BOM is legal at the start of a file but is content mid-stream: un-stripped, the main config's
  // first key would become "<BOM>misc" and schema validation would fail with invisible-cause errors.
  const BOM = "\u{FEFF}";
  const { document } = composeWithDeployedAddresses(`${BOM}${MAIN_CONFIG}`, `${BOM}${DEPLOYED}`);
  const document_ = document as { misc: string[]; l1: { contracts: { fooContract: { address: string } } } };
  assert.ok(Array.isArray(document_.misc));
  assert.equal(document_.l1.contracts.fooContract.address, "0x1111111111111111111111111111111111111111");
});

test("an indented '...' inside a block scalar is content, not a document-end marker (survives)", () => {
  // Only a column-0 `...` is a document marker; an indented one is scalar content. The old
  // trim-based stripper deleted it, silently corrupting the checked value.
  const main = `${MAIN_CONFIG}notes: |
  line1
  ...
`;
  const { document } = composeWithDeployedAddresses(main, DEPLOYED);
  assert.equal((document as { notes: string }).notes, "line1\n...\n");
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
  withTemporaryDirectory("state-mate-deployed-", (directory) => {
    const subdir = path.join(directory, "subdir");
    fs.mkdirSync(subdir);
    assert.throws(() => resolveDeployedFilePath(subdir), /is not a file/);
  });
});

test("resolveDeployedFilePath: --deployed is the only way in; a neighbouring file is never auto-loaded", () => {
  withTemporaryDirectory("state-mate-deployed-", (directory) => {
    const siblingPath = path.join(directory, "lido.deployed.yaml");
    const variantPath = path.join(directory, "lido.hoodi.deployed.yaml");
    fs.writeFileSync(path.join(directory, "lido.yaml"), MAIN_CONFIG);
    fs.writeFileSync(siblingPath, DEPLOYED);
    fs.writeFileSync(variantPath, DEPLOYED);

    assert.equal(resolveDeployedFilePath(), null);

    assert.equal(resolveDeployedFilePath(siblingPath), siblingPath);
    assert.equal(resolveDeployedFilePath(variantPath), variantPath);

    assert.throws(() => resolveDeployedFilePath(path.join(directory, "missing.yaml")), /not found/);

    // An explicit but EMPTY path (a hollow shell variable) is a hard error too — it must never
    // silently degrade to a standalone run.
    assert.throws(() => resolveDeployedFilePath(""), /is not a file|not found/);
  });
});

test("a config with more aliases than the default budget still composes", () => {
  // Aliases are expanded by toJS(), where the yaml default budget is 100 — and a wiring-only config
  // is made of aliases. Without YAML_TO_JS_OPTIONS lifting the budget this throws "Excessive alias
  // count", which is why maxAliasCount must ride with the toJS options, not the parse options.
  const checks = Array.from({ length: 150 }, (_, index) => `        check${index}: *foo`).join("\n");
  const main = `
l1:
  contracts:
    fooContract:
      address: *bar
      checks:
${checks}
`;
  const { document } = composeWithDeployedAddresses(main, DEPLOYED);
  const checksObject = (document as { l1: { contracts: { fooContract: { checks: Record<string, string> } } } }).l1
    .contracts.fooContract.checks;
  assert.equal(Object.keys(checksObject).length, 150);
  assert.equal(checksObject.check149, "0x1111111111111111111111111111111111111111");
});

test("getMissingConfigAliases lists absent anchors and defers other errors to the parser", () => {
  withTemporaryDirectory("state-mate-delegates-", (directory) => {
    const write = (name: string, text: string) => {
      const filePath = path.join(directory, name);
      fs.writeFileSync(filePath, text);
      return filePath;
    };

    // Wiring only: it references &foo / &bar without defining them.
    assert.deepEqual(getMissingConfigAliases(write("wiring.yaml", MAIN_CONFIG)), ["foo", "bar"]);
    // Self-contained: every alias resolves within the file itself.
    assert.deepEqual(getMissingConfigAliases(write("self.yaml", `${DEPLOYED}${MAIN_CONFIG}`)), []);
    // Leave unreadable, malformed, and multi-document inputs to the normal parser.
    assert.deepEqual(getMissingConfigAliases(write("multi.yaml", `${DEPLOYED}---\n${MAIN_CONFIG}`)), []);
    assert.deepEqual(getMissingConfigAliases(write("broken.yaml", "l1: [unclosed\n")), []);
    assert.deepEqual(getMissingConfigAliases(path.join(directory, "missing.yaml")), []);
    assert.deepEqual(getMissingConfigAliases(write("repeated.yaml", "refs: [*foo, *bar, *foo]\n")), ["foo", "bar"]);
    assert.deepEqual(getMissingConfigAliases(write("forward.yaml", "ref: *foo\nvalue: &foo true\n")), []);
    assert.deepEqual(getMissingConfigAliases(write("malformed.yaml", "refs: [*foo\n")), []);
  });
});

test("loadStateWithSiblings reads both files from disk and composes them", () => {
  withTemporaryDirectory("state-mate-load-", (directory) => {
    const mainPath = path.join(directory, "lido.yaml");
    const deployedPath = path.join(directory, "lido.deployed.yaml");
    fs.writeFileSync(mainPath, MAIN_CONFIG);
    fs.writeFileSync(deployedPath, DEPLOYED);

    const { document, labels } = loadStateWithSiblings(mainPath, [{ path: deployedPath, spec: DEPLOYED_SPEC }]);
    const document_ = document as { l1: { contracts: { fooContract: { address: string } } } };
    assert.deepEqual(labels, [["foo", "bar"]]);
    assert.equal(document_.l1.contracts.fooContract.address, "0x1111111111111111111111111111111111111111");
  });
});

for (const digits of [40, 64]) {
  test(`quoted ${digits / 2}-byte mixed-case hex preserves definitions and consumers`, () => {
    const value = `0x${"aB".repeat(digits / 2)}`;
    const { document, labels } = composeWithDeployedAddresses(
      "consumer: *boundary\n",
      `deployed:\n  l1: [ &boundary "${value}" ]\n`,
    );
    assert.deepEqual(labels, ["boundary"]);
    assert.deepEqual(document, { deployed: { l1: [value] }, consumer: value });
  });
}

for (const hex of [...[39, 41, 63, 65].map((length) => "a".repeat(length)), `${"a".repeat(39)}g`]) {
  test(`rejects quoted invalid hex boundary ${hex.length} digits ending ${hex.at(-1)}`, () => {
    assert.throws(
      () => composeWithDeployedAddresses("consumer: *boundary\n", `deployed:\n  l1: [&boundary "0x${hex}"]\n`),
      /label &boundary is not a valid address/,
    );
  });
}

test("disk loading switches deployed A to B to A without state or conventional fallback", () => {
  withTemporaryDirectory("state-mate-switch-", (directory) => {
    const mainPath = path.join(directory, "wiring.yaml");
    fs.writeFileSync(mainPath, "l1: {contracts: {foo: {address: *selected}}}\n");
    const variants = ["a", "b", "c"].map((hex, index) => {
      const value = `0x${hex.repeat(40)}`;
      const siblingPath = path.join(directory, index === 2 ? "wiring.deployed.yaml" : `${hex}.yaml`);
      fs.writeFileSync(siblingPath, `deployed: {l1: [&selected "${value}"]}\n`);
      return { path: siblingPath, value };
    });
    for (const index of [0, 1, 0]) {
      const selected = variants[index];
      const { document, labels } = loadStateWithSiblings(mainPath, [{ path: selected.path, spec: DEPLOYED_SPEC }]);
      assert.deepEqual(labels, [["selected"]]);
      assert.deepEqual(document, {
        deployed: { l1: [selected.value] },
        l1: { contracts: { foo: { address: selected.value } } },
      });
    }
  });
});
