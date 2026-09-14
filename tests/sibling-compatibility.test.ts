import assert from "node:assert/strict";
import { test } from "node:test";

import * as YAML from "yaml";

import { YAML_PARSE_OPTIONS, YAML_TO_JS_OPTIONS } from "../src/common";
import { DEPLOYED_SPEC } from "../src/deployed-addresses";
import { INPUTS_SPEC } from "../src/inputs";
import { composeWithSiblings } from "../src/sibling-delegation";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER_ADDRESS = "0x2222222222222222222222222222222222222222";

// Inline inputs here are a representation oracle, not an allowed CLI configuration.
// Each standalone reference is explicit, so fixture splitting cannot silently skip cases.
const fixtures = [
  {
    name: "deployed addresses and local main anchors",
    standalone: `deployed:
  l1: [&address "${ADDRESS}"]
misc: [&local true]
l1:
  contracts:
    foo: {address: *address, checks: {enabled: *local}}
`,
    siblings: [{ text: `deployed: {l1: [&address "${ADDRESS}"]}\n`, spec: DEPLOYED_SPEC }],
    main: "misc: [&local true]\nl1: {contracts: {foo: {address: *address, checks: {enabled: *local}}}}\n",
    expected: {
      deployed: { l1: [ADDRESS] },
      misc: [true],
      l1: { contracts: { foo: { address: ADDRESS, checks: { enabled: true } } } },
    },
  },
  {
    name: "input scalars, arrays, large decimal identifiers and block scalars",
    standalone: `config:
  - &name stETH
  - &values [true, 7, 16015286601757825753]
  - &message |-
      hello
      world
externals: [&id 16015286601757825753]
refs: {name: *name, values: *values, message: *message, id: *id}
`,
    siblings: [
      {
        text: "config:\n  - &name stETH\n  - &values [true, 7, 16015286601757825753]\n  - &message |-\n      hello\n      world\nexternals: [&id 16015286601757825753]\n",
        spec: INPUTS_SPEC,
      },
    ],
    main: "refs: {name: *name, values: *values, message: *message, id: *id}\n",
    expected: {
      config: ["stETH", [true, "7", "16015286601757825753"], "hello\nworld"],
      externals: ["16015286601757825753"],
      refs: {
        name: "stETH",
        values: [true, "7", "16015286601757825753"],
        message: "hello\nworld",
        id: "16015286601757825753",
      },
    },
  },
  {
    name: "both siblings, multiple chains and shared consumers",
    standalone: `deployed:
  l1: [&first "${ADDRESS}"]
  l2: [&second "${OTHER_ADDRESS}"]
config: [&enabled true]
externals: [&chain 1]
l1: {chainId: *chain, contracts: {foo: {address: *first, checks: {enabled: *enabled}}}}
l2: {chainId: 10, contracts: {foo: {address: *second, checks: {enabled: *enabled, peer: *first}}}}
`,
    siblings: [
      { text: `deployed: {l1: [&first "${ADDRESS}"], l2: [&second "${OTHER_ADDRESS}"]}\n`, spec: DEPLOYED_SPEC },
      { text: "config: [&enabled true]\nexternals: [&chain 1]\n", spec: INPUTS_SPEC },
    ],
    main: "l1: {chainId: *chain, contracts: {foo: {address: *first, checks: {enabled: *enabled}}}}\nl2: {chainId: 10, contracts: {foo: {address: *second, checks: {enabled: *enabled, peer: *first}}}}\n",
    expected: {
      deployed: { l1: [ADDRESS], l2: [OTHER_ADDRESS] },
      config: [true],
      externals: ["1"],
      l1: { chainId: "1", contracts: { foo: { address: ADDRESS, checks: { enabled: true } } } },
      l2: { chainId: "10", contracts: { foo: { address: OTHER_ADDRESS, checks: { enabled: true, peer: ADDRESS } } } },
    },
  },
];

for (const fixture of fixtures) {
  test(`standalone and split resolved values agree: ${fixture.name}`, () => {
    const standalone = YAML.parse(fixture.standalone, { ...YAML_PARSE_OPTIONS, ...YAML_TO_JS_OPTIONS });
    const { document } = composeWithSiblings(fixture.main, fixture.siblings);
    assert.deepEqual(document, standalone);
    assert.deepEqual(document, fixture.expected);
    assert.deepEqual(Object.keys(document as object), Object.keys(standalone));
  });
}
