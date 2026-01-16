import {
  IExplorerHandler,
  GetContractInfoCallback,
  RateLimitHandler,
  httpGetAsync,
  loadContractInfo,
} from "src/explorer-provider";
import { log, logError, logErrorAndExit } from "src/logger";
import {
  Abi,
  CommonResponseOkResult,
  ContractInfo,
  isCommonResponseOkResult,
  ResponseBad,
  ResponseOk,
} from "src/types";

export interface ContractCreationResult {
  txHash: string;
  deployer: string;
}

interface ContractCreationResponse {
  status: string;
  message: string;
  result: Array<{
    contractAddress: string;
    contractCreator: string;
    txHash: string;
  }>;
}

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
  chainId?: number | string,
): Promise<ContractInfo> {
  if (!isEtherResponseOkResult(response.result[0])) {
    logErrorAndExit(`It seems, explorer response has changed`);
  }

  const { ContractName, Implementation: implementationAddress } = response.result[0];

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

function buildContractCreationApiUrl(
  address: string,
  explorerHostname: string,
  explorerKey?: string,
  chainId?: number | string,
): string {
  const isEtherscan = explorerHostname.includes("etherscan.io");
  let url: string;

  if (isEtherscan) {
    const chainIdNumber = typeof chainId === "string" ? Number(chainId) : chainId;
    if (typeof chainIdNumber !== "number" || Number.isNaN(chainIdNumber)) {
      logErrorAndExit(`chainId is required for Etherscan API`);
    }
    url = `https://api.etherscan.io/v2/api?chainId=${chainIdNumber}&module=contract&action=getcontractcreation&contractaddresses=${address}`;
  } else {
    url = `https://${explorerHostname}/api?module=contract&action=getcontractcreation&contractaddresses=${address}`;
  }

  if (explorerKey) {
    url = `${url}&apikey=${explorerKey}`;
  }

  return url;
}

export async function getContractCreation(
  address: string,
  explorerHostname: string,
  explorerKey?: string,
  chainId?: number | string,
): Promise<ContractCreationResult | null> {
  const url = buildContractCreationApiUrl(address, explorerHostname, explorerKey, chainId);

  try {
    let response = await httpGetAsync<ContractCreationResponse>(url);

    // Handle rate limiting
    if (
      response.status === "0" &&
      (response.message?.includes("rate limit") || response.result?.toString().includes("rate limit"))
    ) {
      log(`  Reached rate limit, waiting ${RATE_LIMIT_TIMEOUT_MS}ms...`);
      await sleep(RATE_LIMIT_TIMEOUT_MS);
      response = await httpGetAsync<ContractCreationResponse>(url);
    }

    if (response.status !== "1" || !Array.isArray(response.result) || response.result.length === 0) {
      logError(`Failed to get contract creation info: ${response.message || "Unknown error"}`);
      return null;
    }

    const result = response.result[0];
    return {
      txHash: result.txHash,
      deployer: result.contractCreator,
    };
  } catch (error) {
    logError(`Error fetching contract creation info: ${(error as Error).message}`);
    return null;
  }
}
