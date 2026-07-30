import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCmdLineArguments } from "../cli-parser";

const argv = (...arguments_: string[]) => ["node", "state-mate", ...arguments_];

test("--inputs may be repeated and preserves command-line order", () => {
  const options = parseCmdLineArguments(
    argv("config.yaml", "--inputs", "common.inputs.yaml", "--inputs", "optimism.inputs.yaml"),
  );
  assert.deepEqual(options.inputs, ["common.inputs.yaml", "optimism.inputs.yaml"]);
});

test("one --inputs value is represented as a one-element list", () => {
  const options = parseCmdLineArguments(argv("config.yaml", "--inputs", "optimism.inputs.yaml"));
  assert.deepEqual(options.inputs, ["optimism.inputs.yaml"]);
});

test("omitting --inputs leaves an empty list for sibling auto-discovery", () => {
  const options = parseCmdLineArguments(argv("config.yaml"));
  assert.deepEqual(options.inputs, []);
});

test("--overrides is rejected with repeated --inputs", () => {
  assert.throws(
    () =>
      parseCmdLineArguments(
        argv(
          "config.yaml",
          "--inputs",
          "common.inputs.yaml",
          "--inputs",
          "lane.inputs.yaml",
          "--overrides",
          "overrides.yaml",
        ),
      ),
    /supports exactly one --inputs file/,
  );
});

test("--generate may specify repeated inputs and overrides because all siblings are ignored", () => {
  const options = parseCmdLineArguments(
    argv(
      "seed.yaml",
      "--generate",
      "--inputs",
      "common.inputs.yaml",
      "--inputs",
      "lane.inputs.yaml",
      "--overrides",
      "overrides.yaml",
    ),
  );
  assert.equal(options.generate, true);
  assert.deepEqual(options.inputs, ["common.inputs.yaml", "lane.inputs.yaml"]);
});
