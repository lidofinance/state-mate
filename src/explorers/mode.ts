import { GetContractInfoCallback, IExplorerHandler } from "src/explorer-provider";
import { blockscoutGetContractInfoCallback } from "src/explorers/blockscout";
import { logErrorAndExit } from "src/logger";
import { Abi, CommonResponseOkResult, isCommonResponseOkResult, ResponseOk } from "src/types";

export class ModeHandler implements IExplorerHandler {
  getContractInfo: GetContractInfoCallback = modeGetContractInfoCallback;
}

type ModeResponseOkResult = CommonResponseOkResult & {
  IsProxy: string;
  ImplementationAddress?: string;
};

function isModeResponseOkResult(object: unknown): object is ModeResponseOkResult {
  return (
    isCommonResponseOkResult(object) &&
    "IsProxy" in object &&
    typeof object.IsProxy === "string" &&
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
  chainId?: number | string,
) {
  // Mode is a special case of Blockscout that requires IsProxy to be present
  if (!isModeResponseOkResult(response.result[0])) {
    logErrorAndExit(`It seems, explorer response has changed:\n${JSON.stringify(response, null, 2)}`);
  }

  // Use Blockscout's implementation
  return blockscoutGetContractInfoCallback(explorer, abi, response, address, explorerHostname, explorerKey, chainId);
}
