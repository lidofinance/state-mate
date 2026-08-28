import { id as keccakId } from "ethers";

// event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
// event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
export const ROLE_GRANTED_TOPIC = keccakId("RoleGranted(bytes32,address,address)");
export const ROLE_REVOKED_TOPIC = keccakId("RoleRevoked(bytes32,address,address)");

/** The shape the log source normalizes to, so the fold never sees an explorer response. */
export interface RawLog {
  address: string;
  topics: readonly string[];
  blockNumber: number;
  logIndex: number;
}

export interface RoleEvent {
  /** The contract that emitted it: one scan covers every ACL contract on a chain. */
  address: string;
  role: string;
  account: string;
  blockNumber: number;
  logIndex: number;
  granted: boolean;
}

/** role => holders. A role whose holders were all revoked keeps its key with an empty set. */
export type RoleHolders = Map<string, Set<string>>;

export type ParsedLog = { ok: true; event: RoleEvent } | { ok: false; reason: string };

const BYTES32 = /^0x[\da-f]{64}$/;
const ADDRESS_TOPIC = /^0x0{24}([\da-f]{40})$/;

/**
 * A log is only folded when it is unambiguously one of the two events. Nothing here infers
 * "revoked" from "not granted": a contract can emit a hand-rolled log carrying a familiar topic0
 * with a different layout, and treating that as a revocation would silently *remove* a holder --
 * turning a discovery tool into one that hides the thing it went looking for.
 */
export function parseRoleLog(log: RawLog): ParsedLog {
  const topics = log.topics.map((topic) => topic.toLowerCase());
  const [signature, role, account] = topics;

  if (signature !== ROLE_GRANTED_TOPIC && signature !== ROLE_REVOKED_TOPIC) {
    return { ok: false, reason: `unrecognized topic0 ${signature}` };
  }
  // The standard events index all three arguments, so a conforming log always carries four topics
  if (topics.length !== 4) {
    return { ok: false, reason: `expected 4 topics, got ${topics.length}` };
  }
  if (!BYTES32.test(role)) {
    return { ok: false, reason: `role topic is not a bytes32: ${role}` };
  }
  // An address topic is left-padded with twelve zero bytes. Slicing the low 20 bytes off a topic
  // with dirt in the padding would invent an address that was never granted anything
  const address = ADDRESS_TOPIC.exec(account);
  if (!address) {
    return { ok: false, reason: `account topic is not a padded address: ${account}` };
  }

  return {
    ok: true,
    event: {
      account: `0x${address[1]}`,
      address: log.address.toLowerCase(),
      blockNumber: log.blockNumber,
      granted: signature === ROLE_GRANTED_TOPIC,
      logIndex: log.logIndex,
      role,
    },
  };
}

/** Chain order, which is the only order in which grant/revoke pairs mean anything. */
function sortRoleEvents(events: readonly RoleEvent[]): RoleEvent[] {
  return [...events].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

function roleEventKey(event: RoleEvent): string {
  return `${event.blockNumber}:${event.logIndex}`;
}

/**
 * One scan covers several contracts and two topics, so the same record can arrive twice.
 * (blockNumber, logIndex) is unique within a chain, which makes the fold's tally honest as well as
 * its result.
 */
function dedupeRoleEvents(events: readonly RoleEvent[]): RoleEvent[] {
  const seen = new Map<string, RoleEvent>();
  for (const event of events) seen.set(roleEventKey(event), event);
  return sortRoleEvents([...seen.values()]);
}

export function foldRoleEvents(events: readonly RoleEvent[]): RoleHolders {
  const holders: RoleHolders = new Map();

  for (const event of dedupeRoleEvents(events)) {
    let members = holders.get(event.role);
    if (!members) {
      members = new Set<string>();
      holders.set(event.role, members);
    }
    if (event.granted) {
      members.add(event.account);
    } else {
      members.delete(event.account);
    }
  }

  return holders;
}

/** Sorted, so that two runs over the same chain state print the same report. */
export function sortedHolders(holders: RoleHolders, role: string): string[] {
  return [...(holders.get(role) ?? [])].toSorted((a, b) => a.localeCompare(b));
}

export function sortedRoles(holders: RoleHolders): string[] {
  return [...holders.keys()].toSorted((a, b) => a.localeCompare(b));
}
