import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  foldRoleEvents,
  parseRoleLog,
  type RawLog,
  ROLE_GRANTED_TOPIC,
  ROLE_REVOKED_TOPIC,
  type RoleEvent,
  sortedHolders,
  sortedRoles,
} from "../src/acl/fold";

const ADMIN = `0x${"0".repeat(64)}`;
const SYNC = "0xbb1ef2b79fa8154a13ffa50bd30e5f91ed93ff9b924bd04be671240cbc9d4b71";
const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";
const CONTRACT = "0xccccccccccccccccccccccccccccccccccccccc3";

function event(role: string, account: string, granted: boolean, blockNumber: number, logIndex = 0): RoleEvent {
  return { account, address: CONTRACT, blockNumber, granted, logIndex, role };
}

function topic(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2)}`;
}

function log(signature: string, role: string, account: string, blockNumber = 1, logIndex = 0): RawLog {
  return { address: CONTRACT, blockNumber, logIndex, topics: [signature, role, topic(account), topic(BOB)] };
}

// The live history of CustomSenderReferral on Arbitrum (0x72229141…4AD1), read from the explorer:
// six grants and four revocations, every one in its own block. It folds to exactly the two holders
// the config declares, which is what makes it worth pinning as a fixture.
const ARBITRUM_HISTORY: RoleEvent[] = [
  event(ADMIN, "0xb5c336a5c60d3482b29d83c742c65ae8351b91a8", true, 259_088_105),
  event(SYNC, "0xfe44d50771f469fbfcfb117247937ec50706f881", true, 259_088_799),
  event(SYNC, "0x7ebd06bf137077ff5ee858ca6368dbd95db7c66a", true, 259_263_223),
  event(SYNC, "0xfe44d50771f469fbfcfb117247937ec50706f881", false, 259_263_257),
  event(SYNC, "0x1594705d5f9bbdb36453acf15c94d041c0e02c62", true, 486_879_835),
  event(SYNC, "0x871a5cdde9813627ff37a2895a0c9b117a664622", true, 489_126_805),
  event(SYNC, "0x1594705d5f9bbdb36453acf15c94d041c0e02c62", false, 489_126_818),
  event(SYNC, "0x7ebd06bf137077ff5ee858ca6368dbd95db7c66a", false, 489_629_472),
  event(ADMIN, "0x1dca41859cd23b526cbe74da8f48ac96e14b1a29", true, 489_629_482),
  event(ADMIN, "0xb5c336a5c60d3482b29d83c742c65ae8351b91a8", false, 489_629_492),
];

describe("role event parsing", () => {
  it("reads a grant and a revocation out of conforming logs", () => {
    const granted = parseRoleLog(log(ROLE_GRANTED_TOPIC, SYNC, ALICE, 7, 3));
    const revoked = parseRoleLog(log(ROLE_REVOKED_TOPIC, SYNC, ALICE, 7, 4));

    assert.deepEqual(granted, { event: event(SYNC, ALICE, true, 7, 3), ok: true });
    assert.deepEqual(revoked, { event: event(SYNC, ALICE, false, 7, 4), ok: true });
  });

  it("refuses an unrecognized topic0 instead of folding it as a revocation", () => {
    const stray = `0x${"c".repeat(64)}`;
    const parsed = parseRoleLog(log(stray, SYNC, ALICE));

    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.reason : "", /unrecognized topic0/);
  });

  it("refuses a log that does not carry all four topics", () => {
    const parsed = parseRoleLog({
      address: CONTRACT,
      blockNumber: 1,
      logIndex: 0,
      topics: [ROLE_GRANTED_TOPIC, SYNC, topic(ALICE)],
    });

    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.reason : "", /expected 4 topics/);
  });

  it("refuses an account topic with dirt in the padding rather than inventing an address", () => {
    const dirty = `0x${"0".repeat(23)}1${ALICE.slice(2)}`;
    const parsed = parseRoleLog({
      address: CONTRACT,
      blockNumber: 1,
      logIndex: 0,
      topics: [ROLE_GRANTED_TOPIC, SYNC, dirty, topic(BOB)],
    });

    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.reason : "", /not a padded address/);
  });

  it("normalizes a checksummed topic to the lowercase form the comparison uses", () => {
    const checksummed = "0xAAAAaaaAAAaaaaAAAAAAaAAaaaAaAaAaAAAAAaA1";
    const parsed = parseRoleLog(log(ROLE_GRANTED_TOPIC, SYNC.toUpperCase().replace("0X", "0x"), checksummed));

    assert.equal(parsed.ok && parsed.event.account, ALICE);
    assert.equal(parsed.ok && parsed.event.role, SYNC);
  });
});

describe("role event folding", () => {
  it("folds the live Arbitrum history to exactly the two configured holders", () => {
    const holders = foldRoleEvents(ARBITRUM_HISTORY);

    assert.deepEqual(sortedRoles(holders), [ADMIN, SYNC]);
    assert.deepEqual(sortedHolders(holders, ADMIN), ["0x1dca41859cd23b526cbe74da8f48ac96e14b1a29"]);
    assert.deepEqual(sortedHolders(holders, SYNC), ["0x871a5cdde9813627ff37a2895a0c9b117a664622"]);
  });

  it("does not depend on the order the events arrived in", () => {
    const shuffled = [...ARBITRUM_HISTORY].toReversed();
    const rotated = [...ARBITRUM_HISTORY.slice(4), ...ARBITRUM_HISTORY.slice(0, 4)];
    const expected = sortedHolders(foldRoleEvents(ARBITRUM_HISTORY), SYNC);

    assert.deepEqual(sortedHolders(foldRoleEvents(shuffled), SYNC), expected);
    assert.deepEqual(sortedHolders(foldRoleEvents(rotated), SYNC), expected);
  });

  it("is unchanged by replaying the same events twice", () => {
    const once = foldRoleEvents(ARBITRUM_HISTORY);
    const twice = foldRoleEvents([...ARBITRUM_HISTORY, ...ARBITRUM_HISTORY]);

    assert.deepEqual(sortedRoles(twice), sortedRoles(once));
    for (const role of sortedRoles(once)) {
      assert.deepEqual(sortedHolders(twice, role), sortedHolders(once, role));
    }
  });

  it("gives the same answer however the history is split and rejoined", () => {
    const whole = foldRoleEvents(ARBITRUM_HISTORY);
    for (let cut = 0; cut <= ARBITRUM_HISTORY.length; cut++) {
      const rejoined = foldRoleEvents([...ARBITRUM_HISTORY.slice(0, cut), ...ARBITRUM_HISTORY.slice(cut)]);
      for (const role of sortedRoles(whole)) {
        assert.deepEqual(sortedHolders(rejoined, role), sortedHolders(whole, role), `split at ${cut}`);
      }
    }
  });

  it("orders same-block events by log index", () => {
    const granted = foldRoleEvents([
      event(SYNC, ALICE, true, 10, 0),
      event(SYNC, ALICE, false, 10, 1),
      event(SYNC, ALICE, true, 10, 2),
    ]);
    const revoked = foldRoleEvents([event(SYNC, ALICE, true, 10, 2), event(SYNC, ALICE, false, 10, 3)]);

    assert.deepEqual(sortedHolders(granted, SYNC), [ALICE]);
    assert.deepEqual(sortedHolders(revoked, SYNC), []);
  });

  it("treats a revocation of a role nobody held as a no-op", () => {
    const holders = foldRoleEvents([event(SYNC, ALICE, false, 5)]);

    assert.deepEqual(sortedRoles(holders), [SYNC]);
    assert.deepEqual(sortedHolders(holders, SYNC), []);
  });

  it("keeps a fully revoked role as an empty set rather than dropping the key", () => {
    const holders = foldRoleEvents([event(SYNC, ALICE, true, 1), event(SYNC, ALICE, false, 2)]);

    assert.equal(holders.has(SYNC), true);
    assert.deepEqual(sortedHolders(holders, SYNC), []);
  });
});
