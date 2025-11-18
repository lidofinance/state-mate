import {
  IExplorerHandler,
  GetContractInfoCallback,
  RateLimitHandler,
  httpGetAsync,
  loadContractInfo,
} from "src/explorer-provider";
import { log, logErrorAndExit } from "src/logger";
import {
  Abi,
  CommonResponseOkResult,
  ContractInfo,
  isCommonResponseOkResult,
  ResponseBad,
  ResponseOk,
} from "src/types";

export class EtherscanHandler implements IExplorerHandler {
  requestWithRateLimit: RateLimitHandler = etherRateLimitHandler;
  getContractInfo: GetContractInfoCallback = etherGetContractInfoCallback;
}

const RATE_LIMIT_TIMEOUT_MS = 6 * 1000; // 5 seconds is not enough for BscScan free tier

async function sleep(timeoutMs: number) {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function isEtherResponseOkResult(object: unknown): object is EtherResponseOkResult {
  if (!isCommonResponseOkResult(object)) {
    return false;
  }

  const result = object as Partial<EtherResponseOkResult>;

  if (result.Implementation !== undefined && typeof result.Implementation !== "string") {
    return false;
  }

  if (result.ImplementationAddress !== undefined && typeof result.ImplementationAddress !== "string") {
    return false;
  }

  if (
    result.ImplementationAddresses !== undefined &&
    (!Array.isArray(result.ImplementationAddresses) ||
      result.ImplementationAddresses.some((entry) => typeof entry !== "string"))
  ) {
    return false;
  }

  if (result.IsProxy !== undefined && typeof result.IsProxy !== "string") {
    return false;
  }

  if (result.IsProxy === "true") {
    return Boolean(
      result.Implementation ||
        result.ImplementationAddress ||
        (result.ImplementationAddresses && result.ImplementationAddresses.length > 0),
    );
  }

  return true;
}

type EtherResponseOkResult = CommonResponseOkResult & {
  Implementation?: string;
  ImplementationAddress?: string;
  ImplementationAddresses?: string[];
  IsProxy?: string;
};

function getImplementationAddress(result: EtherResponseOkResult) {
  return result.Implementation ?? result.ImplementationAddress ?? result.ImplementationAddresses?.[0];
}

async function etherRateLimitHandler(
  sourcesResponse: ResponseBad,
  sourcesUrl: string,
  explorerHostname: string,
): Promise<unknown> {
  const isRateLimit = sourcesResponse.result.includes("rate limit") || sourcesResponse.message.includes("rate limit");

  if (isRateLimit) {
    log(`Reached rate limit ${explorerHostname}, waiting for ${RATE_LIMIT_TIMEOUT_MS} ms...`);
    await sleep(RATE_LIMIT_TIMEOUT_MS);
    return httpGetAsync(sourcesUrl);
  }

  return sourcesResponse;
}

async function etherGetContractInfoCallback(
  explorer: IExplorerHandler,
  abi: Abi,
  response: ResponseOk,
  address: string,
  explorerHostname: string,
  explorerKey?: string,
  chainId?: number | string,
): Promise<ContractInfo> {
  if (!isEtherResponseOkResult(response.result[0])) {
    logErrorAndExit(`It seems, Etherscan response has changed`);
  }

  const { ContractName } = response.result[0];
  const implementationAddress = getImplementationAddress(response.result[0]);

  let implementation;
  if (implementationAddress) {
    implementation = await loadContractInfo(explorer, implementationAddress, explorerHostname, explorerKey, chainId);
  }

  const contractInfo: ContractInfo = {
    abi: abi,
    address: address,
    contractName: ContractName,
    implementation: implementation,
  };

  return contractInfo;
}
