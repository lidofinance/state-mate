import chalk from "chalk";

import { logErrorAndExit } from "./logger";
import { Abi, AbiArgumentsLength as AbiArgumentsLength } from "./types";

// Contract entry fields
export enum EntryField {
  name = "name",
  address = "address",
  checks = "checks",
  storage = "storage",
  proxyChecks = "proxyChecks",
  implementationChecks = "implementationChecks",
  ozNonEnumerableAcl = "ozNonEnumerableAcl",
  ozAcl = "ozAcl",
  result = "result",
  contracts = "contracts",
  explorerHostname = "explorerHostname",
  explorerTokenEnvironment = "explorerTokenEnv",
  rpcUrl = "rpcUrl",
}

export function printError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readUrlOrFromEnvironment(urlOrEnvironmentVariableName: string) {
  if (isUrl(urlOrEnvironmentVariableName)) {
    return urlOrEnvironmentVariableName;
  }
  const valueFromEnvironment = process.env[urlOrEnvironmentVariableName];
  if (!valueFromEnvironment) {
    logErrorAndExit(`Env var ${chalk.yellow(urlOrEnvironmentVariableName)} is not set`);
  }
  if (!isUrl(valueFromEnvironment)) {
    logErrorAndExit(
      `Env var ${chalk.yellow(urlOrEnvironmentVariableName)} is not a valid RPC url: ${chalk.yellow(valueFromEnvironment)}`,
    );
  }
  return valueFromEnvironment;
}

export function getNonMutables(abi: Abi): AbiArgumentsLength {
  return abi
    .filter(
      ({ type, stateMutability }) =>
        type === "function" && stateMutability !== "payable" && stateMutability !== "nonpayable",
    )
    .map(({ name, inputs }) => ({
      name: name ?? "",
      numArgs: Array.isArray(inputs) ? inputs.length : 0,
    }));
}

function isUrl(maybeUrl: string) {
  try {
    new URL(maybeUrl);
    return true;
  } catch {
    return false;
  }
}
