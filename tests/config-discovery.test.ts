import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverSiblingPaths } from "../src/sibling-delegation";
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
    fs.writeFileSync(path.join(directory, "a.deployed.yaml"), "");
    fs.writeFileSync(path.join(directory, "a.inputs.yml"), "");
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

  it("matches the exact stem beside the config, accepting either YAML extension", () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "state-mate-test-"));
    fs.mkdirSync(path.join(directory, "nested"));
    const config = path.join(directory, "nested", "foo.mainnet.yml");
    const deployed = path.join(directory, "nested", "foo.mainnet.deployed.yaml");
    const inputs = path.join(directory, "nested", "foo.mainnet.inputs.yml");
    fs.writeFileSync(deployed, "");
    fs.writeFileSync(inputs, "");
    assert.deepEqual(discoverSiblingPaths(config), { deployed, inputs });
    assert.deepEqual(discoverSiblingPaths(path.join(directory, "foo.mainnet.yml")), {});
    assert.deepEqual(discoverSiblingPaths(path.join(directory, "nested", "other.yaml")), {});
  });

  for (const kind of ["deployed", "inputs"]) {
    it(`rejects ambiguous ${kind} extensions`, () => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), "state-mate-test-"));
      for (const extension of ["yaml", "yml"]) fs.writeFileSync(path.join(directory, `foo.${kind}.${extension}`), "");
      assert.throws(() => discoverSiblingPaths(path.join(directory, "foo.yaml")), /Ambiguous .* siblings/);
    });
    it(`rejects a directory named like a ${kind} sibling`, () => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), "state-mate-test-"));
      fs.mkdirSync(path.join(directory, `foo.${kind}.yaml`));
      assert.throws(() => discoverSiblingPaths(path.join(directory, "foo.yaml")), /path is not a file/);
    });
  }
});
