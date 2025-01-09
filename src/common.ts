import chalk from "chalk";
import { logErrorAndExit } from "./logger";
import { g_Args } from "./state-mate";
import { Abi, AbiArgsLength } from "./types";

export enum Ef {
  name = "name",
  address = "address",
  checks = "checks",
  proxyChecks = "proxyChecks",
  implementationChecks = "implementationChecks",
  ozNonEnumerableAcl = "ozNonEnumerableAcl",
  result = "result",
  contracts = "contracts",
  explorerHostname = "explorerHostname",
  explorerTokenEnv = "explorerTokenEnv",
  rpcUrl = "rpcUrl",
}

export enum CheckLevel {
  section = "section",
  contract = "contract",
  checksType = "checksType",
  method = "method",
}

function isUrl(maybeUrl: string) {
  try {
    new URL(maybeUrl);
    return true;
  } catch (_) {
    return false;
  }
}

export function printError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function needCheck(level: CheckLevel, name: string) {
  if (g_Args.checkOnly === null) {
    return true;
  }
  const checkOnTheLevel = g_Args.checkOnly[level];
  return checkOnTheLevel === null || checkOnTheLevel === undefined || name === checkOnTheLevel;
}

export function readUrlOrFromEnv(urlOrEnvVarName: string) {
  if (isUrl(urlOrEnvVarName)) {
    return urlOrEnvVarName;
  }
  const valueFromEnv = process.env[urlOrEnvVarName];
  if (!valueFromEnv) {
    logErrorAndExit(`Env var ${chalk.yellow(urlOrEnvVarName)} must be set`);
  }
  if (!isUrl(valueFromEnv)) {
    logErrorAndExit(`Env var ${chalk.yellow(urlOrEnvVarName)} is not a valid RPC url: ${chalk.yellow(valueFromEnv)}`);
  }
  return valueFromEnv;
}

export function getNonMutables(abi: Abi): AbiArgsLength {
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
