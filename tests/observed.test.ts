import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Result } from "ethers";
import * as YAML from "yaml";

import { context } from "../src/context";
import {
  beginObservedSection,
  buildObservedDocument,
  recordObservedCall,
  recordObservedStorage,
  resetObserved,
  toPlain,
  writeObservedFile,
} from "../src/observed";

const POSITION = { section: "robinhood", contract: "vault", contractAddress: "0xVault", checksType: "checks" };

describe("observed values", () => {
  beforeEach(() => {
    resetObserved();
    context.json = true;
  });

  afterEach(() => {
    context.json = false;
  });

  it("keeps what the chain answered under the section, contract and method the config names", () => {
    beginObservedSection("robinhood", "46630", 65439916, true);
    recordObservedCall(POSITION, "marketIds", [0], { value: "0xaaa" });
    recordObservedCall(POSITION, "marketIds", [1n], { value: "0xbbb" });
    recordObservedCall(POSITION, "owner", undefined, { value: "0xOwner" });
    recordObservedCall(POSITION, "adapters", [9], { reverted: "execution reverted" });
    recordObservedCall({ ...POSITION, checksType: "proxyChecks" }, "proxy__getAdmin", [], { value: "0xAdmin" });
    recordObservedStorage({ ...POSITION, checksType: "storage" }, "0x00", "0x01");

    const document = buildObservedDocument("state.yaml");

    assert.equal(document.config, "state.yaml");
    assert.deepEqual(document.sections.robinhood, {
      chainId: "46630",
      block: 65439916,
      pinned: true,
      contracts: {
        vault: {
          address: "0xVault",
          checks: {
            marketIds: [
              { args: [0], value: "0xaaa" },
              { args: ["1"], value: "0xbbb" },
            ],
            owner: [{ value: "0xOwner" }],
            adapters: [{ args: [9], reverted: "execution reverted" }],
          },
          proxyChecks: { proxy__getAdmin: [{ value: "0xAdmin" }] },
          storage: { "0x00": "0x01" },
        },
      },
    });
  });

  it("turns bigint, named and unnamed results into plain values", () => {
    assert.equal(toPlain(10n), "10");
    assert.deepEqual(toPlain(Result.fromItems([1n, "0xabc"], ["cap", "adapter"])), { cap: "1", adapter: "0xabc" });
    assert.deepEqual(toPlain(Result.fromItems([1n, [2n, true]])), ["1", ["2", true]]);
    assert.deepEqual(toPlain(Result.fromItems(["0xabc"], ["_"])), ["0xabc"]);
    assert.deepEqual(toPlain(Result.fromItems([])), []);
    assert.deepEqual(toPlain(Result.fromItems([Result.fromItems(["0xabc"], ["_"])], ["vaults"])), {
      vaults: ["0xabc"],
    });
    assert.deepEqual(toPlain([null, 3, "x", false]), [null, 3, "x", false]);
  });

  it("keeps a read whose section was never announced instead of dropping it", () => {
    recordObservedCall(POSITION, "owner", undefined, { value: "0x1" });

    const section = buildObservedDocument("cfg.yaml").sections.robinhood;
    assert.deepEqual({ block: section.block, pinned: section.pinned }, { block: null, pinned: false });
    assert.deepEqual(section.contracts.vault.checks, { owner: [{ value: "0x1" }] });
  });

  it("writes a YAML file that loads back, creating the directory it names", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "observed-"));
    const file = path.join(directory, "nested", "observed.yaml");
    beginObservedSection("l1", "1", 100, false);
    recordObservedCall({ ...POSITION, section: "l1" }, "totalSupply", undefined, { value: 5n });

    writeObservedFile(file, "cfg.yaml");

    const loaded = YAML.parse(fs.readFileSync(file, "utf8"));
    assert.equal(loaded.config, "cfg.yaml");
    assert.deepEqual(loaded.sections.l1.contracts.vault.checks.totalSupply, [{ value: "5" }]);
    assert.deepEqual(
      { block: loaded.sections.l1.block, pinned: loaded.sections.l1.pinned },
      { block: 100, pinned: false },
    );
    fs.rmSync(directory, { recursive: true });
  });
});
