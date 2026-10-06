import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Contract, JsonRpcProvider } from "ethers";

import { EntryField } from "../src/common";
import { context, resetStats, stats } from "../src/context";
import { buildObservedDocument, resetObserved } from "../src/observed";
import { beginConfig, beginContract, buildReport, endContract, resetReport } from "../src/report";
import { resetContractCounters, setErrorContext } from "../src/section-validators/base";
import { ChecksSectionValidator, pinnedIndices } from "../src/section-validators/checks";
import type { ChecksEntryValue, StaticCallResult } from "../src/typebox";
import type { Abi } from "../src/types";

const ADDRESS = "0x7305bB45aF91893B7BCaF0Ad8Eae37cb16820Bb8";
const IDS = ["0xa", "0xb", "0xc", "0xd", "0xe"];
const ABI: Abi = [
  { type: "function", name: "marketIdsLength", inputs: [], stateMutability: "view" },
  { type: "function", name: "marketIds", inputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "adaptersLength", inputs: [], stateMutability: "view" },
  { type: "function", name: "owner", inputs: [], stateMutability: "view" },
];

function fakeContract(ids: string[], reads: string[], countReverts = false): Contract {
  return {
    getFunction: (name: string) => ({
      staticCall: (...args: unknown[]) => {
        reads.push(`${name}(${args.join(",")})`);
        if (name.endsWith("Length")) {
          return countReverts ? Promise.reject(new Error("execution reverted")) : Promise.resolve(BigInt(ids.length));
        }
        const index = Number(args[0]);
        return index < ids.length ? Promise.resolve(ids[index]) : Promise.reject(new Error("execution reverted"));
      },
    }),
  } as unknown as Contract;
}

function pinnedEntries(ids: string[]): ChecksEntryValue {
  return ids.map((id, index) => ({ args: [index], result: id }));
}

class ExposedChecks extends ChecksSectionValidator {
  public expand(contract: Contract, checks: Record<string, ChecksEntryValue>) {
    return this._expandEnumerations(contract, ABI, checks);
  }

  public check(contract: Contract, method: string, entry: StaticCallResult) {
    return this._checkViewResult(contract, method, entry);
  }

  public supplies(methods: string[]) {
    this.undeclared = new Set(methods);
  }
}

describe("enumeration expansion", () => {
  const validator = new ExposedChecks({} as JsonRpcProvider, 1, EntryField.checks);
  const reads: string[] = [];

  beforeEach(() => {
    resetStats();
    resetContractCounters();
    resetReport();
    resetObserved();
    reads.length = 0;
    context.json = true;
    context.observedPath = "cfg.observed.yaml";
    beginConfig("cfg.yaml");
    beginContract("l1/vault", "Vault", ADDRESS);
    setErrorContext({ section: "l1", contract: "vault", contractAddress: ADDRESS, checksType: "checks" });
  });

  afterEach(() => {
    context.json = false;
    context.observedPath = undefined;
    context.checkOnly = null;
    validator.supplies([]);
  });

  function warnings() {
    endContract();
    return buildReport(0).configs[0].contracts?.[0]?.warnings ?? [];
  }

  it("reads the entries the config leaves out, records them and reports each one", async () => {
    await validator.expand(fakeContract(IDS, reads), { marketIdsLength: 5, marketIds: pinnedEntries(IDS.slice(0, 4)) });

    assert.deepEqual(reads, ["marketIdsLength()", "marketIds(4)"]);
    assert.deepEqual(warnings(), [{ check: ".marketIds(4)", message: "not in the config; the chain says 0xe" }]);
    // no check read the count here, so the expansion records its own read
    assert.deepEqual(buildObservedDocument("cfg.yaml").sections.l1.contracts.vault.checks, {
      marketIdsLength: [{ value: "5" }],
      marketIds: [{ args: [4], value: "0xe" }],
    });
    assert.equal(stats.totalChecks, 0);
  });

  it("goes by the count the check already read instead of reading it again", async () => {
    const checker = new ExposedChecks({} as JsonRpcProvider, 1, EntryField.checks);
    const contract = fakeContract(IDS, reads);
    await checker.check(contract, "marketIdsLength", { result: 5 });
    await checker.expand(contract, { marketIdsLength: 5, marketIds: pinnedEntries(IDS.slice(0, 4)) });

    assert.deepEqual(reads, ["marketIdsLength()", "marketIds(4)"]);
    assert.deepEqual(buildObservedDocument("cfg.yaml").sections.l1.contracts.vault.checks, {
      marketIdsLength: [{ value: "5" }],
      marketIds: [{ args: [4], value: "0xe" }],
    });
  });

  it("says nothing when the config pins every entry", async () => {
    await validator.expand(fakeContract(IDS, reads), { marketIdsLength: 5, marketIds: pinnedEntries(IDS) });

    assert.deepEqual(reads, ["marketIdsLength()"]);
    assert.deepEqual(warnings(), []);
  });

  it("takes the count from the chain, not from the config", async () => {
    await validator.expand(fakeContract(IDS.slice(0, 2), reads), { marketIdsLength: 5, marketIds: pinnedEntries(IDS) });

    assert.deepEqual(reads, ["marketIdsLength()"]);
    assert.deepEqual(warnings(), []);
  });

  it("leaves a length with no indexed getter alone", async () => {
    await validator.expand(fakeContract(IDS, reads), { adaptersLength: 5, owner: "0x1" });

    assert.deepEqual(reads, []);
    assert.deepEqual(warnings(), []);
  });

  it("expands a length the config declines to assert, and records the count", async () => {
    await validator.expand(fakeContract(IDS.slice(0, 2), reads), { marketIdsLength: null });

    assert.deepEqual(reads, ["marketIdsLength()", "marketIds(0)", "marketIds(1)"]);
    assert.deepEqual(
      warnings().map(({ check }) => check),
      [".marketIds(0)", ".marketIds(1)"],
    );
    assert.deepEqual(buildObservedDocument("cfg.yaml").sections.l1.contracts.vault.checks, {
      marketIdsLength: [{ value: "2" }],
      marketIds: [
        { args: [0], value: "0xa" },
        { args: [1], value: "0xb" },
      ],
    });
  });

  it("says so when the count cannot be read, rather than passing as fully expanded", async () => {
    await validator.expand(fakeContract(IDS, reads, true), { marketIdsLength: null });

    assert.deepEqual(reads, ["marketIdsLength()"]);
    const [warning, ...rest] = warnings();
    assert.deepEqual(rest, []);
    assert.equal(warning.check, ".marketIdsLength");
    assert.match(warning.message, /not expanded: the count REVERTED/);
    const recorded = buildObservedDocument("cfg.yaml").sections.l1.contracts.vault.checks as Record<
      string,
      { reverted?: string }[]
    >;
    assert.match(String(recorded.marketIdsLength[0].reverted), /execution reverted/);
  });

  it("leaves alone an enumeration only the implementationChecks placeholders name", async () => {
    validator.supplies(["marketIdsLength", "marketIds"]);
    await validator.expand(fakeContract(IDS, reads), { marketIdsLength: null, marketIds: null });

    assert.deepEqual(reads, []);
    assert.deepEqual(warnings(), []);
  });

  it("reports the entries without --observed and keeps nothing", async () => {
    context.observedPath = undefined;
    await validator.expand(fakeContract(IDS, reads), { marketIdsLength: 5, marketIds: pinnedEntries(IDS.slice(0, 4)) });

    assert.deepEqual(
      warnings().map(({ check }) => check),
      [".marketIds(4)"],
    );
    assert.deepEqual(buildObservedDocument("cfg.yaml").sections, {});
  });

  it("reports instead of scanning when the enumeration is beyond the cap", async () => {
    const many = Array.from({ length: 1001 }, (_, index) => `0x${index}`);

    await validator.expand(fakeContract(many, reads), { marketIdsLength: 1001 });

    assert.deepEqual(reads, ["marketIdsLength()"]);
    assert.deepEqual(warnings(), [
      { check: ".marketIds[0..1001)", message: "1001 entries exceed the expansion cap of 1000" },
    ]);
  });

  it("follows the -o filter by the length or the getter it names", async () => {
    context.checkOnly = { section: "l1", contract: "vault", checksType: "checks", method: "owner" };
    await validator.expand(fakeContract(IDS, reads), { marketIdsLength: 5 });
    assert.deepEqual(reads, []);

    context.checkOnly = { section: "l1", contract: "vault", checksType: "checks", method: "marketIds" };
    await validator.expand(fakeContract(IDS, reads), { marketIdsLength: 5, marketIds: pinnedEntries(IDS.slice(0, 4)) });
    assert.deepEqual(reads, ["marketIdsLength()", "marketIds(4)"]);
  });
});

describe("pinned indices", () => {
  it("collects the single numeric argument of every pinned entry", () => {
    assert.deepEqual(
      [
        ...pinnedIndices([
          { args: [0], result: "a" },
          { args: ["2"], result: "c" },
          { args: [1, 2], result: "x" },
          { mustRevert: true },
        ]),
      ],
      [0, 2],
    );
    assert.deepEqual([...pinnedIndices({ args: [3], result: "d" })], [3]);
    assert.deepEqual([...pinnedIndices("0xa")], []);
    assert.deepEqual([...pinnedIndices(undefined)], []);
  });
});
