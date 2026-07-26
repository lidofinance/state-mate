import chalk from "chalk";
import { Contract, JsonRpcProvider } from "ethers";

import { printError } from "./common";
import { log, logErrorAndExit, logReplaceLine, WARNING_MARK } from "./logger";
import {
  Abi,
  AbiArgumentsLength,
  CommonResponseOkResult,
  ContractInfo,
  isCommonResponseOkResult,
  isResponseBad,
  isResponseOk,
  isValidAbi,
  MethodCallResults,
  ResponseBad,
} from "./types";

/** Blockscout instances serve ABIs without a key; etherscan does not. */
export function explorerNeedsApiKey(explorerHostname: string): boolean {
  return explorerHostname.includes("etherscan.io");
}

export function loadContract(address: string, abi: Abi, provider: JsonRpcProvider) {
  return new Contract(address, abi as unknown as string, provider);
}

export async function collectStaticCallResults(
  nonMutables: AbiArgumentsLength,
  contract: Contract,
): Promise<MethodCallResults> {
  const results: MethodCallResults = [];

  for (const { name: methodName, numArgs } of nonMutables) {
    let viewFunction: ReturnType<typeof contract.getFunction>;
    try {
      viewFunction = contract.getFunction(methodName);
    } catch {
      logErrorAndExit(`Failed to get method ${chalk.yellow(methodName)} from contract`);
    }
    let staticCallResult: string;
    logReplaceLine(`${methodName}...`);
    if (numArgs === 0) {
      try {
        const result: unknown = await viewFunction.staticCall();
        staticCallResult = ` ${result}`;
      } catch {
        staticCallResult = " view call reverted";
      }
    } else {
      staticCallResult = " need to specify args";
    }
    results.push({ methodName, staticCallResult });
  }
  logReplaceLine(`Done\n`);
  return results;
}

// Etherscan, blockscout and mode answer getsourcecode alike and only disagree on the key that
// carries the implementation address
type ExplorerContractResult = CommonResponseOkResult & {
  Implementation?: string;
  ImplementationAddress?: string;
  ImplementationAddresses?: string[];
};

function implementationAddressOf(result: ExplorerContractResult): string | undefined {
  const candidates = [result.Implementation, result.ImplementationAddress, result.ImplementationAddresses?.[0]];
  return candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0);
}

const RATE_LIMIT_RETRY_MS = 6 * 1000; // 5 seconds is not enough for BscScan free tier

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function retryOnRateLimit(response: ResponseBad, sourcesUrl: string, explorerHostname: string) {
  if (!response.result.includes("rate limit") && !response.message.includes("rate limit")) {
    return response;
  }
  log(`Reached rate limit ${explorerHostname}, waiting for ${RATE_LIMIT_RETRY_MS} ms...`);
  await sleep(RATE_LIMIT_RETRY_MS);
  return httpGetAsync(sourcesUrl);
}

export async function loadContractInfo(
  address: string,
  explorerHostname: string,
  explorerKey?: string,
  chainId?: number | string,
  visited: Set<string> = new Set(),
): Promise<ContractInfo | undefined> {
  visited.add(address.toLowerCase());
  const sourcesUrl = _getExplorerApiUrl(explorerHostname, address, explorerKey, chainId);

  // One address the explorer cannot serve, an unverified contract or a dead host for instance, must
  // not take the whole run down: the caller skips it and the ABIs downloaded so far reach the store
  const skip = (reason: string): undefined => {
    log(`${WARNING_MARK} ${chalk.yellow(`ABI ${address}: ${reason}`)}`);
  };

  let sourcesResponse: unknown;
  try {
    sourcesResponse = await httpGetAsync(sourcesUrl);
    if (isResponseBad(sourcesResponse)) {
      sourcesResponse = await retryOnRateLimit(sourcesResponse, sourcesUrl, explorerHostname);
    }
  } catch (error) {
    return skip(`${explorerHostname} is unreachable: ${printError(error)}`);
  }

  if (isResponseBad(sourcesResponse)) {
    return skip(`${explorerHostname} refused: ${sourcesResponse.message} ${JSON.stringify(sourcesResponse.result)}`);
  }
  if (!isResponseOk(sourcesResponse)) {
    return skip(`unexpected explorer response ${JSON.stringify(sourcesResponse)}`);
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

  const implementationAddress = implementationAddressOf(result);
  // An implementation chain that loops back on itself, a broken proxy for instance, would keep
  // the walk going forever
  const shouldDescend = implementationAddress && !visited.has(implementationAddress.toLowerCase());
  return {
    abi,
    address,
    contractName: result.ContractName,
    implementation: shouldDescend
      ? await loadContractInfo(implementationAddress, explorerHostname, explorerKey, chainId, visited)
      : undefined,
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

export async function httpGetAsync<T>(url: string): Promise<T> | never {
  for (let attempt = 0; ; attempt++) {
    const delay = reserveRequestSlot(Date.now());
    if (delay > 0) await sleep(delay);
    let response: Response;
    try {
      response = await fetch(url, { method: "GET" });
    } catch (error) {
      throw new Error(`Failed to fetch contract source code: ${printError(error)}`);
    }
    // A proxy in front of the explorer answers a burst with a plain 429 instead of the JSON-style
    // rate-limit body; give it the same single retry
    if (response.status === 429 && attempt === 0) {
      await sleep(RATE_LIMIT_RETRY_MS);
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Failed to fetch contract source code: HTTP status code ${response.status}: ${response.statusText}`,
      );
    }
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new Error(`Failed to fetch contract source code: ${printError(error)}`);
    }
  }
}

function _hexToDecimal(value: unknown): string | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) ? BigInt(value).toString() : undefined;
}

export async function fetchExplorerChainId(
  explorerHostname: string,
  explorerKey?: string,
): Promise<string | undefined> {
  try {
    const response = await fetch(`https://${explorerHostname}/api/eth-rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
    });
    if (response.ok) {
      const decimal = _hexToDecimal(((await response.json()) as { result?: unknown }).result);
      if (decimal !== undefined) return decimal;
    }
  } catch {
    /* fall through to the etherscan-compatible endpoint */
  }

  let url = `https://${explorerHostname}/api?module=proxy&action=eth_chainId`;
  if (explorerKey) {
    url += `&apikey=${explorerKey}`;
  }
  try {
    const response = await httpGetAsync<{ result?: unknown }>(url);
    return _hexToDecimal(response.result);
  } catch {
    return undefined;
  }
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

export async function verifyChainIdWithExplorer(
  explorerHostname: string,
  chainId: string,
  explorerKey?: string,
): Promise<void> {
  // etherscan v2 takes the chain as a request parameter, so the host cannot disagree with it;
  // only a host that serves a single fixed chain can contradict the config
  if (explorerHostname.includes("etherscan.io")) return;

  // one probe per host and chain: the ABI pass and the checks pass ask about the same sections
  const memoKey = `${explorerHostname}|${chainId}`;
  if (verifiedExplorerChains.has(memoKey)) return;

  const explorerChainId = await fetchExplorerChainId(explorerHostname, explorerKey);
  if (explorerChainId === undefined) {
    log(`${WARNING_MARK} ${chalk.yellow(`could not verify chainId ${chainId} against explorer ${explorerHostname}`)}`);
    return;
  }
  if (explorerChainId !== chainId) {
    logErrorAndExit(
      `The chainId ${chalk.yellow(chainId)} in the config does not match the explorer ${chalk.magenta(explorerHostname)} chain ${chalk.yellow(explorerChainId)}`,
    );
  }
  verifiedExplorerChains.add(memoKey);
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
