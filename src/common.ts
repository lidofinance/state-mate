import chalk from "chalk";
import * as YAML from "yaml";

import { logErrorAndExit } from "./logger";
import { Abi, AbiArgumentsLength as AbiArgumentsLength } from "./types";

// Shared YAML parsing semantics. Every loader (the flat parse in state-mate.ts and the
// deployed-addresses composition) MUST use these so a deployed-composed config is indistinguishable
// from a standalone one. Keep the two in sync by importing rather than re-declaring.
export const YAML_PARSE_OPTIONS: YAML.ParseOptions & YAML.DocumentOptions & YAML.SchemaOptions = {
  schema: "core",
  intAsBigInt: true,
};
export const yamlBigintReviver = (_: unknown, value: unknown) => (typeof value === "bigint" ? String(value) : value);

/**
 * The scalar items under `deployed.<sectionKey>` (in document order), or `[]` when that section is
 * absent or is not a list of scalars. Shared by the seed generator and the deployed-addresses
 * composer, which both walk the `deployed:` anchor book.
 */
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
