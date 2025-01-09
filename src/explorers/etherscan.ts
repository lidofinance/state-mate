import {
  IExplorerHandler,
  GetContractInfoCallback,
  RateLimitHandler,
  httpGetAsync,
  loadContractInfo,
} from "../explorer-provider";
import { log, logErrorAndExit } from "../logger";
import { Abi, CommonResponseOkResult, ContractInfo, isCommonResponseOkResult, ResponseBad, ResponseOk } from "../types";

export class EtherscanHandler implements IExplorerHandler {
  requestWithRateLimit: RateLimitHandler = etherRateLimitHandler;
  getContractInfo: GetContractInfoCallback = etherGetContractInfoCallback;
}

const RATE_LIMIT_TIMEOUT = 6 * 1000; // 5 seconds is not enough for BscScan free tier

async function sleep(timeoutMs: number) {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function isEtherResponseOkResult(obj: unknown): obj is EtherResponseOkResult {
  return isCommonResponseOkResult(obj) && "Implementation" in obj && typeof obj.Implementation === "string";
}

type EtherResponseOkResult = CommonResponseOkResult & {
  Implementation: string;
};

async function etherRateLimitHandler(
  sourcesResponse: ResponseBad,
  sourcesUrl: string,
  explorerHostname: string,
): Promise<unknown> {
  const isRateLimit = sourcesResponse.result.includes("rate limit") || sourcesResponse.message.includes("rate limit");

  if (isRateLimit) {
    log(`Reached rate limit ${explorerHostname}, waiting for ${RATE_LIMIT_TIMEOUT} seconds...`);
    await sleep(RATE_LIMIT_TIMEOUT);
    return httpGetAsync(sourcesUrl);
  }

  return undefined;
}

async function etherGetContractInfoCallback(
  explorer: IExplorerHandler,
  abi: Abi,
  response: ResponseOk,
  address: string,
  explorerHostname: string,
  explorerKey?: string,
): Promise<ContractInfo> {
  if (!isEtherResponseOkResult(response.result[0])) {
    logErrorAndExit(`It seems, explorer response has changed`);
  }

  const { ContractName, Implementation: implementationAddress } = response.result[0];

  let implementation = undefined;
  if (implementationAddress) {
    implementation = await loadContractInfo(explorer, implementationAddress, explorerHostname, explorerKey);
  }

  const contractInfo: ContractInfo = {
    abi: abi,
    address: address,
    contractName: ContractName,
    implementation: implementation,
  };

  return contractInfo;
}
