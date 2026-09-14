import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEPLOYED_SPEC } from "../src/deployed-addresses";
import { INPUTS_SPEC } from "../src/inputs";
import { composeWithSiblings } from "../src/sibling-delegation";
export const composeWithDeployedAddresses = (mainText: string, deployedText: string) => {
  const { document, labels } = composeWithSiblings(mainText, [{ text: deployedText, spec: DEPLOYED_SPEC }]);
  return { document, labels: labels[0] };
};

export const composeWithInputs = (mainText: string, inputsText: string) => {
  const { document, labels } = composeWithSiblings(mainText, [{ text: inputsText, spec: INPUTS_SPEC }]);
  return { document, labels: labels[0] };
};

export const toCrlf = (text: string) => text.replaceAll("\n", "\r\n");

export function withTemporaryDirectory<T>(prefix: string, function_: (directory: string) => T): T {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return function_(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Include a main-file anchor alongside delegated inputs to exercise both alias sources.
export const INPUTS_MAIN_CONFIG = `
misc:
  - &ZERO "0x0000000000000000000000000000000000000000"
l1:
  rpcUrl: MAIN_RPC_URL
  chainId: *chainId
  contracts:
    fooContract:
      name: Foo
      address: *ZERO
      checks:
        name: *lidoName
        limits: *oracleReportLimits
        deposit: *depositContract
`;
export const INPUTS = `
config:
  - &lidoName "Liquid staked Ether 2.0"
  - &oracleReportLimits [3600, 1800, 1000, 50]
externals:
  - &depositContract "0x00000000219ab540356cBB839Cbe05303d7705Fa"
  - &chainId 560048
`;
