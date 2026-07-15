import fs from "node:fs";
import path from "node:path";

import "dotenv/config";

import { Static, TSchema } from "@sinclair/typebox";
import Ajv, { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import chalk from "chalk";
import { JsonRpcProvider } from "ethers";
import * as YAML from "yaml";

import { checkAllAbi, flushAbiUpdates, getAbiNameForAddress, resetAbiCache } from "./abi-provider";
import { doGenerateBoilerplate } from "./boilerplate-generator";
import { parseCommandLineArguments } from "./cli-parser";
import { normalizeChainId, printError, readUrlOrFromEnvironment } from "./common";
import { context, resetStats, stats } from "./context";
import { loadContractInfoFromExplorer, verifyChainIdWithExplorer } from "./explorer-provider";
import { FAILURE_MARK, log, logError, logErrorAndExit, logHeader1, SUCCESS_MARK, WARNING_MARK } from "./logger";
import { ContractSectionValidator } from "./section-validators/contract";
import {
  EntireDocument,
  EntireDocumentTB,
  EthereumStringFormat,
  ExplorerSectionTB,
  isTypeOfTB,
  MaxIntFormat,
  NetworkSection,
  NetworkSectionTB,
  SeedDocument,
  SeedDocumentTB,
} from "./typebox";
import { ContractInfo } from "./types";

declare global {
  interface BigInt {
    toJSON(): string;
  }
}

// eslint-disable-next-line unicorn/no-nonstandard-builtin-properties -- deliberate polyfill for JSON.stringify of bigints
BigInt.prototype.toJSON = function (): string {
  // eslint-disable-next-line unicorn/no-this-outside-of-class -- prototype method
  return this.toString();
};

function formatAjvErrors(errors: ValidateFunction["errors"]) {
  if (!errors) return `Unknown error`;

  return errors
    .map((error, index) => {
      const { message, instancePath, data, params } = error;
      return (
        `Error #${chalk.yellow(index + 1)}: ${chalk.red(instancePath)}` +
        `${data instanceof Object ? "" : chalk.red(` (${String(data)})`)} ` +
        `${chalk.red(message ?? "")}\nparams: ${JSON.stringify(params)}`
      );
    })
    .join("\n\n");
}

function loadStateFromYaml(configPath: string): unknown {
  const reviver = (_: unknown, v: unknown) => {
    return typeof v === "bigint" ? String(v) : v;
  };
  const file = path.resolve(configPath);
  try {
    const configContent = fs.readFileSync(file, "utf8");

    // maxAliasCount guards against alias-based resource exhaustion in untrusted input;
    // our configs are first-party and the large ones legitimately exceed the default budget
    return YAML.parse(configContent, reviver, { schema: "core", intAsBigInt: true, maxAliasCount: -1 });
  } catch (error) {
    logErrorAndExit(`Failed to convert the YAML file ${chalk.magenta(configPath)} to JSON:\n${printError(error)}`);
  }
}

function validateJsonWithSchema<T extends TSchema>(
  jsonDocument: unknown,
  schemaPrototype: T,
  { silent }: { silent: boolean } = { silent: false },
): jsonDocument is Static<T> {
  if (!silent) log(`Validating ${chalk.yellow(context.configPath)} against schema...`);

  const ajv = new Ajv({ verbose: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat(
    EthereumStringFormat.name,
    (value) => typeof value === "string" && EthereumStringFormat.formatString.test(value),
  );
  ajv.addFormat(MaxIntFormat.name, (value) => typeof value === "string" && MaxIntFormat.formatString.test(value));

  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(schemaPrototype);
  } catch (error) {
    if (silent) return false;
    logErrorAndExit(
      `Failed to compile schema in Ajv (Most likely, the errors are in the Typebox types):\n\n${chalk.red(printError(error))}`,
    );
  }
  const valid = validate(jsonDocument);
  if (!valid) {
    if (silent) return false;
    logErrorAndExit(
      `The YAML file ${chalk.magenta(context.configPath)} contains errors that do not comply with the JSON schema. ` +
        `Please correct them and try again\n\n${formatAjvErrors(validate.errors)} `,
    );
  }
  if (!silent) log(`${SUCCESS_MARK} Schema validation passed\n`);
  return true;
}

async function doChecks(jsonDocument: EntireDocument) {
  for (const [sectionTitle, section] of Object.entries(jsonDocument)) {
    if (isTypeOfTB(section, NetworkSectionTB)) await checkNetworkSection(sectionTitle, section);
  }
  // Show final summary (outside the tree)
  log(""); // Separator line
  const statusMark = stats.errors ? FAILURE_MARK : SUCCESS_MARK;
  const statusMessage = stats.errors
    ? `${stats.totalChecks} checks, ${chalk.red(`${stats.errors} errors`)}`
    : `${stats.totalChecks} checks passed`;
  log(`${statusMark} ${chalk.bold("Total:")} ${statusMessage}`);

  if (context.checkOnly) {
    log(`${WARNING_MARK} filtered: ${chalk.yellow(`"${context.checkOnlyCmdArg}"`)}`);
  }

  // Display detailed error summary
  if (stats.errors && stats.errorDetails.length > 0) {
    logHeader1("Error Summary");
    for (let index = 0; index < stats.errorDetails.length; index++) {
      const error = stats.errorDetails[index];
      log(
        `\n${chalk.red(`[${index + 1}/${stats.errorDetails.length}]`)} ` +
          `${chalk.cyan("Section:")} ${chalk.yellow(error.section)} | ` +
          `${chalk.cyan("Contract:")} ${chalk.yellow(error.contract)} ` +
          chalk.gray(`(${error.contractAddress})`) +
          `\n    ${chalk.cyan("Check Type:")} ${chalk.yellow(error.checksType)} | ` +
          `${chalk.cyan("Method:")} ${chalk.yellow(error.method)}` +
          `\n    ${chalk.cyan("Error:")} ${chalk.red(error.message)}`,
      );
    }
    log(""); // Empty line at the end
  }
}

export async function downloadAndCheckAllAbi<T extends EntireDocument | SeedDocument>(jsonDocument: T) {
  logHeader1("ABI checking");
  await iterateLoadedContracts(jsonDocument, checkAllAbi);
  flushAbiUpdates();
}

async function iterateLoadedContracts<T extends EntireDocument | SeedDocument>(
  jsonDocument: T,
  callback: (chainId: string, contractInfo: ContractInfo) => Promise<void> | void,
) {
  for (const [explorerSectionKey, addresses] of Object.entries(jsonDocument.deployed)) {
    const explorerSection = jsonDocument[explorerSectionKey as keyof T];

    if (isTypeOfTB(explorerSection, ExplorerSectionTB) || isTypeOfTB(explorerSection, NetworkSectionTB)) {
      const { explorerHostname, explorerTokenEnv } = explorerSection;
      if (!explorerHostname) {
        logErrorAndExit(
          `The field ${chalk.magenta(`explorerHostname`)} is required in the ${chalk.magenta(context.configPath)}`,
        );
      }
      const explorerKey = explorerTokenEnv ? process.env[explorerTokenEnv] : "";
      const chainId = normalizeChainId(explorerSection.chainId);
      await verifyChainIdWithExplorer(explorerHostname, chainId, explorerKey);

      if (!explorerTokenEnv) {
        log(
          `${WARNING_MARK} ${chalk.yellow("explorerTokenEnv")} is not set in the ${chalk.magenta(context.configPath)}, the section ${chalk.magenta(explorerSectionKey)}`,
        );
      } else if (!explorerKey) {
        log(`\n${WARNING_MARK} ${chalk.yellow(`The env var ${explorerTokenEnv} is not set`)}\n`);
      }
      for (const address of addresses) {
        const existingAbiName = getAbiNameForAddress(chainId, address);
        if (existingAbiName !== undefined) {
          log(`ABI ${chalk.magenta(`${existingAbiName} @ ${address}`)} ${chalk.green("Skipped (exists)")}`);
          continue;
        }
        const contractInfo = await loadContractInfoFromExplorer(address, explorerHostname, explorerKey, chainId);
        if (!contractInfo) {
          continue;
        }
        await callback(chainId, contractInfo);
      }
    }
  }
}

async function checkNetworkSection(sectionTitle: string, section: NetworkSection) {
  if (context.checkOnly && context.checkOnly.section !== sectionTitle) {
    return;
  }
  const rpcUrl = readUrlOrFromEnvironment(section.rpcUrl);
  // staticNetwork stops ethers from re-sending eth_chainId with every call,
  // which otherwise doubles traffic and trips rate limits on public RPCs
  const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  const chainId = normalizeChainId(section.chainId);
  if (section.explorerHostname) {
    const explorerKey = section.explorerTokenEnv ? process.env[section.explorerTokenEnv] : undefined;
    await verifyChainIdWithExplorer(section.explorerHostname, chainId, explorerKey);
  }
  const contractSectionChecker = new ContractSectionValidator(provider, chainId);

  for (const contractAlias in section.contracts) {
    const contractEntry = section.contracts[contractAlias];
    await contractSectionChecker.see(contractEntry, sectionTitle, contractAlias);
  }
}

export function collectYamlConfigs(directory: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectYamlConfigs(fullPath));
    } else if (/\.ya?ml$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files.toSorted((a, b) => a.localeCompare(b));
}

async function main() {
  Object.assign(context, parseCommandLineArguments());

  if (!fs.existsSync(context.configPath)) {
    logErrorAndExit(`No such file or directory: ${chalk.magenta(context.configPath)}`);
  }

  if (fs.statSync(context.configPath).isDirectory()) {
    if (context.generate || context.checkOnly) {
      logErrorAndExit(
        `The ${chalk.yellow("--generate")} and ${chalk.yellow("-o")} options require a single config file, not a directory`,
      );
    }
    const configs = collectYamlConfigs(context.configPath);
    if (configs.length === 0) {
      logErrorAndExit(`No YAML configs found in ${chalk.magenta(context.configPath)}`);
    }
    const failed: string[] = [];
    for (const configPath of configs) {
      context.configPath = configPath;
      resetAbiCache();
      resetStats();
      logHeader1(configPath);
      await runConfig();
      if (stats.errors) failed.push(`${configPath} (${stats.errors} errors)`);
    }
    log("");
    if (failed.length > 0) {
      logError(
        `${FAILURE_MARK} ${chalk.bold(`${failed.length}/${configs.length} configs failed:`)}\n${failed.join("\n")}`,
      );
      process.exit(1);
    }
    log(`${SUCCESS_MARK} ${chalk.bold(`All ${configs.length} configs passed`)}`);
    return;
  }

  await runConfig();
  if (stats.errors) process.exit(stats.errors);
}

async function runConfig() {
  const jsonDocument = loadStateFromYaml(context.configPath);

  if (context.generate) {
    if (validateJsonWithSchema(jsonDocument, EntireDocumentTB, { silent: true })) {
      logErrorAndExit(
        chalk.yellow(
          `A main YAML was specified, but a seed YAML was expected: ${context.configPath}\n` +
            chalk.yellow("Alternatively, the `--generate` parameter was specified for the main YAML"),
        ),
      );
    }
    if (validateJsonWithSchema(jsonDocument, SeedDocumentTB)) {
      if (context.updateAbi) {
        await downloadAndCheckAllAbi(jsonDocument);
      }
      await doGenerateBoilerplate(context.configPath, jsonDocument);
    }
  } else {
    if (validateJsonWithSchema(jsonDocument, SeedDocumentTB, { silent: true })) {
      logErrorAndExit(
        chalk.yellow(`A seed YAML was specified, but a main YAML was expected: ${context.configPath}\n`) +
          chalk.yellow("Alternatively, the `--generate` parameter was not specified for the seed YAML"),
      );
    }
    if (validateJsonWithSchema(jsonDocument, EntireDocumentTB)) {
      if (context.updateAbi) {
        await downloadAndCheckAllAbi(jsonDocument);
      }
      await doChecks(jsonDocument);
    }
  }
}

// Do not run when imported (e.g. by unit tests) — only as the CLI entrypoint
if (require.main === module) {
  main().catch((error) => {
    logError(error);
    process.exitCode = 1;
  });
}
