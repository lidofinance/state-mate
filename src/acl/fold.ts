import { id as keccakId } from "ethers";

// event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
// event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
export const ROLE_GRANTED_TOPIC = keccakId("RoleGranted(bytes32,address,address)");
export const ROLE_REVOKED_TOPIC = keccakId("RoleRevoked(bytes32,address,address)");

/** The shape the log source normalizes to, so the fold never sees an explorer response. */
export interface RawLog {
  address: string;
  topics: readonly string[];
  /** Hex payload; carries the grant/revoke bool of an Aragon SetPermission. Absent on OZ logs. */
  data?: string;
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

/**
 * Candidates are every (role, account) pair a grant was ever emitted for, revocations ignored.
 *
 * Revocations must not decide candidacy: a fabricated RoleRevoked from the log source would
 * remove a real holder before the chain is ever asked about it, silently hiding exactly the
 * holder this scan exists to find. Membership is the chain's answer -- hasRole and the raw
 * membership slot -- so a stale candidate costs one refuted lookup, while a dropped one costs
 * the finding. This also makes event ordering irrelevant: a set union has no order.
 */
export function grantedCandidates(events: readonly RoleEvent[]): RoleHolders {
  const candidates: RoleHolders = new Map();
  for (const event of events) {
    if (!event.granted) continue;
    let accounts = candidates.get(event.role);
    if (!accounts) {
      accounts = new Set<string>();
      candidates.set(event.role, accounts);
    }
    accounts.add(event.account);
  }
  return candidates;
}

/** Sorted, so that two runs over the same chain state print the same report. */
export function sortedHolders(holders: RoleHolders, role: string): string[] {
  return [...(holders.get(role) ?? [])].toSorted((a, b) => a.localeCompare(b));
}

export function sortedRoles(holders: RoleHolders): string[] {
  return [...holders.keys()].toSorted((a, b) => a.localeCompare(b));
}
