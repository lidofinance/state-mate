import assert from "node:assert/strict";
import { test } from "node:test";

import * as YAML from "yaml";

import { YAML_PARSE_OPTIONS, YAML_TO_JS_OPTIONS } from "../src/common";
import { DEPLOYED_SPEC } from "../src/deployed-addresses";
import { INPUTS_SPEC } from "../src/inputs";
import { composeWithSiblings } from "../src/sibling-delegation";
import { CROSS_SOURCE_ERRORS, composeWithInputs } from "./delegation-helpers";

const INPUT = "config: [&value true]\n";

test("flow sibling and block main preserve types, tags, repeated aliases, and entry order", () => {
  const inputs =
    '\uFEFF--- {config: [&values [true, false, null, 16015286601757825753, !!str 123]], externals: [&address "0x1111111111111111111111111111111111111111"]}\n...\n';
  const main = "\n# Wiring\nrefs: [*values, *values, *address]\n";
  const { document } = composeWithInputs(main, inputs);
  const result = document as { config: unknown[]; externals: string[]; refs: unknown[] };
  const expected = YAML.parseDocument(inputs, YAML_PARSE_OPTIONS).toJS(YAML_TO_JS_OPTIONS);
  assert.deepEqual(result.config, expected.config);
  assert.deepEqual(result.externals, expected.externals);
  assert.deepEqual(result.refs, [expected.config[0], expected.config[0], expected.externals[0]]);
  assert.deepEqual(Object.keys(result), ["config", "externals", "refs"]);
});

test("local repeated anchor names resolve to the nearest preceding definition", () => {
  const main = "first: &local one\nbefore: *local\nsecond: &local two\nafter: [*local, *value]\n";
  const { document } = composeWithInputs(main, INPUT);
  assert.deepEqual(document, { config: [true], first: "one", before: "one", second: "two", after: ["two", true] });
});

test("aliases inside input arrays resolve preceding entries", () => {
  const { document } = composeWithInputs("refs: [*value, *array]\n", "config: [&value true, &array [*value]]\n");
  assert.deepEqual(document, { config: [true, [true]], refs: [true, [true]] });
});

test("forward aliases inside input arrays point into the sibling", () => {
  assert.throws(
    () => composeWithInputs("refs: [*value, *array]\n", "# inputs\nconfig:\n  - &array [*value]\n  - &value true\n"),
    /Unresolved alias \*value:.*in the .inputs file at line 3, column 13/,
  );
});

test("missing aliases inside input arrays point into the sibling", () => {
  assert.throws(
    () => composeWithInputs("ref: *array\n", "config: [&array [*missing]]\n"),
    /Unresolved alias \*missing:.*in the .inputs file at line 1, column 18/,
  );
});

test("aliases across sibling arrays follow caller order", () => {
  const deployed = {
    text: 'deployed: {l1: [&address "0x1111111111111111111111111111111111111111"]}\n',
    spec: DEPLOYED_SPEC,
  };
  const inputs = { text: "config: [&array [*address]]\n", spec: INPUTS_SPEC };
  const main = "refs: [*address, *array]\n";
  const { document } = composeWithSiblings(main, [deployed, inputs]);
  const result = document as { refs: [string, string[]] };
  assert.deepEqual(result.refs[1], [result.refs[0]]);
  assert.throws(
    () => composeWithSiblings(main, [inputs, deployed]),
    /Unresolved alias \*address:.*in the .inputs file at line 1, column 18/,
  );
});

test("duplicate root keys across siblings identify both original definitions", () => {
  assert.throws(
    () =>
      composeWithSiblings("refs: [*one, *two]\n", [
        { text: "# first\nconfig: [&one true]\n", spec: { ...INPUTS_SPEC, fileLabel: "first inputs" } },
        { text: "# second\n\nconfig: [&two false]\n", spec: { ...INPUTS_SPEC, fileLabel: "second inputs" } },
      ]),
    /Duplicate top-level key 'config' \(in second inputs at line 3, column 1; first defined in first inputs at line 2, column 1\)/,
  );
});

test("duplicate keys within a source remain parser errors", () => {
  assert.throws(
    () => composeWithInputs("ref: *value\nref: *value\n", INPUT),
    /Failed to parse the main config:.*\n.*unique/s,
  );
});

for (const main of ["[*value]", "*value", "scalar", "null"]) {
  test(`a non-mapping main root is rejected: ${main}`, () => {
    assert.throws(() => composeWithInputs(main, INPUT), /main config must contain a mapping.*line 1, column 1/);
  });
}

for (const key of ["1", "true", "null", "[a, b]", "{a: b}", "*value"]) {
  test(`unsupported main root key has source context: ${key}`, () => {
    assert.throws(
      () => composeWithInputs(`\n? ${key}\n: *value\n`, INPUT),
      /Top-level keys must be strings \(in the main config at line 2, column 3\)/,
    );
  });
}

for (const metadata of ["&root", "!!map", "!custom"]) {
  test(`main root metadata is rejected explicitly: ${metadata}`, () => {
    assert.throws(
      () => composeWithInputs(`--- ${metadata}\nref: *value\n`, INPUT),
      /Root anchors and tags are unsupported.*in the main config at line 2, column 1/,
    );
  });
  test(`sibling root metadata is rejected explicitly: ${metadata}`, () => {
    assert.throws(
      () => composeWithInputs("ref: *value\n", `--- ${metadata}\n${INPUT}`),
      /Root anchors and tags are unsupported.*in the .inputs file at line 2, column 1/,
    );
  });
}

test("missing main aliases retain source positions after differently sized siblings", () => {
  assert.throws(
    () => composeWithInputs("\uFEFF---\r\nref: *value\r\nmissing: *unknown\r\n", `\n\n\n${INPUT}`),
    /defined neither.*&unknown \(in the main config at line 3, column 10\)/,
  );
});

test("all missing main labels and forward references are reported in one run", () => {
  assert.throws(
    () => composeWithInputs("refs: [*value, *first, *later, *second]\nlocal: &later true\n", INPUT),
    (error: Error) => {
      assert.match(error.message, /&first \(in the main config at line 1, column 16\)/);
      assert.match(error.message, /\*later: the anchor must be set before the alias/);
      assert.match(error.message, /&second \(in the main config at line 1, column 32\)/);
      return true;
    },
  );
});

test("an absent sibling anchor is distinguished from a forward reference", () => {
  assert.throws(
    () => composeWithInputs("refs: [*array, *later]\n", "config: [&array [*missing, *later], &later true]\n"),
    (error: Error) => {
      assert.match(error.message, /\*missing: anchor is not defined in any composed source/);
      assert.match(error.message, /\*later: the anchor must be set before the alias/);
      return true;
    },
  );
});

test("a self-referential input array fails with a source-local cycle diagnostic", () => {
  assert.throws(
    () => composeWithInputs("ref: *array\n", "config: [&array [*array]]\n"),
    /Cyclic alias \*array: references an ancestor collection \(in the .inputs file at line 1, column 18\)/,
  );
});

test("an indirect main cycle through nested collections is rejected before conversion", () => {
  assert.throws(
    () => composeWithInputs("ref: *value\nlocal: &outer {nested: &inner [*outer]}\n", INPUT),
    /Cyclic alias \*outer:.*in the main config at line 2, column 32/,
  );
});

test("a shadowed ancestor name can refer to a non-ancestor without forming a cycle", () => {
  const { document } = composeWithInputs("ref: *value\nlocal: &same [&same leaf, *same]\n", INPUT);
  assert.deepEqual(document, { config: [true], ref: true, local: ["leaf", "leaf"] });
});

test("composition without siblings gives a complete missing-label diagnostic", () => {
  assert.throws(() => composeWithSiblings("ref: *missing\n", []), {
    message: "the main config references label(s) not defined in it: &missing (in the main config at line 1, column 6)",
  });
  assert.deepEqual(composeWithSiblings("local: &value true\nref: *value\n", []), {
    document: { local: true, ref: true },
    labels: [],
  });
});

test("alias diagnostics aggregate missing and forward references across sibling and main", () => {
  assert.throws(
    () => composeWithInputs(CROSS_SOURCE_ERRORS.main, CROSS_SOURCE_ERRORS.inputs),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      for (const diagnostic of CROSS_SOURCE_ERRORS.diagnostics)
        assert.ok(error.message.includes(diagnostic), error.message);
      return true;
    },
  );
});

test("a sibling cycle does not hide subsequent missing aliases in either source", () => {
  assert.throws(
    () => composeWithInputs("refs: [*values, *mainMissing]\n", "config: [&values [*values, *inputMissing]]\n"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      for (const diagnostic of [
        "Cyclic alias *values: references an ancestor collection (in the .inputs file at line 1, column 19)",
        "Unresolved alias *inputMissing: anchor is not defined in any composed source (in the .inputs file at line 1, column 28)",
        "&mainMissing (in the main config at line 1, column 17)",
      ])
        assert.ok(error.message.includes(diagnostic), error.message);
      return true;
    },
  );
});
