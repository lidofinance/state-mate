import chalk from "chalk";
import { Contract, JsonRpcProvider } from "ethers";

import { printError } from "./common";
import { EtherscanHandler } from "./explorers/etherscan";
import { ModeHandler } from "./explorers/mode";
import { logError, logErrorAndExit, logReplaceLine } from "./logger";
import {
  Abi,
  ContractInfo,
  isCommonResponseOkResult,
  isResponseBad,
  isResponseOk,
  isValidAbi,
  MethodCallResults,
  ResponseBad,
  ResponseOk,
  AbiArgumentsLength,
} from "./types";

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

export async function safeStaticCall(
  contract: Contract,
  functionName: string,
  ...arguments_: unknown[]
): Promise<unknown> {
  try {
    const contractFunction = contract.getFunction(functionName);

    const result = await contractFunction.staticCall(...arguments_);

    return result;
  } catch (error) {
    logErrorAndExit(
      `Failed to call function ${chalk.yellow(functionName)} with args:\n ${chalk.yellow(JSON.stringify(arguments_))}:\n ${printError(error)}`,
    );
  }
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
): Promise<ContractInfo> {
  return loadContractInfo(
    explorerHostname.includes("mode.network") ? new ModeHandler() : new EtherscanHandler(),
    address,
    explorerHostname,
    explorerKey,
  );
}

export async function loadContractInfo(
  explorer: IExplorerHandler,
  address: string,
  explorerHostname: string,
  explorerKey?: string,
) {
  const sourcesUrl = _getExplorerApiUrl(explorerHostname, address, explorerKey);

  let sourcesResponse = await httpGetAsync(sourcesUrl);
  if (isResponseBad(sourcesResponse) && explorer.requestWithRateLimit) {
    sourcesResponse = await explorer.requestWithRateLimit(sourcesResponse, sourcesUrl, explorerHostname);
    if (isResponseBad(sourcesResponse)) {
      logErrorAndExit(
        `Failed to download contract info from ${explorerHostname}: ${sourcesResponse.message}\n${JSON.stringify(sourcesResponse, undefined, 2)}`,
      );
    }
  }

  if (!isResponseOk(sourcesResponse)) {
    logErrorAndExit(`Received unexpected response from explorer:\n${JSON.stringify(sourcesResponse)}`);
  }

  if (!isCommonResponseOkResult(sourcesResponse.result[0])) {
    logErrorAndExit(`It seems, explorer response has changed:\n${JSON.stringify(sourcesResponse)}`);
  }

  const abi: unknown = _parseJson(sourcesResponse.result[0].ABI);

  if (!isValidAbi(abi)) {
    logErrorAndExit(`ABI for contract ${chalk.yellow(address)} is not valid (type mismatch):\n${JSON.stringify(abi)}`);
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
    throw new Error(`Failed to fetch contract source code: ${printError(error)}`);
  }
}

function _getExplorerApiUrl(explorerHostname: string, address: string, explorerKey?: string) {
  let url = `https://${explorerHostname}/api?module=contract&action=getsourcecode&address=${address}`;
  if (explorerKey) {
    url = `${url}&apikey=${explorerKey}`;
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