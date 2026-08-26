import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { collectYamlConfigs } from "../src/state-mate";

describe("collectYamlConfigs", () => {
  let directory: string;

  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("finds every YAML config recursively, sorted, and ignores other files", () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "state-mate-test-"));
    fs.mkdirSync(path.join(directory, "testnet"));
    fs.writeFileSync(path.join(directory, "b.yaml"), "");
    fs.writeFileSync(path.join(directory, "a.yml"), "");
    fs.writeFileSync(path.join(directory, "abis.json.gz"), "");
    fs.writeFileSync(path.join(directory, "testnet", "c.yaml"), "");

    assert.deepEqual(collectYamlConfigs(directory), [
      path.join(directory, "a.yml"),
      path.join(directory, "b.yaml"),
      path.join(directory, "testnet", "c.yaml"),
    ]);
  });

  it("leaves seed files and their generated siblings out of a directory run", () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "state-mate-test-"));
    fs.writeFileSync(path.join(directory, "main.yaml"), "");
    fs.writeFileSync(path.join(directory, "proto.seed.yaml"), "");
    fs.writeFileSync(path.join(directory, "proto.seed.generated.yaml"), "");

    assert.deepEqual(collectYamlConfigs(directory), [path.join(directory, "main.yaml")]);
  });
});
