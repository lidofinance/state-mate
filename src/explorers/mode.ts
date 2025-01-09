import { GetContractInfoCallback, IExplorerHandler, loadContractInfo } from "../explorer-provider";
import { logErrorAndExit } from "../logger";
import { Abi, CommonResponseOkResult, ContractInfo, isCommonResponseOkResult, ResponseOk } from "../types";

export class ModeHandler implements IExplorerHandler {
  getContractInfo: GetContractInfoCallback = modeGetContractInfoCallback;
}

type ModeResponseOkResult = CommonResponseOkResult & {
  ImplementationAddress: string;
};

function isModeResponseOkResult(obj: unknown): obj is ModeResponseOkResult {
  return (
    isCommonResponseOkResult(obj) &&
    "IsProxy" in obj &&
    (obj.IsProxy === "false" || ("ImplementationAddress" in obj && typeof obj.ImplementationAddress === "string"))
  );
}

async function modeGetContractInfoCallback(
  explorer: IExplorerHandler,
  abi: Abi,
  response: ResponseOk,
  address: string,
  explorerHostname: string,
  explorerKey?: string,
): Promise<ContractInfo> {
  if (!isModeResponseOkResult(response.result[0])) {
    logErrorAndExit(`It seems, explorer response has changed`);
  }

  const { ContractName, ImplementationAddress } = response.result[0];

  let implementation = undefined;
  if (ImplementationAddress) {
    implementation = await loadContractInfo(explorer, ImplementationAddress, explorerHostname, explorerKey);
  }

  const contractInfo: ContractInfo = {
    abi: abi,
    address: address,
    contractName: ContractName,
    implementation: implementation,
  };

  return contractInfo;
}
