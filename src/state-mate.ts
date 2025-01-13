import fs from "node:fs";
import path from "node:path";

import "dotenv/config";

import chalk from "chalk";
import { JsonRpcProvider } from "ethers";
import * as YAML from "yaml";

import { confirm as askUserToConfirm } from "@inquirer/prompts";
import { ContractInfo } from "./types";

import Ajv, { ValidateFunction } from "ajv";
import { parseCmdLineArgs } from "./cli-parser";

import { checkAllAbiDiffs, saveAllAbi } from "./abi-provider";

import { printError, readUrlOrFromEnv } from "./common";
import { FAILURE_MARK, log, logError, logErrorAndExit, logHeader1, WARNING_MARK } from "./logger";

import { loadContractInfoFromExplorer } from "./explorer-provider";

import {
  EntireDocument,
  EntireDocumentTB,
  EthereumAddressFormat,
  EthereumRoleFormat,
  ExplorerSectionTB,
  isTypeOfTB,
  MaxIntFormat,
  NetworkSection,
  NetworkSectionTB,
  SeedDocument,
  SeedDocumentTB,
} from "./typebox";

import { Static, TObject, TSchema } from "@sinclair/typebox";

import addFormats from "ajv-formats";
import { doGenerateBoilerplate } from "./boilerplate-generator";
import { g_errors } from "./section-validators/base";
import { ContractSectionValidator } from "./section-validators/contract";

export let g_Args: ReturnType<typeof parseCmdLineArgs>;

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
  const configContent = fs.readFileSync(file, "utf-8");
  try {
    return YAML.parse(configContent, reviver, { schema: "core", intAsBigInt: true });
  } catch (error) {
    logErrorAndExit(`Failed to convert the YAML file ${chalk.magenta(configPath)} to JSON:\n${printError(error)}`);
  }
}

function validateJsonWithSchema<T extends TSchema>(
  jsonDoc: unknown,
  schemaPrototype: T,
  { silent }: { silent: boolean } = { silent: false },
): jsonDoc is Static<T> {
  if (!silent)
    logHeader1(`The YAML file at ${chalk.yellow(g_Args.configPath)} will be validated against the JSON Schema`);

  const ajv = new Ajv({ verbose: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat(
    EthereumAddressFormat.name,
    (value) => typeof value === "string" && EthereumAddressFormat.formatString.test(value),
  );
  ajv.addFormat(
    EthereumRoleFormat.name,
    (value) => typeof value === "string" && EthereumRoleFormat.formatString.test(value),
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
  const valid = validate(jsonDoc);
  if (!valid) {
    if (silent) return false;
    logErrorAndExit(
      `The YAML file ${chalk.magenta(g_Args!.configPath)} contains errors that do not comply with the JSON schema. ` +
        `Please correct them and try again\n\n${formatAjvErrors(validate.errors)} `,
    );
  }
  if (!silent)
    logHeader1(
      `The YAML file at ${chalk.yellow(g_Args.configPath)} has successfully passed validation against the JSON Schema`,
    );
  return true;
}

async function doChecks(jsonDoc: EntireDocument) {
  if (!fs.existsSync(g_Args.abiDirPath)) {
    if (await askUserToConfirm({ message: `No ABI directory found at ${g_Args.abiDirPath}.Download ? ` })) {
      await downloadAndSaveAbis(jsonDoc);
    }
  }

  for (const [sectionTitle, section] of Object.entries(jsonDoc)) {
    if (isTypeOfTB(section, NetworkSectionTB)) await checkNetworkSection(sectionTitle, section);
  }

  if (g_errors) {
    log(`\n${FAILURE_MARK} ${chalk.bold(`${g_errors} errors found!`)} `);
    process.exit(2);
  }

  if (g_Args.checkOnly) {
    log(
      `\n${WARNING_MARK}${WARNING_MARK}${WARNING_MARK} Checks run only for "${chalk.bold(chalk.blue(g_Args.checkOnlyCmdArg))}"\n`,
    );
  }
}

async function downloadAndSaveAbis(jsonDoc: SeedDocument) {
  const abiDirPath = path.resolve(path.dirname(g_Args.configPath), "abi");
  fs.mkdirSync(abiDirPath, { recursive: true });

  await iterateLoadedContracts(jsonDoc, saveAllAbi);
}

async function downloadAndCheckAbis<T extends EntireDocument | SeedDocument>(jsonDoc: T) {
  logHeader1(`ABI checking has been activated`);
  await iterateLoadedContracts(jsonDoc, checkAllAbiDiffs);
}

async function iterateLoadedContracts<T extends EntireDocument | SeedDocument>(
  jsonDoc: T,
  callback: (contractInfo: ContractInfo) => Promise<void> | void,
) {
  const abiDirPath = path.resolve(path.dirname(g_Args.configPath), "abi");
  fs.mkdirSync(abiDirPath, { recursive: true });

  for (const [explorerSectionKey, addresses] of Object.entries(jsonDoc.deployed)) {
    const explorerSection = jsonDoc[explorerSectionKey as keyof T];

    if (isTypeOfTB(explorerSection, ExplorerSectionTB) || isTypeOfTB(explorerSection, NetworkSectionTB)) {
      const { explorerHostname, explorerTokenEnv } = explorerSection;
      if (!explorerHostname) {
        logErrorAndExit(
          `The field ${chalk.magenta(explorerHostname)} is required in the ${chalk.magenta(g_Args.configPath)}`,
        );
      }
      const explorerKey = explorerTokenEnv ? process.env[explorerTokenEnv] : "";
      if (!explorerKey && explorerTokenEnv)
        console.log(`\n${WARNING_MARK} ${chalk.yellow(`The env var ${explorerTokenEnv} is not set`)}\n`);

      for (const address of addresses) {
        const contractInfo = await loadContractInfoFromExplorer(address, explorerHostname, explorerKey);
        await callback(contractInfo);
      }
    }
  }
}

async function checkNetworkSection(sectionTitle: string, section: NetworkSection) {
  if (g_Args.checkOnly && g_Args.checkOnly.section !== sectionTitle) {
    return;
  }
  const rpcUrl = readUrlOrFromEnv(section.rpcUrl);
  const provider = new JsonRpcProvider(rpcUrl);
  const contractSectionChecker = new ContractSectionValidator(provider);

  for (const contractAlias in section.contracts) {
    const contractEntry = section.contracts[contractAlias];
    await contractSectionChecker.see(contractEntry, section, sectionTitle, contractAlias);
  }
}

function generateBothSchemas() {
  const schemasPath = path.resolve(path.dirname(__dirname), path.join("schemas"));
  fs.mkdirSync(schemasPath, { recursive: true });

  const saveSchema = (fileName: string, schema: TObject) => {
    const schemasFilePath = path.resolve(schemasPath, fileName);
    try {
      fs.writeFileSync(schemasFilePath, JSON.stringify(schema, null, 2), "utf8");
      logHeader1(`The JSON Schema has been saved to ${chalk.green(schemasFilePath)}`);
    } catch (error) {
      logErrorAndExit(
        `Failed to save the JSON Schema to ${chalk.red(schemasFilePath)}:\n\n${chalk.red(printError(error))}`,
      );
    }
  };
  saveSchema("main-schema.json", EntireDocumentTB);
  saveSchema("seed-schema.json", SeedDocumentTB);
}

export async function main() {
  g_Args = parseCmdLineArgs();

  if (g_Args.schemas) {
    generateBothSchemas();
  }

  const jsonDoc = loadStateFromYaml(g_Args.configPath);

  if (g_Args.generate) {
    if (validateJsonWithSchema(jsonDoc, EntireDocumentTB, { silent: true })) {
      logErrorAndExit(chalk.yellow(`A main YAML was specified, but a seed YAML was expected: ${g_Args.configPath}`));
    }
    if (validateJsonWithSchema(jsonDoc, SeedDocumentTB)) {
      await downloadAndSaveAbis(jsonDoc);
      await doGenerateBoilerplate(g_Args.configPath, jsonDoc);
    }
  } else {
    if (validateJsonWithSchema(jsonDoc, SeedDocumentTB, { silent: true })) {
      logErrorAndExit(chalk.yellow(`A seed YAML was specified, but a main YAML was expected: ${g_Args.configPath}`));
    }
    if (validateJsonWithSchema(jsonDoc, EntireDocumentTB)) {
      if (g_Args.abi) {
        downloadAndCheckAbis(jsonDoc);
      }
      await doChecks(jsonDoc);
    }
  }
}

main().catch((error) => {
  logError(error);
  process.exitCode = 1;
});
