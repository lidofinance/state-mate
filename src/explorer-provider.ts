import chalk from "chalk";
import { Contract, JsonRpcProvider } from "ethers";

import { printError } from "./common";
import { EtherscanHandler } from "./explorers/etherscan";
import { ModeHandler } from "./explorers/mode";
import { LogCommand, logError, logErrorAndExit, logReplaceLine } from "./logger";
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
  return loadContractInfo(
    explorerHostname.includes("mode.network") ? new ModeHandler() : new EtherscanHandler(),
    address,
    explorerHostname,
    explorerKey,
    chainId,
  );
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
    const logHandler = new LogCommand(`ABI ${chalk.magenta(`${address}`)}`);
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
