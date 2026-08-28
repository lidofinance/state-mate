import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Contract, JsonRpcProvider } from "ethers";

import { grantedCandidates, type RoleEvent } from "../src/acl/fold";
import { memberSlot, OZ_V5_ACCESS_CONTROL_BASE, type StorageLayout } from "../src/acl/storage";
import { context, resetStats, stats } from "../src/context";
import { resetContractCounters } from "../src/section-validators/base";
import { OzNonEnumerableAclSectionValidator } from "../src/section-validators/oz-non-enumerable-acl";
import type { ContractEntry } from "../src/typebox";

const ADDRESS = "0xcccccccccccccccccccccccccccccccccccccccc";
const ADMIN = `0x${"0".repeat(64)}`;
const SYNC = "0xbb1ef2b79fa8154a13ffa50bd30e5f91ed93ff9b924bd04be671240cbc9d4b71";
const GOV = "0x1dca41859cd23b526cbe74da8f48ac96e14b1a29";
const TRIGGER = "0x871a5cdde9813627ff37a2895a0c9b117a664622";
const STRANGER = "0x00000000000000000000000000000000deadbeef";
const TRUE_WORD = `0x${"0".repeat(63)}1`;
const FALSE_WORD = `0x${"0".repeat(64)}`;

function key(role: string, holder: string) {
  return `${role.toLowerCase()}|${holder.toLowerCase()}`;
}

/** hasRole answers, plus the raw slots, so the two can be made to disagree on purpose. */
function stub(roles: Record<string, boolean>, slots?: Record<string, string>) {
  const provider = {
    async getStorage(_address: string, slot: string) {
      if (slots) return slots[slot.toLowerCase()] ?? FALSE_WORD;
      // by default the slot agrees with the view, which is the uninteresting case
      const match = Object.entries(roles).find(
        ([pair, held]) =>
          held && memberSlot(OZ_V5_ACCESS_CONTROL_BASE, pair.split("|")[0], pair.split("|")[1]) === slot,
      );
      return match ? TRUE_WORD : FALSE_WORD;
    },
  } as unknown as JsonRpcProvider;

  const contract = {
    getFunction: () => ({
      staticCall: (role: string, holder: string) => {
        const answer = roles[key(role, holder)];
        return answer === undefined ? Promise.resolve(false) : Promise.resolve(answer);
      },
    }),
  } as unknown as Contract;

  return { contract, provider };
}

class ExposedAcl extends OzNonEnumerableAclSectionValidator {
  constructor(
    provider: JsonRpcProvider,
    chainId: string,
    private readonly bound: Contract,
  ) {
    super(provider, chainId);
  }

  protected override _contractFor(): Contract {
    return this.bound;
  }

  public compare(contractEntry: ContractEntry, events: RoleEvent[], known: RoleAnswers = declaredTrue()) {
    return this._compareWithConfig(contractEntry, grantedCandidates(events), V5_LAYOUT, known);
  }

  public declared(contractEntry: ContractEntry) {
    return this._validate(contractEntry, false);
  }
}

const V5_LAYOUT: StorageLayout = { base: OZ_V5_ACCESS_CONTROL_BASE, name: "openzeppelin v5" };

type RoleAnswers = Map<string, { held: boolean | undefined; holder: string; role: string }>;

/** What the declared pass would have recorded for a config whose holders all check out. */
function declaredTrue(): RoleAnswers {
  return new Map([
    [key(ADMIN, GOV), { held: true, holder: GOV, role: ADMIN }],
    [key(SYNC, TRIGGER), { held: true, holder: TRIGGER, role: SYNC }],
  ]);
}

function grant(role: string, account: string, blockNumber: number, granted = true): RoleEvent {
  return { account, address: ADDRESS, blockNumber, granted, logIndex: 0, role };
}

function entry(overrides: Partial<ContractEntry> = {}): ContractEntry {
  return {
    address: ADDRESS,
    checks: {},
    name: "CustomSenderReferral",
    ozNonEnumerableAcl: { [ADMIN]: [GOV], [SYNC]: [TRIGGER] },
    ...overrides,
  } as ContractEntry;
}

const DECLARED_TRUE = { [key(ADMIN, GOV)]: true, [key(SYNC, TRIGGER)]: true };

describe("declared ACL checks", () => {
  beforeEach(() => {
    resetStats();
    resetContractCounters();
    context.quiet = true;
  });

  it("passes when every declared holder holds its role and nothing else", async () => {
    const { contract, provider } = stub(DECLARED_TRUE);
    await new ExposedAcl(provider, "56", contract).validateSection(entry(), "sender");

    assert.equal(stats.errors, 0);
    // two declared pairs, plus the cross-product absence checks; the scan itself is in the skips
    assert.deepEqual({ checks: stats.totalChecks, skipped: stats.skipped }, { checks: 4, skipped: 1 });
  });

  // 56 has no log source, so the enumeration is visible as a skip and never as a silent pass
  it("records a skip, not a pass, on a chain the registry cannot serve", async () => {
    const { contract, provider } = stub(DECLARED_TRUE);
    await new ExposedAcl(provider, "56", contract).validateSection(entry(), "sender");

    assert.deepEqual({ errors: stats.errors, skipped: stats.skipped }, { errors: 0, skipped: 1 });
  });
});

describe("exhaustive ACL checks", () => {
  beforeEach(() => {
    resetStats();
    resetContractCounters();
    context.quiet = true;
  });

  it("does not count an unscannable chain as a passed check", async () => {
    const { contract, provider } = stub(DECLARED_TRUE);
    await new ExposedAcl(provider, "56", contract).validateSection(entry(), "sender");

    // the four declared checks and nothing more; the scan is in the skip tally instead
    assert.equal(stats.totalChecks, 4);
  });

  it("still fails a declared holder that does not hold its role", async () => {
    const { contract, provider } = stub({ ...DECLARED_TRUE, [key(SYNC, TRIGGER)]: false });
    await new ExposedAcl(provider, "56", contract).validateSection(entry(), "sender");

    assert.ok(stats.errors >= 1);
    assert.ok(stats.errorDetails.some((detail) => detail.method.includes(TRIGGER)));
  });

  it("does not turn a failed hasRole call into a false answer", async () => {
    const { provider } = stub({});
    const contract = {
      getFunction: () => ({
        staticCall: async () => {
          throw new Error("RPC unavailable");
        },
      }),
    } as unknown as Contract;
    const single = entry({ ozNonEnumerableAcl: { [ADMIN]: [GOV] } } as Partial<ContractEntry>);

    const known = await new ExposedAcl(provider, "56", contract).declared(single);

    assert.equal(known.get(key(ADMIN, GOV))?.held, undefined);
    assert.equal(stats.errors, 1);
  });
});

describe("comparing the scan against the config", () => {
  beforeEach(() => {
    resetStats();
    resetContractCounters();
    context.quiet = true;
  });

  it("accepts a history that folds to exactly the declared holders", async () => {
    const { contract, provider } = stub(DECLARED_TRUE);
    await new ExposedAcl(provider, "1", contract).compare(entry(), [grant(ADMIN, GOV, 1), grant(SYNC, TRIGGER, 2)]);

    assert.equal(stats.errors, 0);
  });

  it("reports a holder the events found and the config never declared", async () => {
    const roles = { ...DECLARED_TRUE, [key(SYNC, STRANGER)]: true };
    const { contract, provider } = stub(roles);
    await new ExposedAcl(provider, "1", contract).compare(entry(), [
      grant(ADMIN, GOV, 1),
      grant(SYNC, TRIGGER, 2),
      grant(SYNC, STRANGER, 3),
    ]);

    const undeclared = stats.errorDetails.filter((detail) => detail.message.includes("undeclared role holder"));
    assert.equal(undeclared.length, 1);
    assert.match(undeclared[0].message, new RegExp(STRANGER));
  });

  it("does not report a holder that was granted and later revoked", async () => {
    const { contract, provider } = stub(DECLARED_TRUE);
    await new ExposedAcl(provider, "1", contract).compare(entry(), [
      grant(ADMIN, GOV, 1),
      grant(SYNC, TRIGGER, 2),
      grant(SYNC, STRANGER, 3),
      grant(SYNC, STRANGER, 4, false),
    ]);

    assert.equal(stats.errors, 0);
  });

  // an undeclared grant whose revocation the scan never saw would look identical to a live one,
  // so the holder is always re-asked on chain before being reported
  it("clears an undeclared holder the chain says no longer holds the role", async () => {
    const { contract, provider } = stub(DECLARED_TRUE);
    await new ExposedAcl(provider, "1", contract).compare(entry(), [
      grant(ADMIN, GOV, 1),
      grant(SYNC, TRIGGER, 2),
      grant(SYNC, STRANGER, 3),
    ]);

    assert.equal(stats.errors, 0);
  });

  // the slot is the guard against a view that lies about a holder the scan found; hasRole calling
  // an undeclared holder revoked while the storage still has them is exactly the hiding it prevents
  it("reports a slot that contradicts hasRole on a holder the scan found", async () => {
    const { contract, provider } = stub(DECLARED_TRUE, {
      // the declared pairs agree, so the only disagreement left is the one under test
      [memberSlot(OZ_V5_ACCESS_CONTROL_BASE, ADMIN, GOV)]: TRUE_WORD,
      [memberSlot(OZ_V5_ACCESS_CONTROL_BASE, SYNC, TRIGGER)]: TRUE_WORD,
      [memberSlot(OZ_V5_ACCESS_CONTROL_BASE, SYNC, STRANGER)]: TRUE_WORD,
    });
    await new ExposedAcl(provider, "1", contract).compare(entry(), [grant(SYNC, STRANGER, 3)]);

    assert.equal(stats.errors, 1);
    assert.match(stats.errorDetails[0].message, /hasRole says false but the membership slot says true/);
  });

  it("reports a membership word that is not a bool", async () => {
    const { contract, provider } = stub(DECLARED_TRUE, {
      [memberSlot(OZ_V5_ACCESS_CONTROL_BASE, ADMIN, GOV)]: TRUE_WORD,
      [memberSlot(OZ_V5_ACCESS_CONTROL_BASE, SYNC, TRIGGER)]: TRUE_WORD,
      [memberSlot(OZ_V5_ACCESS_CONTROL_BASE, SYNC, STRANGER)]: `0x${"0".repeat(62)}42`,
    });
    await new ExposedAcl(provider, "1", contract).compare(entry(), [grant(SYNC, STRANGER, 3)]);

    assert.ok(stats.errorDetails.some((detail) => /is not a bool/.test(detail.message)));
  });

  // a hasRole that answers true for an address the slot does not hold is a backdoor the declared
  // check cannot see, because the declared check is asking the very function that is lying
  it("catches a declared holder the view claims but the slot does not hold", async () => {
    const { contract, provider } = stub(DECLARED_TRUE, {
      [memberSlot(OZ_V5_ACCESS_CONTROL_BASE, ADMIN, GOV)]: TRUE_WORD,
      // TRIGGER reads back as absent while hasRole insists it holds SYNC
    });
    await new ExposedAcl(provider, "1", contract).compare(entry(), [grant(ADMIN, GOV, 1)]);

    assert.equal(stats.errors, 1);
    assert.match(stats.errorDetails[0].message, /hasRole says true but the membership slot says false/);
    assert.ok(stats.errorDetails[0].method.includes(TRIGGER));
  });

  it("reads the slot for every declared pair, not just the one calibration used", async () => {
    const read: string[] = [];
    const { contract, provider } = stub(DECLARED_TRUE);
    const spied = {
      ...provider,
      getStorage: async (a: string, slot: string) => {
        read.push(slot.toLowerCase());
        return provider.getStorage(a, slot);
      },
    } as unknown as typeof provider;
    await new ExposedAcl(spied, "1", contract).compare(entry(), []);

    assert.ok(read.includes(memberSlot(OZ_V5_ACCESS_CONTROL_BASE, ADMIN, GOV).toLowerCase()));
    assert.ok(read.includes(memberSlot(OZ_V5_ACCESS_CONTROL_BASE, SYNC, TRIGGER).toLowerCase()));
  });

  it("reports a role declared twice under different casing", async () => {
    const { contract, provider } = stub(DECLARED_TRUE);
    const doubled = entry({
      ozNonEnumerableAcl: { [SYNC]: [TRIGGER], [SYNC.toUpperCase().replace("0X", "0x")]: [GOV] },
    } as Partial<ContractEntry>);
    await new ExposedAcl(provider, "1", contract).compare(doubled, []);

    assert.ok(stats.errorDetails.some((detail) => /declared twice under different casing/.test(detail.message)));
  });

  it("orders its findings the same way on every run", async () => {
    const run = async (events: RoleEvent[]) => {
      resetStats();
      resetContractCounters();
      const roles = { ...DECLARED_TRUE, [key(SYNC, STRANGER)]: true, [key(ADMIN, STRANGER)]: true };
      const { contract, provider } = stub(roles);
      await new ExposedAcl(provider, "1", contract).compare(entry(), events);
      return stats.errorDetails.map((detail) => detail.message);
    };
    const events = [grant(SYNC, STRANGER, 3), grant(ADMIN, STRANGER, 4)];

    assert.deepEqual(await run(events), await run(events.toReversed()));
  });
});
