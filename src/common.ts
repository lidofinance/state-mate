import chalk from "chalk";
import * as YAML from "yaml";

import { registerSecret } from "./context";
import { logErrorAndExit } from "./logger";
import type { Abi, AbiArgumentsLength, ChainId } from "./types";

// Keep scalar parsing consistent between standalone and sibling-composed configs.
export const YAML_PARSE_OPTIONS: YAML.ParseOptions & YAML.DocumentOptions & YAML.SchemaOptions = {
  schema: "core",
  intAsBigInt: true,
};
export const yamlBigintReviver = (_: unknown, value: unknown) => (typeof value === "bigint" ? String(value) : value);
// Alias expansion happens at toJS time. Trusted first-party configs exceed the default budget of 100.
export const YAML_TO_JS_OPTIONS: YAML.ToJSOptions = { reviver: yamlBigintReviver, maxAliasCount: -1 };

/** Return deployed section scalars in document order, or an empty array for absent/non-scalar sections. */
export function getDeployedSectionScalars(document: YAML.Document, sectionKey: string): YAML.Scalar[] {
  const section = document.getIn(["deployed", sectionKey]);
  if (YAML.isSeq(section) && section.items.every((element) => YAML.isScalar(element))) {
    return section.items as YAML.Scalar[];
  }
  return [];
}

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
  aragonAcl = "aragonAcl",
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
    registerSecret(urlOrEnvironmentVariableName, "<rpcUrl>");
    return urlOrEnvironmentVariableName;
  }
  const valueFromEnvironment = process.env[urlOrEnvironmentVariableName];
  if (!valueFromEnvironment) {
    logErrorAndExit(`Env var ${chalk.yellow(urlOrEnvironmentVariableName)} is not set`);
  }
  registerSecret(valueFromEnvironment, `$${urlOrEnvironmentVariableName}`);
  if (!isUrl(valueFromEnvironment)) {
    logErrorAndExit(
      `Env var ${chalk.yellow(urlOrEnvironmentVariableName)} is not a valid RPC url: ${chalk.yellow(valueFromEnvironment)}`,
    );
  }
  return valueFromEnvironment;
}

export function normalizeChainId(chainId: ChainId): string {
  // BigInt would happily coerce whitespace to 0 or accept a negative; zero is no chain either
  if (!/^\d+$/.test(String(chainId)) || BigInt(chainId) === 0n) {
    logErrorAndExit(`Invalid chain ID: ${chalk.yellow(String(chainId))}`);
  }
  return BigInt(chainId).toString();
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
  return URL.canParse(maybeUrl);
}
