import chalk from "chalk";
import { Contract, JsonRpcProvider } from "ethers";

import { printError } from "./common";
import { BlockscoutHandler } from "./explorers/blockscout";
import { EtherscanHandler } from "./explorers/etherscan";
import { ModeHandler } from "./explorers/mode";
import { fetchSourcifySupportsChain, loadContractInfoFromSourcify } from "./explorers/sourcify";
import { log, LogCommand, logError, logErrorAndExit, logReplaceLine, WARNING_MARK } from "./logger";
import {
  Abi,
  AbiArgumentsLength,
  ContractInfo,
  isCommonResponseOkResult,
  isResponseBad,
  isResponseOk,
  isValidAbi,
  MethodCallResults,
  ResponseBad,
  ResponseOk,
} from "./types";

export type RateLimitHandler = (
  response: ResponseBad,
  sourcesUrl: string,
  explorerHostname: string,
) => Promise<unknown>;

export type GetContractInfoCallback = (
  explorer: IExplorerHandler,
  abi: Abi,
  response: ResponseOk,
  address: string,
  explorerHostname: string,
  explorerKey?: string,
  chainId?: number | string,
) => Promise<ContractInfo>;

export interface IExplorerHandler {
  requestWithRateLimit?: RateLimitHandler;
  getContractInfo: GetContractInfoCallback;
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

export async function loadContractInfoFromExplorer(
  address: string,
  explorerHostname: string,
  explorerKey?: string,
  chainId?: number | string,
): Promise<ContractInfo | undefined> {
  if (explorerHostname.includes("sourcify")) {
    if (chainId === undefined) {
      logErrorAndExit(`The field ${chalk.magenta("chainId")} is required to query Sourcify`);
    }
    return loadContractInfoFromSourcify(address, chainId);
  }
  let explorer: IExplorerHandler;
  if (explorerHostname.includes("mode.network")) {
    explorer = new ModeHandler();
  } else if (explorerHostname.includes("blockscout.com")) {
    explorer = new BlockscoutHandler();
  } else {
    explorer = new EtherscanHandler();
  }
  return loadContractInfo(explorer, address, explorerHostname, explorerKey, chainId);
}

export async function loadContractInfo(
  explorer: IExplorerHandler,
  address: string,
  explorerHostname: string,
  explorerKey?: string,
  chainId?: number | string,
) {
  const sourcesUrl = _getExplorerApiUrl(explorerHostname, address, explorerKey, chainId);

  let sourcesResponse = await httpGetAsync(sourcesUrl);
  if (isResponseBad(sourcesResponse) && explorer.requestWithRateLimit) {
    sourcesResponse = await explorer.requestWithRateLimit(sourcesResponse, sourcesUrl, explorerHostname);
  }
  if (isResponseBad(sourcesResponse)) {
    logErrorAndExit(
      `Failed to download contract info from ${explorerHostname}: ${sourcesResponse.message}\n${JSON.stringify(sourcesResponse, null, 2)}`,
    );
  }

  if (!isResponseOk(sourcesResponse)) {
    logErrorAndExit(`Received unexpected response from explorer:\n${JSON.stringify(sourcesResponse)}`);
  }

  if (!isCommonResponseOkResult(sourcesResponse.result[0])) {
    logErrorAndExit(`It seems, explorer response has changed:\n${JSON.stringify(sourcesResponse)}`);
  }

  try {
    const abi: unknown = JSON.parse(sourcesResponse.result[0].ABI);

    if (!isValidAbi(abi)) {
      logErrorAndExit(
        `ABI for contract ${chalk.yellow(address)} is not valid (type mismatch):\n${JSON.stringify(abi)}`,
      );
    }

    const contractInfo = explorer.getContractInfo(
      explorer,
      abi,
      sourcesResponse,
      address,
      explorerHostname,
      explorerKey,
      chainId,
    );

    return contractInfo;
  } catch {
    const logHandler = new LogCommand(`ABI ${chalk.magenta(address)}`);
    logHandler.failure(
      `Failed to parse contract source code (${chalk.yellow(sourcesResponse.result[0].ABI)}). Maybe EOF?`,
    );
    return;
  }
}

export async function httpGetAsync<T>(url: string): Promise<T> | never {
  try {
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      throw new Error(`HTTP status code ${response.status}: ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  } catch (error) {
    throw new Error(`Failed to fetch contract source code: ${printError(error)}`);
  }
}

function _hexToDecimal(value: unknown): string | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) ? BigInt(value).toString() : undefined;
}

export async function fetchExplorerChainId(
  explorerHostname: string,
  chainId: number | string,
  explorerKey?: string,
): Promise<string | undefined> {
  if (explorerHostname.includes("sourcify")) {
    try {
      return (await fetchSourcifySupportsChain(chainId)) ? String(chainId) : undefined;
    } catch {
      return undefined;
    }
  }

  if (explorerHostname.includes("etherscan.io")) {
    let url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=proxy&action=eth_gasPrice`;
    if (explorerKey) {
      url += `&apikey=${explorerKey}`;
    }
    let response: { result?: unknown };
    try {
      response = await httpGetAsync<{ result?: unknown }>(url);
    } catch {
      return undefined;
    }
    if (_hexToDecimal(response.result) !== undefined) return String(chainId);
    if (typeof response.result === "string" && response.result.includes("Free API access is not supported")) {
      logErrorAndExit(
        `Chain ${chalk.yellow(chainId)} is not covered by the free Etherscan API plan. ` +
          `Switch ${chalk.magenta("explorerHostname")} to an explorer that serves this chain, or use a paid API key`,
      );
    }
    return undefined;
  }

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

export async function verifyChainIdWithExplorer(
  explorerHostname: string,
  chainId: string,
  explorerKey?: string,
): Promise<void> {
  const explorerChainId = await fetchExplorerChainId(explorerHostname, chainId, explorerKey);
  if (explorerChainId === undefined) {
    log(`${WARNING_MARK} ${chalk.yellow(`could not verify chainId ${chainId} against explorer ${explorerHostname}`)}`);
    return;
  }
  if (explorerChainId !== chainId) {
    logErrorAndExit(
      `The chainId ${chalk.yellow(chainId)} in the config does not match the explorer ${chalk.magenta(explorerHostname)} chain ${chalk.yellow(explorerChainId)}`,
    );
  }
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

function _parseJson(response: string): unknown {
  try {
    return JSON.parse(response);
  } catch (error) {
    logError(`Failed to parse JSON: ${printError(error)} \nResponse: ${chalk.yellow(response)}`);
  }
}
