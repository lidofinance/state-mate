import fs from "node:fs";
import path from "node:path";

import "dotenv/config";

import { Static, TSchema } from "@sinclair/typebox";
import Ajv, { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import chalk from "chalk";
import { JsonRpcProvider } from "ethers";
import * as YAML from "yaml";

import { checkAllAbi, renameAllAbiToLowerCase } from "./abi-provider";
import { doGenerateBoilerplate } from "./boilerplate-generator";
import { parseCmdLineArguments } from "./cli-parser";
import { printError, readUrlOrFromEnvironment } from "./common";
import { loadContractInfoFromExplorer } from "./explorer-provider";
import { FAILURE_MARK, log, logError, logErrorAndExit, logHeader1, WARNING_MARK } from "./logger";
import { g_errors, g_total_checks } from "./section-validators/base";
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

export let g_Arguments: ReturnType<typeof parseCmdLineArguments>;

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: Unreachable code error
BigInt.prototype.toJSON = function (): number {
  return Number(this);
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

    return YAML.parse(configContent, reviver, { schema: "core", intAsBigInt: true });
  } catch (error) {
    logErrorAndExit(`Failed to convert the YAML file ${chalk.magenta(configPath)} to JSON:\n${printError(error)}`);
  }
}

function validateJsonWithSchema<T extends TSchema>(
  jsonDocument: unknown,
  schemaPrototype: T,
  { silent }: { silent: boolean } = { silent: false },
): jsonDocument is Static<T> {
  if (!silent)
    logHeader1(`The YAML file at ${chalk.yellow(g_Arguments.configPath)} will be validated against the JSON Schema`);

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
      `The YAML file ${chalk.magenta(g_Arguments!.configPath)} contains errors that do not comply with the JSON schema. ` +
        `Please correct them and try again\n\n${formatAjvErrors(validate.errors)} `,
    );
  }
  if (!silent)
    logHeader1(
      `The YAML file at ${chalk.yellow(g_Arguments.configPath)} has successfully passed validation against the JSON Schema`,
    );
  return true;
}

async function doChecks(jsonDocument: EntireDocument) {
  for (const [sectionTitle, section] of Object.entries(jsonDocument)) {
    if (isTypeOfTB(section, NetworkSectionTB)) await checkNetworkSection(sectionTitle, section);
  }
  log(chalk.bold(`\n${g_total_checks} checks performed.`));
  if (g_errors) {
    log(`\n${FAILURE_MARK} ${chalk.bold(`${g_errors} errors found!`)} `);
    process.exit(2);
  }

  if (g_Arguments.checkOnly) {
    log(
      `\n${WARNING_MARK}${WARNING_MARK}${WARNING_MARK} Checks run only for "${chalk.bold(chalk.blue(g_Arguments.checkOnlyCmdArg))}"\n`,
    );
  }
}

async function downloadAndCheckAllAbi<T extends EntireDocument | SeedDocument>(jsonDocument: T) {
  const abiDirectoryPath = path.resolve(path.dirname(g_Arguments.configPath), "abi");
  fs.mkdirSync(abiDirectoryPath, { recursive: true });
  logHeader1("ABI checking");
  await iterateLoadedContracts(jsonDocument, checkAllAbi);
}

async function iterateLoadedContracts<T extends EntireDocument | SeedDocument>(
  jsonDocument: T,
  callback: (contractInfo: ContractInfo) => Promise<void> | void,
) {
  const abiDirectoryPath = path.resolve(path.dirname(g_Arguments.configPath), "abi");
  fs.mkdirSync(abiDirectoryPath, { recursive: true });

  for (const [explorerSectionKey, addresses] of Object.entries(jsonDocument.deployed)) {
    const explorerSection = jsonDocument[explorerSectionKey as keyof T];

    if (isTypeOfTB(explorerSection, ExplorerSectionTB) || isTypeOfTB(explorerSection, NetworkSectionTB)) {
      const { explorerHostname, explorerTokenEnv } = explorerSection;
      if (!explorerHostname) {
        logErrorAndExit(
          `The field ${chalk.magenta(`explorerHostname`)} is required in the ${chalk.magenta(g_Arguments.configPath)}`,
        );
      }
      const explorerKey = explorerTokenEnv ? process.env[explorerTokenEnv] : "";

      if (!explorerTokenEnv) {
        log(
          `${WARNING_MARK} ${chalk.yellow("explorerTokenEnv")} is not set in the ${chalk.magenta(g_Arguments.configPath)}, the section ${chalk.magenta(explorerSectionKey)}`,
        );
      } else if (!explorerKey) {
        log(`\n${WARNING_MARK} ${chalk.yellow(`The env var ${explorerTokenEnv} is not set`)}\n`);
      }
      for (const address of addresses) {
        const contractInfo = await loadContractInfoFromExplorer(address, explorerHostname, explorerKey);
        await callback(contractInfo);
      }
    }
  }
}

async function checkNetworkSection(sectionTitle: string, section: NetworkSection) {
  if (g_Arguments.checkOnly && g_Arguments.checkOnly.section !== sectionTitle) {
    return;
  }
  const rpcUrl = readUrlOrFromEnvironment(section.rpcUrl);
  const provider = new JsonRpcProvider(rpcUrl);
  const contractSectionChecker = new ContractSectionValidator(provider);

  for (const contractAlias in section.contracts) {
    const contractEntry = section.contracts[contractAlias];
    await contractSectionChecker.see(contractEntry, sectionTitle, contractAlias);
  }
}

async function main() {
  g_Arguments = parseCmdLineArguments();

  if (g_Arguments.updateAbi) {
    renameAllAbiToLowerCase();
  }

  const jsonDocument = loadStateFromYaml(g_Arguments.configPath);

  if (g_Arguments.generate) {
    if (validateJsonWithSchema(jsonDocument, EntireDocumentTB, { silent: true })) {
      logErrorAndExit(
        chalk.yellow(
          `A main YAML was specified, but a seed YAML was expected: ${g_Arguments.configPath}\n` +
            chalk.yellow("Alternatively, the `--generate` parameter was specified for the main YAML"),
        ),
      );
    }
    if (validateJsonWithSchema(jsonDocument, SeedDocumentTB)) {
      await downloadAndCheckAllAbi(jsonDocument);
      await doGenerateBoilerplate(g_Arguments.configPath, jsonDocument);
    }
  } else {
    if (validateJsonWithSchema(jsonDocument, SeedDocumentTB, { silent: true })) {
      logErrorAndExit(
        chalk.yellow(`A seed YAML was specified, but a main YAML was expected: ${g_Arguments.configPath}\n`) +
          chalk.yellow("Alternatively, the `--generate` parameter was not specified for the seed YAML"),
      );
    }
    if (validateJsonWithSchema(jsonDocument, EntireDocumentTB)) {
      await downloadAndCheckAllAbi(jsonDocument);
      await doChecks(jsonDocument);
    }
  }
}

// eslint-disable-next-line unicorn/prefer-top-level-await
main().catch((error) => {
  logError(error);
  process.exitCode = 1;
});
