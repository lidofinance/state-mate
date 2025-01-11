import { logErrorAndExit, logReplaceLine } from "./logger";

import {
  ContractInfo,
  isResponseOk,
  isResponseBad,
  MethodCallResults,
  ResponseBad,
  ResponseOk,
  isCommonResponseOkResult,
  isValidAbi,
  Abi,
} from "./types";

import { Contract, JsonRpcProvider } from "ethers";
import { AbiArgsLength } from "./types";

import { EtherscanHandler } from "./explorers/etherscan";
import { ModeHandler } from "./explorers/mode";

export function loadContract(address: string, abi: Abi, provider: JsonRpcProvider) {
  return new Contract(address, abi as unknown as string, provider);
}

export interface IExplorerHandler {
  requestWithRateLimit?: RateLimitHandler;
  getContractInfo: GetContractInfoCallback;
}
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
) => Promise<ContractInfo>;

export async function collectStaticCallResults(
  nonMutables: AbiArgsLength,
  contract: Contract,
): Promise<MethodCallResults> {
  const results: MethodCallResults = [];

  for (const { name: methodName, numArgs } of nonMutables) {
    const viewFunction = contract.getFunction(methodName);
    let staticCallResult: string;
    logReplaceLine(`${methodName}...`);
    if (numArgs === 0) {
      try {
        const result: unknown = await viewFunction.staticCall();
        staticCallResult = String(result);
      } catch (error) {
        staticCallResult = "View call reverted";
      }
    } else {
      staticCallResult = "Need to specify args";
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
): Promise<ContractInfo> {
  if (explorerHostname.indexOf("mode.network") > -1) {
    return loadContractInfo(new ModeHandler(), address, explorerHostname, explorerKey);
  } else {
    // At least same for: api.etherscan.io, api.bscscan.com
    return loadContractInfo(new EtherscanHandler(), address, explorerHostname, explorerKey);
  }
}

function parseJson(response: string): unknown {
  try {
    return JSON.parse(response);
  } catch (error) {
    logErrorAndExit(`Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadContractInfo(
  explorer: IExplorerHandler,
  address: string,
  explorerHostname: string,
  explorerKey?: string,
) {
  const sourcesUrl = getExplorerApiUrl(explorerHostname, address, explorerKey);

  let sourcesResponse = await httpGetAsync(sourcesUrl);
  if (isResponseBad(sourcesResponse) && explorer.requestWithRateLimit) {
    sourcesResponse = await explorer.requestWithRateLimit(sourcesResponse, sourcesUrl, explorerHostname);
    if (isResponseBad(sourcesResponse)) {
      logErrorAndExit(
        `Failed to download contract info from ${explorerHostname}: ${sourcesResponse.message}\n${JSON.stringify(sourcesResponse, null, 2)}`,
      );
    }
  }

  if (!isResponseOk(sourcesResponse)) {
    logErrorAndExit(`Received unexpected response from explorer:\n${JSON.stringify(sourcesResponse)}`);
  }

  if (!isCommonResponseOkResult(sourcesResponse.result[0])) {
    logErrorAndExit(`It seems, explorer response has changed:\n${JSON.stringify(sourcesResponse)}`);
  }

  const abi: unknown = parseJson(sourcesResponse.result[0].ABI);

  if (!isValidAbi(abi)) {
    logErrorAndExit(`ABI for contract ${address} is not valid (type mismatch):\n${JSON.stringify(abi)}`);
  }

  const contractInfo = explorer.getContractInfo(explorer, abi, sourcesResponse, address, explorerHostname, explorerKey);

  return contractInfo;
}

export async function httpGetAsync<T>(url: string): Promise<T> | never {
  try {
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      throw new Error(`HTTP status code ${response.status}: ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  } catch (error) {
    throw new Error(`Failed to fetch contract source code: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function getExplorerApiUrl(explorerHostname: string, address: string, explorerKey?: string) {
  let url = `https://${explorerHostname}/api?module=contract&action=getsourcecode&address=${address}`;
  if (explorerKey) {
    url = `${url}&apikey=${explorerKey}`;
  }
  return url;
}
