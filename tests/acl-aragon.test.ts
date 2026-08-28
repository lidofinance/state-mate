import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ANY_ENTITY,
  type AragonEvent,
  appRoleKey,
  CHANGE_PERMISSION_MANAGER_TOPIC,
  decodePermissionWord,
  EMPTY_PARAM_HASH,
  foldAragonEvents,
  managerSlot,
  paramsDigest,
  parseAragonLog,
  permissionSlot,
  SET_PERMISSION_PARAMS_TOPIC,
  SET_PERMISSION_TOPIC,
} from "../src/acl/aragon";
import type { RawLog } from "../src/acl/fold";

const ACL = "0x9895f0f17cc1d1891b6f18ee0b483b6f221b37bb";
const LIDO = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
const AGENT = "0x3e40d73eb977dc6a537af587d48316fee66e9c8c";
const VOTING = "0x2e59a20f205bb85a89c53f1936454680651e618e";
const BUFFER_ROLE = "0x33969636f1fbf3d7d062d4de4a08e7bd3c46606ec28b3a4398d2665be559b921";
const STAKING_CONTROL = "0xa42eee1333c0758ba72be38e728b6dadb32ea767de5b4ddbaea1dae85b1b051f";
const ZERO_WORD = `0x${"0".repeat(64)}`;
const TRUE_WORD = `0x${"0".repeat(63)}1`;
const HASH_A = `0x${"a".repeat(64)}`;

function topic(address: string) {
  return `0x${"0".repeat(24)}${address.slice(2)}`;
}

function permissionLog(
  entity: string,
  app: string,
  role: string,
  allowed: boolean,
  blockNumber = 1,
  logIndex = 0,
): RawLog {
  return {
    address: ACL,
    blockNumber,
    data: allowed ? TRUE_WORD : ZERO_WORD,
    logIndex,
    topics: [SET_PERMISSION_TOPIC, topic(entity), topic(app), role],
  };
}

function grant(entity: string, app: string, role: string, blockNumber = 1, logIndex = 0): AragonEvent {
  return { allowed: true, app, blockNumber, entity, kind: "permission", logIndex, role };
}

function revoke(entity: string, app: string, role: string, blockNumber = 1, logIndex = 0): AragonEvent {
  return { allowed: false, app, blockNumber, entity, kind: "permission", logIndex, role };
}

function params(
  entity: string,
  app: string,
  role: string,
  paramsHash: string,
  blockNumber = 1,
  logIndex = 0,
): AragonEvent {
  return { app, blockNumber, entity, kind: "params", logIndex, paramsHash, role };
}

describe("aragon log parsing", () => {
  it("reads a grant and a revocation apart by the data bool alone", () => {
    const granted = parseAragonLog(permissionLog(AGENT, LIDO, BUFFER_ROLE, true, 7, 3));
    const revoked = parseAragonLog(permissionLog(AGENT, LIDO, BUFFER_ROLE, false, 7, 4));

    assert.equal(granted.ok && granted.event.kind === "permission" && granted.event.allowed, true);
    assert.equal(revoked.ok && revoked.event.kind === "permission" && revoked.event.allowed, false);
  });

  it("refuses a permission bool that is neither zero nor one", () => {
    const log = permissionLog(AGENT, LIDO, BUFFER_ROLE, true);
    const parsed = parseAragonLog({ ...log, data: `0x${"0".repeat(62)}02` });

    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.reason : "", /neither 0 nor 1/);
  });

  it("refuses an unrecognized topic0 instead of guessing an event shape", () => {
    const parsed = parseAragonLog({
      address: ACL,
      blockNumber: 1,
      data: TRUE_WORD,
      logIndex: 0,
      topics: [`0x${"c".repeat(64)}`, topic(AGENT), topic(LIDO), BUFFER_ROLE],
    });

    assert.equal(parsed.ok, false);
  });

  it("reads a params event and a manager change", () => {
    const paramsParsed = parseAragonLog({
      address: ACL,
      blockNumber: 2,
      data: HASH_A,
      logIndex: 0,
      topics: [SET_PERMISSION_PARAMS_TOPIC, topic(AGENT), topic(LIDO), BUFFER_ROLE],
    });
    const managerParsed = parseAragonLog({
      address: ACL,
      blockNumber: 3,
      data: "0x",
      logIndex: 0,
      topics: [CHANGE_PERMISSION_MANAGER_TOPIC, topic(LIDO), BUFFER_ROLE, topic(VOTING)],
    });

    assert.equal(paramsParsed.ok && paramsParsed.event.kind === "params" && paramsParsed.event.paramsHash, HASH_A);
    assert.equal(managerParsed.ok && managerParsed.event.kind === "manager" && managerParsed.event.manager, VOTING);
  });
});

describe("aragon event folding", () => {
  it("keeps the last write per triple, ordered by block then log index", () => {
    // the live shape of block 24340775: granted and revoked within one block
    const state = foldAragonEvents([
      revoke(AGENT, LIDO, STAKING_CONTROL, 24_340_775, 5),
      grant(AGENT, LIDO, STAKING_CONTROL, 24_340_775, 2),
    ]);

    assert.deepEqual([...(state.granted.get(appRoleKey(LIDO, STAKING_CONTROL)) ?? [])], []);
  });

  it("clears the params hash on revocation, so a later plain grant is unconditional", () => {
    const state = foldAragonEvents([
      params(AGENT, LIDO, BUFFER_ROLE, HASH_A, 1, 0),
      grant(AGENT, LIDO, BUFFER_ROLE, 1, 1),
      revoke(AGENT, LIDO, BUFFER_ROLE, 2, 0),
      grant(AGENT, LIDO, BUFFER_ROLE, 3, 0),
    ]);

    assert.equal(state.granted.get(appRoleKey(LIDO, BUFFER_ROLE))?.has(AGENT), true);
    assert.equal(state.paramsHash.has(`${appRoleKey(LIDO, BUFFER_ROLE)}|${AGENT}`), false);
  });

  it("removes a manager set to the zero address", () => {
    const state = foldAragonEvents([
      { app: LIDO, blockNumber: 1, kind: "manager", logIndex: 0, manager: VOTING, role: BUFFER_ROLE },
      { app: LIDO, blockNumber: 2, kind: "manager", logIndex: 0, manager: `0x${"0".repeat(40)}`, role: BUFFER_ROLE },
    ]);

    assert.equal(state.managers.has(appRoleKey(LIDO, BUFFER_ROLE)), false);
  });

  it("does not depend on arrival order", () => {
    const events = [
      grant(AGENT, LIDO, BUFFER_ROLE, 1),
      revoke(AGENT, LIDO, BUFFER_ROLE, 2),
      grant(VOTING, LIDO, BUFFER_ROLE, 3),
    ];
    const a = foldAragonEvents(events);
    const b = foldAragonEvents(events.toReversed());

    assert.deepEqual(
      [...(a.granted.get(appRoleKey(LIDO, BUFFER_ROLE)) ?? [])].toSorted(),
      [...(b.granted.get(appRoleKey(LIDO, BUFFER_ROLE)) ?? [])].toSorted(),
    );
  });
});

describe("aragon storage derivation", () => {
  // read off mainnet and pinned: the live BUFFER_RESERVE_MANAGER_ROLE grant to the Agent
  it("derives the permission slot the chain actually uses", () => {
    assert.equal(
      permissionSlot(AGENT, LIDO, BUFFER_ROLE),
      "0xcbe83f30c53851e7ec4a1e6338c65f6ba6921f60eb3e1d4491b05951944d4e4c",
    );
  });

  it("derives the slot of a revoked permission (reads zero on chain)", () => {
    assert.equal(
      permissionSlot(VOTING, LIDO, STAKING_CONTROL),
      "0xe3a563c9a3b32b5cc89050eebb355635356d1b5c9f522d7d350e8bb60b673af5",
    );
  });

  it("derives the manager slot at mapping index 2, where the Agent reads back", () => {
    assert.equal(managerSlot(LIDO, BUFFER_ROLE), "0xbe5fb314ac06749ed886628bd8ade5e00bf09f6d2812f8d14ea12038d7ebdb87");
  });

  it("decodes the three meanings a permission word can have", () => {
    assert.deepEqual(decodePermissionWord(ZERO_WORD), { kind: "absent" });
    assert.deepEqual(decodePermissionWord(EMPTY_PARAM_HASH), { kind: "unconditional" });
    assert.deepEqual(decodePermissionWord(HASH_A), { kind: "params", paramsHash: HASH_A });
  });
});

describe("params digest", () => {
  const pairs = [
    { entity: VOTING, paramsHash: HASH_A },
    { entity: AGENT, paramsHash: `0x${"b".repeat(64)}` },
  ];

  it("is order independent", () => {
    assert.equal(paramsDigest(pairs), paramsDigest(pairs.toReversed()));
  });

  it("changes when a member is added, removed, or its params change", () => {
    const base = paramsDigest(pairs);

    assert.notEqual(paramsDigest(pairs.slice(0, 1)), base);
    assert.notEqual(paramsDigest([...pairs, { entity: ANY_ENTITY, paramsHash: HASH_A }]), base);
    assert.notEqual(paramsDigest([pairs[0], { ...pairs[1], paramsHash: HASH_A }]), base);
  });
});
