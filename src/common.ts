import chalk from "chalk";
import type * as YAML from "yaml";

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

/**
 * What the node said, without the request ethers quotes beside it: a request id of 429 in the
 * full message would read as a rate limit.
 */
export function nodeAnswer(error: unknown): { code?: unknown; message: string; status?: string } {
  const {
    error: coalesced,
    info,
    shortMessage,
  } = error as {
    error?: { code?: unknown; message?: unknown };
    info?: { error?: { code?: unknown; message?: unknown }; responseBody?: unknown; responseStatus?: unknown };
    shortMessage?: unknown;
  };
  // ethers keeps the JSON-RPC error of an eth_call in info.error, of any other method in error
  const rpcError = coalesced ?? info?.error;
  const status = typeof info?.responseStatus === "string" ? info.responseStatus : undefined;
  // a JSON-RPC error over HTTP 200
  if (typeof rpcError?.message === "string") return { code: rpcError.code, message: rpcError.message, status };
  // an HTTP error, whose body may still carry the JSON-RPC error
  if (typeof info?.responseBody === "string") {
    try {
      const body = JSON.parse(info.responseBody) as { error?: { code?: unknown; message?: unknown } };
      if (typeof body.error?.message === "string")
        return { code: body.error.code, message: body.error.message, status };
    } catch {
      // the body is plain text
    }
    return { message: info.responseBody, status };
  }
  return { message: typeof shortMessage === "string" ? shortMessage : printError(error), status };
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
