import { getAddress } from "ethers";

import { printError } from "src/common";
import { httpGetAsync } from "src/explorer-provider";
import { logErrorAndExit } from "src/logger";
import { ContractInfo, isValidAbi } from "src/types";

type SourcifyContract = {
  abi?: unknown;
  compilation?: { name?: string };
  proxyResolution?: { isProxy: boolean; implementations: { address: string }[] };
};

const SOURCIFY_API = "https://sourcify.dev/server";

export async function loadContractInfoFromSourcify(
  address: string,
  chainId: number | string,
): Promise<ContractInfo | undefined> {
  const url = `${SOURCIFY_API}/v2/contract/${chainId}/${getAddress(address.toLowerCase())}?fields=abi,compilation,proxyResolution`;
  let response: SourcifyContract;
  try {
    response = await httpGetAsync<SourcifyContract>(url);
  } catch (error) {
    logErrorAndExit(
      `Failed to fetch contract ${address} (chain ${chainId}) from Sourcify — the contract may not be verified there: ${printError(error)}`,
    );
  }

  if (!isValidAbi(response.abi) || !response.compilation?.name) {
    logErrorAndExit(`Sourcify returned no usable ABI for ${address} (chain ${chainId})`);
  }

  const implementationAddress = response.proxyResolution?.isProxy
    ? response.proxyResolution.implementations[0]?.address
    : undefined;
  const implementation = implementationAddress
    ? await loadContractInfoFromSourcify(implementationAddress, chainId)
    : undefined;

  return {
    contractName: response.compilation.name,
    abi: response.abi,
    address,
    implementation,
  };
}

export async function fetchSourcifySupportsChain(chainId: number | string): Promise<boolean> {
  const chains = await httpGetAsync<{ chainId: number }[]>(`${SOURCIFY_API}/chains`);
  return chains.some((chain) => String(chain.chainId) === String(chainId));
}
