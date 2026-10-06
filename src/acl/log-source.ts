import type { JsonRpcProvider } from "ethers";

import { printError } from "../common";
import { registerSecret } from "../context";
import { httpGetAsync, isTransientExplorerHttpError, RetryingJsonRpcProvider } from "../explorer";
import { log } from "../logger";
import { parseRoleLog, type RawLog, ROLE_GRANTED_TOPIC, type RoleEvent } from "./fold";

/**
 * Where a chain's role logs are read from. Hardcoded rather than configured: which explorer serves
 * a chain for free is a property of the world, not of a deployment, and getting it wrong should
 * cost a code review rather than a YAML edit.
 */
export type LogSource = { kind: "etherscan" } | { kind: "blockscout"; hostname: string };

interface ChainLogSource {
  /**
   * How far behind the head the scan stops. It covers the explorer's indexing lag and any shallow
   * reorg, so the answer describes a settled range rather than the last few seconds of the chain.
   */
  confirmationLag: number;
  source: LogSource;
}

// etherscan v2's free tier serves most of these but refuses 10 and 8453 outright ("Free API
// access is not supported for this chain"), so those two are served by blockscout. A chain absent
// from this table cannot be scanned at all, and the check records a skip rather than a pass.
// The lag is roughly two minutes of wall time on each chain: enough to clear the explorer's
// indexing delay and any shallow reorg.
export const CHAIN_LOG_SOURCES: Readonly<Record<string, ChainLogSource>> = {
  "1": { confirmationLag: 8, source: { kind: "etherscan" } },
  "10": { confirmationLag: 60, source: { hostname: "explorer.optimism.io", kind: "blockscout" } },
  "130": { confirmationLag: 120, source: { kind: "etherscan" } },
  "4663": { confirmationLag: 1200, source: { hostname: "robinhoodchain.blockscout.com", kind: "blockscout" } },
  "8453": { confirmationLag: 60, source: { hostname: "base.blockscout.com", kind: "blockscout" } },
  "42161": { confirmationLag: 240, source: { kind: "etherscan" } },
  "59144": { confirmationLag: 30, source: { kind: "etherscan" } },
  "560048": { confirmationLag: 8, source: { kind: "etherscan" } },
  "11155111": { confirmationLag: 8, source: { kind: "etherscan" } },
  "11155420": { confirmationLag: 60, source: { kind: "etherscan" } },
};

// Only grants are fetched: candidacy is a union of grants, and membership is the chain's answer,
// so revocation events would add requests without adding evidence
const ROLE_TOPICS = [ROLE_GRANTED_TOPIC];
// Both explorer families cap a logs response at 1000 records, and neither says so when it happens
const EXPLORER_RESULT_CAP = 1000;

export interface ScanRange {
  fromBlock: number;
  toBlock: number;
}

/** A deployment newer than the settled head has no settled history to scan yet. */
export function makeSettledScanRange(fromBlock: number, toBlock: number): ScanRange {
  if (fromBlock > toBlock) {
    throw new Error(
      `deployment block ${fromBlock} is newer than settled scan head ${toBlock}; deployment is not yet settled`,
    );
  }
  return { fromBlock, toBlock };
}

type ScanOutcome = { events: RoleEvent[]; ok: true; source: string } | { ok: false; reason: string };

export function describeSource(source: LogSource, chainId: string): string {
  return source.kind === "etherscan" ? `etherscan-v2(chainId=${chainId})` : source.hostname;
}

/**
 * Splits a window whose answer came back at the source's record cap and asks again for each half.
 *
 * This is the whole truncation defence, so it does not lean on anything a particular explorer
 * does. Paging is not usable: etherscan honours `page`/`offset`, blockscout ignores both and
 * returns the same records for every page, so a page walk would loop on a truncated blockscout
 * answer while believing it was making progress. Narrowing the block range is the one thing every
 * source understands, and a full window is the only hint either gives that records were dropped --
 * neither sets an error or a flag.
 */
export async function fetchWindow(
  range: ScanRange,
  cap: number,
  fetchOnce: (range: ScanRange) => Promise<RawLog[]>,
  refusesSpan?: (error: unknown) => boolean,
  // the widest span not yet refused, shared by the halves so a known limit is not asked again
  widest = { blocks: Number.POSITIVE_INFINITY },
): Promise<RawLog[]> {
  const blocks = range.toBlock - range.fromBlock + 1;
  if (blocks <= widest.blocks) {
    try {
      const logs = await fetchOnce(range);
      if (logs.length < cap) return logs;
    } catch (error) {
      if (!refusesSpan?.(error) || blocks === 1) throw error;
      widest.blocks = blocks - 1;
    }
  }

  if (range.fromBlock >= range.toBlock) {
    throw new Error(`block ${range.fromBlock} alone fills the ${cap}-record limit, so the window cannot be narrowed`);
  }
  const middle = Math.floor((range.fromBlock + range.toBlock) / 2);
  const lower = await fetchWindow({ fromBlock: range.fromBlock, toBlock: middle }, cap, fetchOnce, refusesSpan, widest);
  const upper = await fetchWindow(
    { fromBlock: middle + 1, toBlock: range.toBlock },
    cap,
    fetchOnce,
    refusesSpan,
    widest,
  );
  return [...lower, ...upper];
}

// How nodes word a getLogs span or response they will not serve: "up to a 10 block range",
// "range too large", "limited to a 10,000 range", "more than 10000 results", "response size exceeded"
const SPAN_REFUSED =
  /block range|range (?:is )?too (?:large|wide|big)|limited to .*range|ranges? over|more than \d+ (?:results|logs)|max(?:imum)? (?:results|logs)|response size|too many (?:blocks|logs|results)/i;
const RATE_LIMITED_RPC = /rate limit|too many requests|\b429\b|compute units/i;

/** A refusal a narrower window answers; a rate limit is not one, halving would only add requests. */
export function isSpanRefusal(error: unknown): boolean {
  const text = printError(error);
  return SPAN_REFUSED.test(text) && !RATE_LIMITED_RPC.test(text);
}

interface ExplorerLogsResponse {
  message?: string;
  result?: unknown;
  status?: string;
}

/**
 * A rate limit asks for a later retry, so the scan waits it out within the 300-second budget.
 * A longer cooldown fails the scan with a rate-limit error: the run ends, and the error blames
 * the explorer's load, not the state.
 */
const RATE_LIMITED = /rate limit|max calls per sec|too many requests|throttle/i;
let rateLimitPauseMs = 6000;
const RATE_LIMIT_ATTEMPTS = 3;

/** Only tests care to wait less; production wants the pause to mean something. */
export function setRateLimitPause(ms: number): void {
  rateLimitPauseMs = ms;
}

export function isRateLimitAnswer(response: ExplorerLogsResponse): boolean {
  const answer = `${response.message ?? ""} ${typeof response.result === "string" ? response.result : ""}`;
  return RATE_LIMITED.test(answer);
}

async function explorerGet(url: string): Promise<ExplorerLogsResponse> {
  for (let attempt = 0; ; attempt++) {
    let response: ExplorerLogsResponse;
    try {
      response = await httpGetAsync<ExplorerLogsResponse>(url);
    } catch (error) {
      if (!isTransientExplorerHttpError(error) || attempt >= RATE_LIMIT_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, rateLimitPauseMs));
      continue;
    }
    if (!isRateLimitAnswer(response) || attempt >= RATE_LIMIT_ATTEMPTS) return response;
    await new Promise((resolve) => setTimeout(resolve, rateLimitPauseMs));
  }
}

/** Credentials for the section's ABI explorer, set as its checks begin. */
let configuredTokenEnv: string | undefined;
let configuredExplorerHostname: string | undefined;

export function setExplorerTokenEnv(name: string | undefined, hostname: string | undefined): void {
  configuredTokenEnv = name;
  configuredExplorerHostname = hostname?.toLowerCase();
}

function explorerToken(fallback: string, hostname: string): [string | undefined, string] {
  const sameExplorer =
    configuredExplorerHostname === hostname ||
    (hostname === "api.etherscan.io" && configuredExplorerHostname?.endsWith(".etherscan.io"));
  if (sameExplorer && configuredTokenEnv && process.env[configuredTokenEnv]) {
    return [process.env[configuredTokenEnv], configuredTokenEnv];
  }
  return [process.env[fallback], fallback];
}

function explorerUrl(source: LogSource, chainId: string, query: string): string {
  if (source.kind === "blockscout") {
    const [key, name] = explorerToken("BLOCKSCOUT_TOKEN", source.hostname);
    if (key) {
      registerSecret(key, `$${name}`);
      registerSecret(encodeURIComponent(key), `$${name}`);
    }
    return `https://${source.hostname}/api?${query}${key ? `&apikey=${encodeURIComponent(key)}` : ""}`;
  }
  const [key, name] = explorerToken("ETHERSCAN_TOKEN", "api.etherscan.io");
  if (key) {
    registerSecret(key, `$${name}`);
    registerSecret(encodeURIComponent(key), `$${name}`);
  }
  return `https://api.etherscan.io/v2/api?chainid=${chainId}&${query}${key ? `&apikey=${encodeURIComponent(key)}` : ""}`;
}

/**
 * Explorer quantities arrive as hex strings, decimal strings or numbers depending on the host and
 * the field. etherscan writes the zeroth log index as the empty quantity `"0x"` rather than `0x0`,
 * which `Number` reads as NaN -- and a log dropped for being unreadable fails the whole scan.
 */
export function parseQuantity(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (/^0x$/i.test(text)) return 0;
  if (/^0x[\da-f]+$/i.test(text)) return Number.parseInt(text, 16);
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10);
  return undefined;
}

function normalizeLog(raw: Record<string, unknown>): RawLog | undefined {
  const topics = raw.topics;
  const address = String(raw.address ?? "");
  const blockNumber = parseQuantity(raw.blockNumber);
  const logIndex = parseQuantity(raw.logIndex ?? raw.index);
  if (!address || !Array.isArray(topics) || blockNumber === undefined || logIndex === undefined) {
    return undefined;
  }
  return {
    address,
    blockNumber,
    data: typeof raw.data === "string" ? raw.data : undefined,
    logIndex,
    topics: topics.filter((topic): topic is string => typeof topic === "string"),
  };
}

/**
 * One request per topic0. The etherscan-compatible OR syntax for topics differs between etherscan
 * and blockscout, and getting it wrong fails by returning *fewer* logs -- the one outcome this
 * scan must never reach quietly.
 */
async function fetchLogs(
  source: LogSource,
  chainId: string,
  address: string,
  topic0: string,
  range: ScanRange,
): Promise<RawLog[]> {
  const query = `module=logs&action=getLogs&address=${address}&topic0=${topic0}&fromBlock=${range.fromBlock}&toBlock=${range.toBlock}`;
  const response = await explorerGet(explorerUrl(source, chainId, query));
  if (!Array.isArray(response.result)) {
    const answer = `${response.message ?? ""} ${typeof response.result === "string" ? response.result : ""}`.trim();
    // an empty window is a normal answer, not a failure
    if (/no (?:records|logs) found/i.test(answer)) return [];
    throw new Error(`refused: ${answer || JSON.stringify(response).slice(0, 200)}`);
  }
  return response.result.map((entry) => {
    const normalized = normalizeLog(entry as Record<string, unknown>);
    if (!normalized) throw new Error(`returned a log this scan cannot read: ${JSON.stringify(entry)}`);
    return normalized;
  });
}

function collect(raw: readonly RawLog[]): { events: RoleEvent[]; rejected: string[] } {
  const events: RoleEvent[] = [];
  const rejected: string[] = [];
  for (const entry of raw) {
    const parsed = parseRoleLog(entry);
    if (parsed.ok) {
      events.push(parsed.event);
    } else {
      rejected.push(`${entry.blockNumber}#${entry.logIndex}: ${parsed.reason}`);
    }
  }
  return { events, rejected };
}

export function hasLogSource(chainId: string): boolean {
  return CHAIN_LOG_SOURCES[chainId] !== undefined;
}

export type RawLogsOutcome = { logs: RawLog[]; ok: true; source: string } | { ok: false; reason: string };

export const LOGS_RPC_SOURCE = "logs rpc";

/**
 * The transport every ACL flavour shares: capped-window fetching per topic0, nothing parsed. A
 * section that names a logs RPC reads the range there instead of from the chain's explorer.
 */
export async function collectTopicLogs(
  chainId: string,
  address: string,
  topics0: readonly string[],
  range: ScanRange,
  logsProvider?: JsonRpcProvider,
): Promise<RawLogsOutcome> {
  const chain = CHAIN_LOG_SOURCES[chainId];
  if (!chain) return { ok: false, reason: `no log source is known for chainId ${chainId}` };
  if (logsProvider) {
    try {
      return { logs: await collectTailLogs(logsProvider, address, topics0, range), ok: true, source: LOGS_RPC_SOURCE };
    } catch (error) {
      return { ok: false, reason: `${LOGS_RPC_SOURCE} failed: ${printError(error)}` };
    }
  }

  const name = describeSource(chain.source, chainId);
  try {
    const raw: RawLog[] = [];
    for (const topic0 of topics0) {
      raw.push(
        ...(await fetchWindow(range, EXPLORER_RESULT_CAP, (window) =>
          fetchLogs(chain.source, chainId, address.toLowerCase(), topic0, window),
        )),
      );
    }
    return { logs: raw, ok: true, source: name };
  } catch (error) {
    return { ok: false, reason: `${name} failed: ${printError(error)}` };
  }
}

export async function collectRoleEvents(
  chainId: string,
  address: string,
  range: ScanRange,
  logsProvider?: JsonRpcProvider,
): Promise<ScanOutcome> {
  const outcome = await collectTopicLogs(chainId, address, ROLE_TOPICS, range, logsProvider);
  if (!outcome.ok) return outcome;
  const { events, rejected } = collect(outcome.logs);
  if (rejected.length > 0) {
    return { ok: false, reason: `${outcome.source} served ${rejected.length} unreadable log(s): ${rejected[0]}` };
  }
  return { events, ok: true, source: outcome.source };
}

/**
 * The block the scan starts from, taken from the explorer's record of the deployment transaction.
 *
 * Deliberately not probed from the chain. A load-balanced public RPC sends historical
 * `eth_getCode` to whichever backend answers, and a pruned one reports an empty account for a
 * block that has code -- observed live on more than one chain, in both directions, minutes apart.
 * A bound that came back too high would silently cut the front off the history, the one error this
 * scan cannot afford; the explorer's record is a transaction, not prunable state.
 */
export async function resolveDeploymentBlock(chainId: string, address: string): Promise<number | undefined> {
  const source = CHAIN_LOG_SOURCES[chainId]?.source;
  if (!source) return undefined;

  const url = explorerUrl(source, chainId, `module=contract&action=getcontractcreation&contractaddresses=${address}`);
  let response: ExplorerLogsResponse;
  try {
    response = await explorerGet(url);
  } catch (error) {
    log(`    creation block: ${describeSource(source, chainId)} unreachable (${printError(error)})`);
    return undefined;
  }

  const entry = (Array.isArray(response.result) ? response.result[0] : undefined) as
    | Record<string, unknown>
    | undefined;
  // getcontractcreation takes a list of addresses and answers in its own order, so the row has to
  // be checked against the address that was asked about rather than assumed to match
  if (!entry || String(entry.contractAddress ?? "").toLowerCase() !== address.toLowerCase()) return undefined;

  const blockNumber = Number(entry.blockNumber);
  return Number.isInteger(blockNumber) && blockNumber >= 0 ? blockNumber : undefined;
}

/**
 * Where the scan's two ranges meet. The explorer serves the settled history -- holding short of
 * the head keeps its answer past the indexing lag and any shallow reorg -- and the RPC fills the
 * tail from there to the head captured when the scan started. Without the tail, the last minutes
 * before every run would be a standing blind spot on exactly the schedule an attacker gets to
 * pick; with it, the only changes a run can miss are the ones made after it began, which no
 * terminating check can cover. The RPC already decides membership through views and storage
 * reads, so letting it nominate tail candidates adds no new trust root.
 *
 * By default views and storage reads are NOT pinned to the captured block. Answers describe
 * the state at read time: a permission that moves mid-run either fails a check closed -- one
 * cheap re-run on a chain that has stopped moving -- or moved after the run began, which no
 * terminating check covers pinned or not, because events through the captured head cannot
 * nominate it either way. Pinning every read to one historical block would buy per-section
 * snapshot consistency at the price of a hard archive-state dependency: a non-archive node keeps
 * roughly the last 128 states, under a minute of blocks on the fastest supported chains, which
 * an ordinary run outlives in its happy path. And a config is many sections, each capturing its
 * own head, so the run as a whole still would not describe one block. `--block` opts into that
 * price: every read and this head then name one block, and the RPC must serve its state.
 */
export interface ScanBounds {
  /** The chain head at the moment the scan started; candidacy is complete through here. */
  captured: number;
  /** Where the explorer's settled range ends and the RPC tail begins. */
  settled: number;
}

export async function resolveScanBounds(
  chainId: string,
  provider: JsonRpcProvider,
  logsProvider?: JsonRpcProvider,
): Promise<ScanBounds> {
  const lag = CHAIN_LOG_SOURCES[chainId]?.confirmationLag ?? 0;
  // --block pins the capture; the head still decides how much of it is settled
  const pinned = provider instanceof RetryingJsonRpcProvider ? provider.pinned?.number : undefined;
  const head =
    provider instanceof RetryingJsonRpcProvider && pinned !== undefined
      ? await provider.getHeadBlockNumber()
      : await provider.getBlockNumber();
  let captured = pinned ?? head;
  if (logsProvider) {
    // A node short of the capture answers the blocks it lacks with silence, which reads as "no grants"
    const served = await logsProvider.getBlockNumber();
    if (served < captured) {
      if (pinned !== undefined) throw new Error(`the logs RPC is at block ${served}, short of the pinned ${pinned}`);
      captured = served;
    }
    // A hash pin is re-read on the state RPC only; logs from a node on another branch would not be caught
    const tag = provider instanceof RetryingJsonRpcProvider ? provider.pinned?.tag : undefined;
    if (typeof tag === "object") {
      const hash = (await logsProvider.getBlock(captured))?.hash?.toLowerCase();
      if (hash !== tag.blockHash) {
        throw new Error(`the logs RPC holds ${hash ?? "no block"} at ${captured}, not the pinned ${tag.blockHash}`);
      }
    }
  }
  // A pin at least `lag` behind the head is settled already: the log source serves all of it
  return { captured, settled: Math.max(0, Math.min(captured, head - lag)) };
}

/** An RPC's logs for a range, in windows halved for as long as the node refuses the span. */
export async function collectTailLogs(
  provider: JsonRpcProvider,
  address: string,
  topics0: readonly string[],
  range: ScanRange,
): Promise<RawLog[]> {
  if (range.fromBlock > range.toBlock) return [];
  // An RPC refuses rather than truncates, so there is no record cap, only the span
  return fetchWindow(
    range,
    Number.POSITIVE_INFINITY,
    async (window) => {
      const logs = await provider.getLogs({
        address,
        fromBlock: window.fromBlock,
        toBlock: window.toBlock,
        topics: [[...topics0]],
      });
      return logs.map((entry) => ({
        address: entry.address,
        blockNumber: entry.blockNumber,
        data: entry.data,
        logIndex: entry.index,
        topics: [...entry.topics],
      }));
    },
    isSpanRefusal,
  );
}

export async function collectTailRoleEvents(
  provider: JsonRpcProvider,
  address: string,
  range: ScanRange,
): Promise<ScanOutcome> {
  let raw: RawLog[];
  try {
    raw = await collectTailLogs(provider, address, ROLE_TOPICS, range);
  } catch (error) {
    return {
      ok: false,
      reason: `the RPC would not serve the tail ${range.fromBlock}-${range.toBlock}: ${printError(error)}`,
    };
  }
  const { events, rejected } = collect(raw);
  if (rejected.length > 0) {
    return { ok: false, reason: `the RPC served ${rejected.length} unreadable log(s): ${rejected[0]}` };
  }
  return { events, ok: true, source: "rpc" };
}
