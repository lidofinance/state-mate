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
  return isCommonResponseOkResult(object) && "Implementation" in object && typeof object.Implementation === "string";
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
): Promise<ContractInfo> {
  if (!isEtherResponseOkResult(response.result[0])) {
    logErrorAndExit(`It seems, explorer response has changed`);
  }

  const { ContractName, Implementation: implementationAddress } = response.result[0];

  let implementation;
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
