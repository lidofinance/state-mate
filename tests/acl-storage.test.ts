import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { JsonRpcProvider } from "ethers";

import {
  calibrateStorageLayout,
  decodeMembership,
  memberSlot,
  OZ_V4_ROLES_SLOT,
  OZ_V5_ACCESS_CONTROL_BASE,
  readMembership,
} from "../src/acl/storage";

const ADMIN = `0x${"0".repeat(64)}`;
const SYNC = "0xbb1ef2b79fa8154a13ffa50bd30e5f91ed93ff9b924bd04be671240cbc9d4b71";
const GOVERNANCE = "0x1dCA41859Cd23b526CBe74dA8F48aC96e14B1A29";
const SYNC_TRIGGER = "0x871a5cddE9813627Ff37A2895A0c9B117A664622";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const TRUE_WORD = `0x${"0".repeat(63)}1`;
const FALSE_WORD = `0x${"0".repeat(64)}`;

function storageProvider(slots: Record<string, string>, onRead?: (slot: string) => void) {
  return {
    async getStorage(_address: string, slot: string) {
      onRead?.(slot);
      return slots[slot.toLowerCase()] ?? FALSE_WORD;
    },
  } as unknown as JsonRpcProvider;
}

describe("access control slot derivation", () => {
  // Derived by hand against CustomSenderReferral on Arbitrum and read back off the chain: the
  // first two words are 1, the third is 0. If this table ever changes, the derivation is wrong
  const LIVE_SLOTS: [string, string, string][] = [
    [ADMIN, GOVERNANCE, "0xcd808d0444aa75abeeb8b36185816d9142d8059ebd459c581838848d1c87c116"],
    [SYNC, SYNC_TRIGGER, "0x0e48f79cc2a3b08335187f1c158a278fe37667ef3792e716ec0f55bfcce6658c"],
    [SYNC, DEAD, "0x4b9c7485aec6520141a308d7f16a141746795af55c33f6cfa641ce502792ad25"],
  ];

  for (const [role, account, expected] of LIVE_SLOTS) {
    it(`matches the chain for role ${role.slice(0, 10)} and ${account.slice(0, 10)}`, () => {
      assert.equal(memberSlot(OZ_V5_ACCESS_CONTROL_BASE, role, account), expected);
    });
  }

  it("is insensitive to address casing", () => {
    assert.equal(
      memberSlot(OZ_V5_ACCESS_CONTROL_BASE, SYNC, SYNC_TRIGGER.toLowerCase()),
      memberSlot(OZ_V5_ACCESS_CONTROL_BASE, SYNC, SYNC_TRIGGER),
    );
  });

  it("puts the two layouts in different places", () => {
    assert.notEqual(
      memberSlot(OZ_V5_ACCESS_CONTROL_BASE, SYNC, SYNC_TRIGGER),
      memberSlot(OZ_V4_ROLES_SLOT, SYNC, SYNC_TRIGGER),
    );
  });
});

describe("membership word decoding", () => {
  it("reads the two words a bool can be", () => {
    assert.deepEqual(decodeMembership(TRUE_WORD), { held: true, ok: true });
    assert.deepEqual(decodeMembership(FALSE_WORD), { held: false, ok: true });
  });

  it("refuses a word that is not a bool rather than calling it 'not a holder'", () => {
    const packed = `0x${"0".repeat(62)}42`;

    assert.deepEqual(decodeMembership(packed), { ok: false, word: packed });
  });
});

describe("storage layout calibration", () => {
  it("selects the v5 layout when the confirmed holder reads back there", async () => {
    const provider = storageProvider({ [memberSlot(OZ_V5_ACCESS_CONTROL_BASE, SYNC, SYNC_TRIGGER)]: TRUE_WORD });

    const result = await calibrateStorageLayout(provider, "0xabc", [{ account: SYNC_TRIGGER, role: SYNC }]);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.layout.base, OZ_V5_ACCESS_CONTROL_BASE);
  });

  it("falls through to the v4 layout used by the older bridges", async () => {
    const provider = storageProvider({ [memberSlot(OZ_V4_ROLES_SLOT, SYNC, SYNC_TRIGGER)]: TRUE_WORD });

    const result = await calibrateStorageLayout(provider, "0xabc", [{ account: SYNC_TRIGGER, role: SYNC }]);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.layout.base, OZ_V4_ROLES_SLOT);
  });

  // the gate: a contract whose roles are not where AccessControl keeps them is a contract whose
  // event log cannot be assumed complete
  // the layout is a property of the contract, not of whichever holder the YAML happens to list
  // first; a single holder that does not read back must not derail the search
  it("establishes the layout from a later holder when the first does not read back", async () => {
    const provider = storageProvider({ [memberSlot(OZ_V5_ACCESS_CONTROL_BASE, ADMIN, GOVERNANCE)]: TRUE_WORD });

    const result = await calibrateStorageLayout(provider, "0xabc", [
      { account: SYNC_TRIGGER, role: SYNC },
      { account: GOVERNANCE, role: ADMIN },
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.layout.base, OZ_V5_ACCESS_CONTROL_BASE);
  });

  it("does not depend on the order the confirmed holders are given in", async () => {
    const provider = storageProvider({ [memberSlot(OZ_V5_ACCESS_CONTROL_BASE, ADMIN, GOVERNANCE)]: TRUE_WORD });
    const pairs = [
      { account: SYNC_TRIGGER, role: SYNC },
      { account: GOVERNANCE, role: ADMIN },
    ];

    const forward = await calibrateStorageLayout(provider, "0xabc", pairs);
    const backward = await calibrateStorageLayout(provider, "0xabc", pairs.toReversed());

    assert.deepEqual(forward, backward);
  });

  it("refuses when no known layout accounts for any confirmed holder", async () => {
    const result = await calibrateStorageLayout(storageProvider({}), "0xabc", [{ account: SYNC_TRIGGER, role: SYNC }]);

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /no known AccessControl storage layout/);
  });

  it("refuses when there is no confirmed holder to calibrate against", async () => {
    const result = await calibrateStorageLayout(storageProvider({}), "0xabc", []);

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /cannot be calibrated/);
  });

  it("reports a non-bool word instead of trying the next layout as if it were empty", async () => {
    const provider = storageProvider({
      [memberSlot(OZ_V5_ACCESS_CONTROL_BASE, SYNC, SYNC_TRIGGER)]: `0x${"f".repeat(64)}`,
    });

    const result = await calibrateStorageLayout(provider, "0xabc", [{ account: SYNC_TRIGGER, role: SYNC }]);

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /unexpected word 0xffff/);
  });
});

describe("membership reads", () => {
  it("reports a revoked holder as not held", async () => {
    const layout = { base: OZ_V5_ACCESS_CONTROL_BASE, name: "v5" };
    const provider = storageProvider({});

    assert.deepEqual(await readMembership(provider, "0xabc", layout, SYNC, DEAD), { held: false, ok: true });
  });

  it("reads the slot the derivation points at, and no other", async () => {
    const layout = { base: OZ_V5_ACCESS_CONTROL_BASE, name: "v5" };
    const read: string[] = [];
    const provider = storageProvider({}, (slot) => read.push(slot));

    await readMembership(provider, "0xabc", layout, SYNC, SYNC_TRIGGER);

    assert.deepEqual(read, [memberSlot(OZ_V5_ACCESS_CONTROL_BASE, SYNC, SYNC_TRIGGER)]);
  });
});
