import chalk from "chalk";
import { Contract, JsonRpcProvider } from "ethers";

import { printError } from "./common";
import { log, logErrorAndExit, WARNING_MARK } from "./logger";
import {
  type Abi,
  type ContractInfo,
  isCommonResponseOkResult,
  isResponseBad,
  isResponseOk,
  isValidAbi,
} from "./types";

/** Blockscout instances serve ABIs without a key; etherscan does not. */
export function explorerNeedsApiKey(explorerHostname: string): boolean {
  return explorerHostname.includes("etherscan.io");
}

export function loadContract(address: string, abi: Abi, provider: JsonRpcProvider) {
  return new Contract(address, abi as unknown as string, provider);
}

const RATE_LIMIT_RETRY_MS = 6 * 1000; // 5 seconds is not enough for BscScan free tier

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A proxy answers a burst with a plain 429, an overloaded backend with a 5xx or a 408 timeout;
// for an idempotent request all of them deserve another try
const isTransientHttpStatus = (status: number) => status === 408 || status === 429 || status >= 500;

// Carries whether one more attempt could help, so the single retry loop upstairs can decide
// without parsing messages
class ExplorerHttpError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly retryDelayMs = 0,
  ) {
    super(message);
  }
}

/** Keeps the HTTP error type private while letting a caller own one bounded retry budget. */
export function isTransientExplorerHttpError(error: unknown): boolean {
  return error instanceof ExplorerHttpError && error.transient;
}

export async function loadContractInfo(
  address: string,
  explorerHostname: string,
  explorerKey?: string,
  chainId?: number | string,
): Promise<ContractInfo | undefined> {
  let outcome = await _fetchContractInfo(address, explorerHostname, explorerKey, chainId);
  if (!outcome.contract && outcome.transient) {
    if (outcome.retryDelayMs) await sleep(outcome.retryDelayMs);
    outcome = await _fetchContractInfo(address, explorerHostname, explorerKey, chainId);
  }
  return outcome.contract;
}

type FetchOutcome = { contract?: ContractInfo; retryDelayMs?: number; transient?: boolean };

async function _fetchContractInfo(
  address: string,
  explorerHostname: string,
  explorerKey?: string,
  chainId?: number | string,
): Promise<FetchOutcome> {
  const sourcesUrl = _getExplorerApiUrl(explorerHostname, address, explorerKey, chainId);

  // One address the explorer cannot serve, an unverified contract or a dead host for instance, must
  // not take the whole run down: the caller skips it and the ABIs downloaded so far reach the store.
  // `transient` marks the failures worth one more fetch, against the definitive answers
  const skip = (reason: string, transient = false, retryDelayMs = 0): FetchOutcome => {
    log(`${WARNING_MARK} ${chalk.yellow(`ABI ${address}: ${reason}`)}`);
    return { retryDelayMs, transient };
  };

  let sourcesResponse: unknown;
  try {
    sourcesResponse = await httpGetAsync(sourcesUrl);
  } catch (error) {
    const transient = error instanceof ExplorerHttpError && error.transient;
    const retryDelayMs = error instanceof ExplorerHttpError ? error.retryDelayMs : 0;
    return skip(`${explorerHostname} is unreachable: ${printError(error)}`, transient, retryDelayMs);
  }

  if (isResponseBad(sourcesResponse)) {
    const answer = `${sourcesResponse.message} ${JSON.stringify(sourcesResponse.result)}`;
    // "not verified" is the explorer's final word; a rate limit deserves the retry after the
    // longer pause the free tiers want, an unexplained refusal after none
    if (/not verified/i.test(answer)) return skip(`${explorerHostname} refused: ${answer}`);
    return skip(`${explorerHostname} refused: ${answer}`, true, /rate limit/i.test(answer) ? RATE_LIMIT_RETRY_MS : 0);
  }
  if (!isResponseOk(sourcesResponse)) {
    return skip(`unexpected explorer response ${JSON.stringify(sourcesResponse)}`, true);
  }
  const result = sourcesResponse.result[0];
  if (!isCommonResponseOkResult(result)) {
    return skip(`explorer served no ABI: ${JSON.stringify(result)}`);
  }

  let abi: unknown;
  try {
    abi = JSON.parse(result.ABI);
  } catch (error) {
    return skip(`could not be read: ${printError(error)}`);
  }
  if (!isValidAbi(abi)) {
    return skip(`ABI is not valid (type mismatch): ${JSON.stringify(abi)}`);
  }

  return {
    contract: { abi, address, contractName: result.ContractName },
  };
}

// The free etherscan tier answers 3 calls per second and charges a multi-second penalty for
// breaking that, so every request reserves a slot up front instead of finding out the hard way.
const EXPLORER_REQUESTS_PER_SECOND = 3;
const MIN_REQUEST_INTERVAL_MS = Math.ceil(1000 / EXPLORER_REQUESTS_PER_SECOND);
let nextRequestAt = 0;

/** Returns how long this request has to wait, and books the slot for it. */
export function reserveRequestSlot(now: number): number {
  const slot = Math.max(now, nextRequestAt);
  nextRequestAt = slot + MIN_REQUEST_INTERVAL_MS;
  return slot - now;
}

export function resetRequestSlots(): void {
  nextRequestAt = 0;
}

// A single request with no retries of its own: loadContractInfo owns the whole retry budget,
// and a second layer of attempts here would multiply it
export async function httpGetAsync<T>(url: string): Promise<T> {
  const delay = reserveRequestSlot(Date.now());
  if (delay > 0) await sleep(delay);
  let response: Response;
  try {
    response = await fetch(url, { method: "GET" });
  } catch (error) {
    throw new ExplorerHttpError(`Failed to fetch contract source code: ${printError(error)}`, true);
  }
  if (!response.ok) {
    throw new ExplorerHttpError(
      `Failed to fetch contract source code: HTTP status code ${response.status}: ${response.statusText}`,
      isTransientHttpStatus(response.status),
      response.status === 429 ? RATE_LIMIT_RETRY_MS : 0,
    );
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new ExplorerHttpError(`Failed to fetch contract source code: ${printError(error)}`, true);
  }
}

function _hexToDecimal(value: unknown): string | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) ? BigInt(value).toString() : undefined;
}

export async function fetchExplorerChainId(
  explorerHostname: string,
  explorerKey?: string,
): Promise<string | undefined> {
  // A probe nobody answered blocks ABI downloads outright, so each route gets its own bounded
  // retry on a flake; the two-fetch budget of loadContractInfo is not involved.
  // The eth-rpc route is the one every checked blockscout actually serves, so giving up on it
  // early would send the probe to a fallback that answers "Unknown module"
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`https://${explorerHostname}/api/eth-rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
      });
      if (!response.ok) {
        if (!isTransientHttpStatus(response.status) || attempt > 0) break;
        if (response.status === 429) await sleep(RATE_LIMIT_RETRY_MS);
        continue;
      }
      const decimal = _hexToDecimal(((await response.json()) as { result?: unknown }).result);
      if (decimal !== undefined) return decimal;
      // the host answered without a chainId: it does not serve this route
      break;
    } catch {
      if (attempt > 0) break;
      /* a network flake: one more try, then the etherscan-compatible endpoint */
    }
  }

  let url = `https://${explorerHostname}/api?module=proxy&action=eth_chainId`;
  if (explorerKey) {
    url += `&apikey=${explorerKey}`;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await httpGetAsync<{ message?: unknown; result?: unknown }>(url);
      const decimal = _hexToDecimal(response.result);
      if (decimal !== undefined) return decimal;
      // a rate-limited answer arrives as HTTP 200 with a JSON complaint; worth the second try
      const answer = `${String(response.message ?? "")} ${JSON.stringify(response.result ?? "")}`;
      if (!/rate limit/i.test(answer) || attempt > 0) return undefined;
      await sleep(RATE_LIMIT_RETRY_MS);
    } catch (error) {
      if (!(error instanceof ExplorerHttpError) || !error.transient || attempt > 0) return undefined;
      if (error.retryDelayMs) await sleep(error.retryDelayMs);
    }
  }
  return undefined;
}

const TRANSIENT_RPC_RETRY_MS = 2000;
const TRANSIENT_RPC_ERROR = /\b(408|429|5\d\d)\b|timeout|econnreset|econnrefused/i;

function isTransientRpcError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (code === "SERVER_ERROR" || code === "TIMEOUT") return true;
  return TRANSIENT_RPC_ERROR.test(printError(error));
}

/** A public RPC drops a request now and then; one retry separates a flake from a real answer. */
export async function withTransientRetry<T>(run: () => Promise<T>, delayMs = TRANSIENT_RPC_RETRY_MS): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isTransientRpcError(error)) throw error;
    await sleep(delayMs);
    return run();
  }
}

class RetryingJsonRpcProvider extends JsonRpcProvider {
  override async send(method: string, parameters: unknown[] | Record<string, unknown>): Promise<unknown> {
    return withTransientRetry(() => super.send(method, parameters));
  }
}

export function createProvider(rpcUrl: string): JsonRpcProvider {
  // staticNetwork stops ethers from re-sending eth_chainId with every call, which otherwise
  // doubles traffic and trips rate limits on public RPCs
  return new RetryingJsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
}

/**
 * The checks run against whatever chain the RPC serves, so a wrong endpoint would green-light an
 * audit of the wrong network. staticNetwork caches the answer, the probe costs one call.
 */
export async function assertProviderChain(provider: JsonRpcProvider, chainId: string): Promise<void> {
  let served: string;
  try {
    const network = await provider.getNetwork();
    served = String(network.chainId);
  } catch (error) {
    logErrorAndExit(`The RPC did not answer eth_chainId: ${printError(error)}`);
  }
  if (served !== chainId) {
    logErrorAndExit(`The RPC serves chain ${chalk.yellow(served)}, while the config expects ${chalk.yellow(chainId)}`);
  }
}

const verifiedExplorerChains = new Set<string>();

/** Returns whether the explorer vouched for the chain; a mismatch exits outright. */
export async function verifyChainIdWithExplorer(
  explorerHostname: string,
  chainId: string,
  explorerKey?: string,
): Promise<boolean> {
  // etherscan v2 takes the chain as a request parameter, so the host cannot disagree with it;
  // only a host that serves a single fixed chain can contradict the config
  if (explorerHostname.includes("etherscan.io")) return true;

  // one probe per host and chain: the ABI pass and the checks pass ask about the same sections
  const memoKey = `${explorerHostname}|${chainId}`;
  if (verifiedExplorerChains.has(memoKey)) return true;

  const explorerChainId = await fetchExplorerChainId(explorerHostname, explorerKey);
  if (explorerChainId === undefined) {
    log(`${WARNING_MARK} ${chalk.yellow(`could not verify chainId ${chainId} against explorer ${explorerHostname}`)}`);
    return false;
  }
  if (explorerChainId !== chainId) {
    logErrorAndExit(
      `The chainId ${chalk.yellow(chainId)} in the config does not match the explorer ${chalk.magenta(explorerHostname)} chain ${chalk.yellow(explorerChainId)}`,
    );
  }
  verifiedExplorerChains.add(memoKey);
  return true;
}

function _getExplorerApiUrl(
  explorerHostname: string,
  address: string,
  explorerKey?: string,
  chainId?: number | string,
) {
  const isEtherscan = explorerHostname.includes("etherscan.io");
  let url: string;

  if (isEtherscan) {
    const chainIdNumber = typeof chainId === "string" ? Number(chainId) : chainId;
    if (typeof chainIdNumber !== "number" || Number.isNaN(chainIdNumber)) {
      logErrorAndExit(
        `The field ${chalk.magenta("chainId")} is required in the YAML for explorer ${chalk.yellow(explorerHostname)}`,
      );
    }
    // Use Etherscan v2 aggregator regardless of subdomain
    url = `https://api.etherscan.io/v2/api?chainId=${chainIdNumber}&module=contract&action=getsourcecode&address=${address}`;
  } else {
    url = `https://${explorerHostname}/api?module=contract&action=getsourcecode&address=${address}`;
  }

  if (explorerKey) {
    url += `&apikey=${explorerKey}`;
  }

  return url;
}
