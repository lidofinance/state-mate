import { concat, keccak256, id as keccakId, toUtf8Bytes, zeroPadValue } from "ethers";

import type { RawLog } from "./fold";

// Aragon ACL events. Grant and revoke share one signature and are told apart by a bool in the
// DATA field -- the exact shape the OpenZeppelin fold refuses, which is why Aragon gets its own.
// event SetPermission(address indexed entity, address indexed app, bytes32 indexed role, bool allowed);
// event SetPermissionParams(address indexed entity, address indexed app, bytes32 indexed role, bytes32 paramsHash);
// event ChangePermissionManager(address indexed app, bytes32 indexed role, address indexed manager);
export const SET_PERMISSION_TOPIC = keccakId("SetPermission(address,address,bytes32,bool)");
export const SET_PERMISSION_PARAMS_TOPIC = keccakId("SetPermissionParams(address,address,bytes32,bytes32)");
export const CHANGE_PERMISSION_MANAGER_TOPIC = keccakId("ChangePermissionManager(address,bytes32,address)");
export const ARAGON_ACL_TOPICS = [SET_PERMISSION_TOPIC, SET_PERMISSION_PARAMS_TOPIC, CHANGE_PERMISSION_MANAGER_TOPIC];

/** keccak256(uint256(0)): the params hash aragonOS stores for an unconditional permission. */
export const EMPTY_PARAM_HASH = "0x290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563";
/** The aragonOS wildcard entity: a permission granted to everyone. Never legitimate at Lido. */
export const ANY_ENTITY = "0xffffffffffffffffffffffffffffffffffffffff";
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const ZERO_WORD = `0x${"0".repeat(64)}`;
const TRUE_WORD = `0x${"0".repeat(63)}1`;

export type AragonEvent =
  | {
      kind: "permission";
      entity: string;
      app: string;
      role: string;
      allowed: boolean;
      blockNumber: number;
      logIndex: number;
    }
  | {
      kind: "params";
      entity: string;
      app: string;
      role: string;
      paramsHash: string;
      blockNumber: number;
      logIndex: number;
    }
  | { kind: "manager"; app: string; role: string; manager: string; blockNumber: number; logIndex: number };

export type ParsedAragonLog = { ok: true; event: AragonEvent } | { ok: false; reason: string };

const BYTES32 = /^0x[\da-f]{64}$/;
const ADDRESS_TOPIC = /^0x0{24}([\da-f]{40})$/;

function topicAddress(topic: string): string | undefined {
  const match = ADDRESS_TOPIC.exec(topic);
  return match ? `0x${match[1]}` : undefined;
}

/**
 * A log is folded only when it is unambiguously one of the three ACL events with the exact layout
 * aragonOS emits. The permission bool lives in data, so a data word that is neither zero nor one
 * is refused rather than coerced -- treating it as either value would invent or erase a grant.
 */
export function parseAragonLog(log: RawLog): ParsedAragonLog {
  const topics = log.topics.map((topic) => topic.toLowerCase());
  const [signature] = topics;
  const at = { blockNumber: log.blockNumber, logIndex: log.logIndex };

  if (!ARAGON_ACL_TOPICS.includes(signature)) return { ok: false, reason: `unrecognized topic0 ${signature}` };
  if (topics.length !== 4) return { ok: false, reason: `expected 4 topics, got ${topics.length}` };

  if (signature === CHANGE_PERMISSION_MANAGER_TOPIC) {
    const app = topicAddress(topics[1]);
    const manager = topicAddress(topics[3]);
    if (!app || !BYTES32.test(topics[2]) || !manager) {
      return { ok: false, reason: `manager log with malformed topics at ${at.blockNumber}#${at.logIndex}` };
    }
    return { event: { app, kind: "manager", manager, role: topics[2], ...at }, ok: true };
  }

  const entity = topicAddress(topics[1]);
  const app = topicAddress(topics[2]);
  const role = topics[3];
  const data = (log.data ?? "").toLowerCase();
  if (!entity || !app || !BYTES32.test(role)) {
    return { ok: false, reason: `permission log with malformed topics at ${at.blockNumber}#${at.logIndex}` };
  }

  if (signature === SET_PERMISSION_PARAMS_TOPIC) {
    if (!BYTES32.test(data)) return { ok: false, reason: `params log data is not a bytes32: ${data}` };
    return { event: { app, entity, kind: "params", paramsHash: data, role, ...at }, ok: true };
  }

  if (data !== ZERO_WORD && data !== TRUE_WORD) {
    return { ok: false, reason: `permission bool is neither 0 nor 1: ${data}` };
  }
  return { event: { allowed: data === TRUE_WORD, app, entity, kind: "permission", role, ...at }, ok: true };
}

export function appRoleKey(app: string, role: string): string {
  return `${app.toLowerCase()}|${role.toLowerCase()}`;
}

export interface AragonState {
  /** app|role -> live entity set per the events. A fully revoked role keeps its key, emptied. */
  granted: Map<string, Set<string>>;
  /**
   * app|role -> every entity a grant was EVER emitted for, revocations ignored. Candidacy for
   * discovery comes from here: a fabricated revocation must not remove a real holder before the
   * chain is asked, so only the ACL's storage may clear a candidate.
   */
  everGranted: Map<string, Set<string>>;
  /** app|role|entity -> params hash, for live grants that carry one. */
  paramsHash: Map<string, string>;
  /** app|role -> current manager per the events. A manager set to zero is removed. */
  managers: Map<string, string>;
  /** Every app|role a manager change was EVER emitted for; candidacy for manager discovery. */
  everManagedRoles: Set<string>;
}

export function foldAragonEvents(events: readonly AragonEvent[]): AragonState {
  const sorted = [...events].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const state: AragonState = {
    everGranted: new Map(),
    everManagedRoles: new Set(),
    granted: new Map(),
    managers: new Map(),
    paramsHash: new Map(),
  };

  for (const event of sorted) {
    const roleKey = appRoleKey(event.app, event.role);
    if (event.kind === "manager") {
      state.everManagedRoles.add(roleKey);
      if (event.manager === ZERO_ADDRESS) {
        state.managers.delete(roleKey);
      } else {
        state.managers.set(roleKey, event.manager);
      }
      continue;
    }
    const tripleKey = `${roleKey}|${event.entity}`;
    if (event.kind === "params") {
      state.paramsHash.set(tripleKey, event.paramsHash);
      continue;
    }
    let entities = state.granted.get(roleKey);
    if (!entities) {
      entities = new Set<string>();
      state.granted.set(roleKey, entities);
    }
    if (event.allowed) {
      entities.add(event.entity);
      let ever = state.everGranted.get(roleKey);
      if (!ever) {
        ever = new Set<string>();
        state.everGranted.set(roleKey, ever);
      }
      ever.add(event.entity);
    } else {
      // A revocation clears the params too: a later plain grant is unconditional, and the stale
      // hash must not resurrect a condition the chain no longer holds
      entities.delete(event.entity);
      state.paramsHash.delete(tripleKey);
    }
  }

  return state;
}

/** `permissions[keccak256("PERMISSION" ‖ entity ‖ app ‖ role)]`, the first declared slot of the ACL. */
export function permissionSlot(entity: string, app: string, role: string): string {
  const permissionHash = keccak256(concat([toUtf8Bytes("PERMISSION"), entity, app, role]));
  return keccak256(concat([permissionHash, zeroPadValue("0x00", 32)]));
}

/** `permissionManager[keccak256("ROLE" ‖ app ‖ role)]`, the third declared slot (index 2). */
export function managerSlot(app: string, role: string): string {
  const roleHash = keccak256(concat([toUtf8Bytes("ROLE"), app, role]));
  return keccak256(concat([roleHash, zeroPadValue("0x02", 32)]));
}

export type PermissionWord = { kind: "absent" } | { kind: "unconditional" } | { kind: "params"; paramsHash: string };

/**
 * The permission slot is richer than a bool: zero is no permission, EMPTY_PARAM_HASH is an
 * unconditional one, and anything else is the hash of the conditions the grant carries.
 */
export function decodePermissionWord(word: string): PermissionWord {
  const normalized = word.toLowerCase();
  if (normalized === ZERO_WORD) return { kind: "absent" };
  if (normalized === EMPTY_PARAM_HASH) return { kind: "unconditional" };
  return { kind: "params", paramsHash: normalized };
}

export interface ParamsPair {
  entity: string;
  paramsHash: string;
}

/**
 * One pin for a whole set of parameterized grants: keccak256 over (entity ‖ paramsHash) pairs
 * sorted by entity. Any membership change and any params change for an existing entity breaks it,
 * and the tool prints the live set on mismatch so re-pinning is one reviewed copy-paste.
 * Reproducible by hand: sort, concatenate, `cast keccak`.
 */
export function paramsDigest(pairs: readonly ParamsPair[]): string {
  const sorted = [...pairs].sort((a, b) => a.entity.toLowerCase().localeCompare(b.entity.toLowerCase()));
  return keccak256(concat(sorted.flatMap((pair) => [pair.entity, pair.paramsHash])));
}
