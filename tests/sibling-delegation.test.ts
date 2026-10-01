import assert from "node:assert/strict";
import { test } from "node:test";

import * as YAML from "yaml";

import { YAML_PARSE_OPTIONS, YAML_TO_JS_OPTIONS } from "../src/common";
import { DEPLOYED_SPEC } from "../src/deployed-addresses";
import { INPUTS_SPEC } from "../src/inputs";
import { composeWithSiblings } from "../src/sibling-delegation";
import { CROSS_SOURCE_ERRORS, composeWithInputs } from "./delegation-helpers";

const INPUT = "config: [&value true]\n";

for (const spec of [DEPLOYED_SPEC, INPUTS_SPEC]) {
  const siblingText = (value: string) =>
    spec === DEPLOYED_SPEC ? `deployed: {l1: [&value ${value}]}\n` : `externals: [&value ${value}]\n`;
  for (const digits of [40, 64]) {
    const literal = `0x00${"aB".repeat((digits - 2) / 2)}`;
    test(`${spec.fileLabel}: unquoted ${digits / 2}-byte hex retains its spelling and explains quoting`, () => {
      assert.throws(() => composeWithSiblings("ref: *value\n", [{ text: siblingText(literal), spec }]), {
        message:
          `label &value is not a valid address: unquoted hex literal ${literal}. ` +
          `Quote the value to preserve it as an address or hash. (in ${spec.fileLabel})`,
      });
    });
    test(`${spec.fileLabel}: quoting the ${digits / 2}-byte hex preserves the address or hash`, () => {
      const { document } = composeWithSiblings("ref: *value\n", [{ text: siblingText(`"${literal}"`), spec }]);
      assert.equal((document as { ref: string }).ref, literal);
    });
  }
  test(`${spec.fileLabel}: other invalid values retain their diagnostic`, () => {
    assert.throws(() => composeWithSiblings("ref: *value\n", [{ text: siblingText('"REPLACEME"'), spec }]), {
      message: `label &value is not a valid address: REPLACEME (in ${spec.fileLabel})`,
    });
  });
}

test("config hex numbers and external decimal IDs keep their numeric semantics", () => {
  const { document } = composeWithInputs(
    "refs: [*hex, *decimal, *quoted]\n",
    'config: [&hex 0x0010]\nexternals: [&decimal 560048, &quoted "16015286601757825753"]\n',
  );
  assert.deepEqual((document as { refs: string[] }).refs, ["16", "560048", "16015286601757825753"]);
});

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
  assert.deepEqual(Object.keys(result), ["externals", "config", "refs"]);
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

// Two sibling files of one kind hold parts of one owned section: the parts unite in selection
// order, so the composed document has one `config:` list and both labels resolve.
test("an owned section split across two sibling files is concatenated in selection order", () => {
  const { document, labels } = composeWithSiblings("refs: [*one, *two]\n", [
    { text: "# first\nconfig: [&one true]\n", spec: INPUTS_SPEC, label: "first inputs" },
    { text: "# second\n\nconfig: [&two false]\n", spec: INPUTS_SPEC, label: "second inputs" },
  ]);
  assert.deepEqual(document, { config: [true, false], refs: [true, false] });
  assert.deepEqual(labels, [["one"], ["two"]]);
});

test("a per-file label names the file in every diagnostic the engine raises about it", () => {
  const first = { text: "config: [&one true]\n", spec: INPUTS_SPEC, label: "first inputs" };
  const second = (text: string) => ({ text, spec: INPUTS_SPEC, label: "second inputs" });
  assert.throws(
    () => composeWithSiblings("refs: [*one, *two, *three]\n", [first, second("config: [&two false, &two 7]\n")]),
    /duplicate label &two \(in second inputs\)/,
  );
  assert.throws(
    () => composeWithSiblings("refs: [*one, *two]\n", [first, second("externals: [&two REPLACEME]\n")]),
    /label &two is not a valid address: REPLACEME \(in second inputs\)/,
  );
  assert.throws(
    () => composeWithSiblings("refs: [*one]\n", [first, second("config: [&two false]\n")]),
    /label\(s\) in second inputs are never referenced in the main config: &two/,
  );
  assert.throws(
    () => composeWithSiblings("refs: [*one, *two]\n", [first, second("deployed: {l1: [&two true]}\n")]),
    /second inputs may only contain `externals:` and\/or `config:` section\(s\), but also has: deployed/,
  );
  assert.throws(
    () => composeWithSiblings("refs: [*one, *two, *three]\n", [first, second("config: [&two false]\n")]),
    /defined neither in it nor in first inputs \/ second inputs: &three/,
  );
  assert.throws(
    () => composeWithSiblings("config: []\nrefs: [*one, *two]\n", [first, second("config: [&two false]\n")]),
    /main config still has `config:` section\(s\); move every value to first inputs or second inputs so/,
  );
});

test("a label defined in two sibling files of one kind is rejected, naming the label and both files", () => {
  assert.throws(
    () =>
      composeWithSiblings("refs: [*one]\n", [
        { text: "config: [&one true]\n", spec: INPUTS_SPEC, label: "first inputs" },
        { text: "config: [&one false]\n", spec: INPUTS_SPEC, label: "second inputs" },
      ]),
    /label\(s\) defined in more than one delegated file: &one \(in first inputs and second inputs\)/,
  );
});

test("a label defined in a sibling and in the main config is rejected even with several siblings", () => {
  assert.throws(
    () =>
      composeWithSiblings("misc: [&two 1]\nrefs: [*one, *two]\n", [
        { text: "config: [&one true]\n", spec: INPUTS_SPEC, label: "first inputs" },
        { text: "config: [&two false]\n", spec: INPUTS_SPEC, label: "second inputs" },
      ]),
    /label\(s\) defined in both the main config and second inputs: &two/,
  );
});

test("an alias in a later sibling file resolves an anchor from an earlier one, not the reverse", () => {
  const first = { text: "config: [&one true]\n", spec: INPUTS_SPEC, label: "first inputs" };
  const second = { text: "config: [&two [*one]]\n", spec: INPUTS_SPEC, label: "second inputs" };
  const { document } = composeWithSiblings("refs: [*one, *two]\n", [first, second]);
  assert.deepEqual(document, { config: [true, [true]], refs: [true, [true]] });
  assert.throws(
    () => composeWithSiblings("refs: [*one, *two]\n", [second, first]),
    /Unresolved alias \*one: the anchor must be set before the alias \(in second inputs at line 1, column 16\), but &one is only set later \(in first inputs at line 1, column 15\)/,
  );
});

// The composed document lays a kind's sections out in its spec's order (`externals:` before
// `config:`), so a file may write them in any order and a `config:` array still finds an external.
test("a file's own section order never decides whether an alias finds its anchor", () => {
  const x = "0x1111111111111111111111111111111111111111";
  const y = "0x2222222222222222222222222222222222222222";
  const first = { text: `config: [&flag true]\nexternals: [&x "${x}"]\n`, spec: INPUTS_SPEC, label: "first inputs" };
  const second = {
    text: `externals: [&y "${y}"]\nconfig: [&pair [*y, *x]]\n`,
    spec: INPUTS_SPEC,
    label: "second inputs",
  };
  const { document } = composeWithSiblings("refs: [*flag, *x, *y, *pair]\n", [first, second]);
  assert.deepEqual(document, { externals: [x, y], config: [true, [y, x]], refs: [true, x, y, [y, x]] });
  assert.deepEqual(Object.keys(document as object), ["externals", "config", "refs"]);
});

// The layout, not argument order, decides what an earlier file's `config:` array may alias: a
// later file's external is laid out before every `config:` entry, a later file's `config:` entry after.
test("an earlier file's config array may alias a later file's external, not its config entry", () => {
  const y = "0x2222222222222222222222222222222222222222";
  const first = { text: "config: [&pair [*y]]\n", spec: INPUTS_SPEC, label: "first inputs" };
  const second = { text: `externals: [&y "${y}"]\n`, spec: INPUTS_SPEC, label: "second inputs" };
  const { document } = composeWithSiblings("refs: [*pair, *y]\n", [first, second]);
  assert.deepEqual(document, { externals: [y], config: [[y]], refs: [[y], y] });

  const laterConfig = { text: "config: [&y 1]\n", spec: INPUTS_SPEC, label: "second inputs" };
  assert.throws(
    () => composeWithSiblings("refs: [*pair, *y]\n", [first, laterConfig]),
    /Unresolved alias \*y: the anchor must be set before the alias \(in first inputs at line 1, column 17\), but &y is only set later \(in second inputs at line 1, column 13\)/,
  );
});

test("sections of different kinds never merge: two kinds owning one key are rejected before assembly", () => {
  const other = { ...INPUTS_SPEC, fileLabel: "the .misc file", ownedSectionKeys: ["config", "misc"] };
  assert.throws(
    () =>
      composeWithSiblings("refs: [*one, *two]\n", [
        { text: "config: [&one true]\n", spec: INPUTS_SPEC },
        { text: "config: [&two true]\n", spec: other },
      ]),
    /`config:` is owned by both the .inputs file and the .misc file; sibling kinds must own distinct sections/,
  );
});

test("a sibling section the main config also holds is an ownership error, whatever the spec owns", () => {
  const spec = { ...INPUTS_SPEC, ownedSectionKeys: ["config", "misc"] };
  assert.throws(
    () => composeWithSiblings("misc: [1]\nrefs: [*one]\n", [{ text: "misc: [&one true]\n", spec }]),
    /main config still has `misc:` section\(s\)/,
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
      for (const diagnostic of CROSS_SOURCE_ERRORS.diagnostics())
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
