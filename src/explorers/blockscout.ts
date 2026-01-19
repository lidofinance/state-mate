import { GetContractInfoCallback, IExplorerHandler, loadContractInfo } from "src/explorer-provider";
import { logErrorAndExit } from "src/logger";
import { Abi, CommonResponseOkResult, ContractInfo, isCommonResponseOkResult, ResponseOk } from "src/types";

export class BlockscoutHandler implements IExplorerHandler {
  getContractInfo: GetContractInfoCallback = blockscoutGetContractInfoCallback;
}

type BlockscoutResponseOkResult = CommonResponseOkResult & {
  IsProxy?: string;
  ImplementationAddress?: string;
};

function isBlockscoutResponseOkResult(object: unknown): object is BlockscoutResponseOkResult {
  if (!isCommonResponseOkResult(object)) {
    return false;
  }
  const object_ = object as Record<string, unknown>;
  // IsProxy must be a string if present
  if ("IsProxy" in object_ && typeof object_.IsProxy !== "string") {
    return false;
  }
  // If ImplementationAddress is present, validate it
  if ("ImplementationAddress" in object_) {
    // Either IsProxy is "false" (not a proxy) or ImplementationAddress must be a string
    const isProxy = object_.IsProxy;
    if (isProxy === "false") {
      return true; // Not a proxy, ImplementationAddress can be anything or empty
    }
    return typeof object_.ImplementationAddress === "string";
  }
  return true;
}

export async function blockscoutGetContractInfoCallback(
  explorer: IExplorerHandler,
  abi: Abi,
  response: ResponseOk,
  address: string,
  explorerHostname: string,
  explorerKey?: string,
  chainId?: number | string,
): Promise<ContractInfo> {
  if (!isBlockscoutResponseOkResult(response.result[0])) {
    logErrorAndExit(`It seems, explorer response has changed:\n${JSON.stringify(response, null, 2)}`);
  }

  const { ContractName, ImplementationAddress } = response.result[0];

  let implementation;
  if (ImplementationAddress) {
    implementation = await loadContractInfo(explorer, ImplementationAddress, explorerHostname, explorerKey, chainId);
  }

  const contractInfo: ContractInfo = {
    abi: abi,
    address: address,
    contractName: ContractName,
    implementation: implementation,
  };

  return contractInfo;
}
