import { GetContractInfoCallback, IExplorerHandler, loadContractInfo } from "src/explorer-provider";
import { logErrorAndExit } from "src/logger";
import { Abi, CommonResponseOkResult, ContractInfo, isCommonResponseOkResult, ResponseOk } from "src/types";

export class ModeHandler implements IExplorerHandler {
  getContractInfo: GetContractInfoCallback = modeGetContractInfoCallback;
}

type ModeResponseOkResult = CommonResponseOkResult & {
  ImplementationAddress: string;
};

function isModeResponseOkResult(object: unknown): object is ModeResponseOkResult {
  return (
    isCommonResponseOkResult(object) &&
    "IsProxy" in object &&
    (object.IsProxy === "false" ||
      ("ImplementationAddress" in object && typeof object.ImplementationAddress === "string"))
  );
}

async function modeGetContractInfoCallback(
  explorer: IExplorerHandler,
  abi: Abi,
  response: ResponseOk,
  address: string,
  explorerHostname: string,
  explorerKey?: string,
  _chainId?: number | string,
): Promise<ContractInfo> {
  if (!isModeResponseOkResult(response.result[0])) {
    logErrorAndExit(`It seems, explorer response has changed`);
  }

  const { ContractName, ImplementationAddress } = response.result[0];

  let implementation;
  if (ImplementationAddress) {
    implementation = await loadContractInfo(explorer, ImplementationAddress, explorerHostname, explorerKey, _chainId);
  }

  const contractInfo: ContractInfo = {
    abi: abi,
    address: address,
    contractName: ContractName,
    implementation: implementation,
  };

  return contractInfo;
}
