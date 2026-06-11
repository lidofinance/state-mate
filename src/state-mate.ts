import fs from "node:fs";
import path from "node:path";

import "dotenv/config";

import { Static, TSchema } from "@sinclair/typebox";
import Ajv, { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import chalk from "chalk";
import { JsonRpcProvider } from "ethers";
import * as YAML from "yaml";

import {
  abiExistsForAddress,
  checkAllAbi,
  flushAbiUpdates,
  renameAllAbiToLowerCase,
  resetAbiModeCache,
} from "./abi-provider";
import { doGenerateBoilerplate } from "./boilerplate-generator";
import { parseCmdLineArguments } from "./cli-parser";
import { printError, readUrlOrFromEnvironment, YAML_PARSE_OPTIONS, yamlBigintReviver } from "./common";
import { DEPLOYED_SPEC } from "./deployed-addresses";
import { loadContractInfoFromExplorer } from "./explorer-provider";
import { INPUTS_SPEC } from "./inputs";
import { FAILURE_MARK, log, logError, logErrorAndExit, logHeader1, SUCCESS_MARK, WARNING_MARK } from "./logger";
import { g_error_details, g_errors, g_total_checks } from "./section-validators/base";
import { ContractSectionValidator } from "./section-validators/contract";
import {
  configDelegatesAnchors,
  loadStateWithSiblings,
  resolveSiblingFilePath,
  SiblingSpec,
} from "./sibling-delegation";
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
  const file = path.resolve(configPath);
  try {
    const configContent = fs.readFileSync(file, "utf8");

    return YAML.parse(configContent, yamlBigintReviver, YAML_PARSE_OPTIONS);
  } catch (error) {
    logErrorAndExit(`Failed to convert the YAML file ${chalk.magenta(configPath)} to JSON:\n${printError(error)}`);
  }
}

// Load the main config, composing it with separate `.deployed` and/or `.inputs` sibling files when
// selected (an explicit `--deployed`/`--inputs` path or, by convention, the `<name>.<infix>.<ext>`
// sibling). Both may be in play at once. Sibling files are incompatible with `--generate`, which
// operates on a seed document.
type SelectedSibling = { path: string; spec: SiblingSpec; noun: string; explicit: boolean };

// Inline `config:`/`externals:` sections would bypass every `.inputs` invariant (`&label` anchors,
// the address check on externals). The schema must list those keys for composed documents, so the
// rejection lives here: they are legal only when delegated from a `.inputs` file.
function rejectInlineInputsSections(document: unknown): unknown {
  if (typeof document === "object" && document !== null) {
    const inline = INPUTS_SPEC.ownedSectionKeys.filter((key) => key in document);
    if (inline.length > 0) {
      logErrorAndExit(
        `${chalk.magenta(g_Arguments.configPath)} holds top-level ${inline.map((key) => `\`${key}:\``).join(" / ")} ` +
          `section(s) inline; they are only allowed in a \`${INPUTS_SPEC.infix}\` sibling file ` +
          `(auto-loaded when present, or selected with ${INPUTS_SPEC.optionName})`,
      );
    }
  }
  return document;
}

function loadStateWithOptionalSiblings(): unknown {
  const siblings: SelectedSibling[] = [];
  try {
    const deployedPath = resolveSiblingFilePath(g_Arguments.configPath, DEPLOYED_SPEC, g_Arguments.deployed);
    if (deployedPath) {
      siblings.push({
        path: deployedPath,
        spec: DEPLOYED_SPEC,
        noun: "deployed address(es)",
        explicit: Boolean(g_Arguments.deployed),
      });
    }
    const inputsPath = resolveSiblingFilePath(g_Arguments.configPath, INPUTS_SPEC, g_Arguments.inputs);
    if (inputsPath) {
      siblings.push({
        path: inputsPath,
        spec: INPUTS_SPEC,
        noun: "input anchor(s)",
        explicit: Boolean(g_Arguments.inputs),
      });
    }
  } catch (error) {
    logErrorAndExit(printError(error));
  }

  if (siblings.length === 0) {
    return rejectInlineInputsSections(loadStateFromYaml(g_Arguments.configPath));
  }

  if (g_Arguments.generate) {
    for (const { path: siblingPath } of siblings) {
      log(`${WARNING_MARK} Ignoring ${chalk.yellow(path.relative(process.cwd(), siblingPath))} with --generate`);
    }
    // A wiring-only main config cannot be parsed without the sibling anchors it delegates to — fail
    // with a clear message instead of the raw "Unresolved alias" parse error below.
    if (configDelegatesAnchors(g_Arguments.configPath)) {
      logErrorAndExit(
        `${chalk.magenta(g_Arguments.configPath)} delegates anchors to the sibling file(s) ignored above, ` +
          `so it cannot be parsed standalone — --generate works on self-contained (seed) configs only`,
      );
    }
    return loadStateFromYaml(g_Arguments.configPath);
  }

  // Mixing an explicit variant of one sibling with the auto-discovered convention file of the other
  // (e.g. `--deployed lido.hoodi.deployed.yaml` next to a mainnet `lido.inputs.yaml`) is easy to do
  // by accident — surface the combination.
  if (siblings.some((sibling) => sibling.explicit)) {
    for (const { path: siblingPath, spec, explicit } of siblings) {
      if (!explicit) {
        log(
          `${WARNING_MARK} ${chalk.yellow(path.relative(process.cwd(), siblingPath))} is auto-loaded by ` +
            `convention alongside an explicit sibling path — pass ${spec.optionName} if another variant is intended`,
        );
      }
    }
  }

  const { document, labels } = loadStateWithSiblings(
    g_Arguments.configPath,
    siblings.map(({ path: siblingPath, spec }) => ({ path: siblingPath, spec })),
  );
  for (const [index, { path: siblingPath, noun }] of siblings.entries()) {
    log(`Loaded ${labels[index].length} ${noun} from ${chalk.yellow(path.relative(process.cwd(), siblingPath))}`);
  }
  return siblings.some(({ spec }) => spec === INPUTS_SPEC) ? document : rejectInlineInputsSections(document);
}

function validateJsonWithSchema<T extends TSchema>(
  jsonDocument: unknown,
  schemaPrototype: T,
  { silent }: { silent: boolean } = { silent: false },
): jsonDocument is Static<T> {
  if (!silent) log(`Validating ${chalk.yellow(g_Arguments.configPath)} against schema...`);

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
  if (!silent) log(`${SUCCESS_MARK} Schema validation passed\n`);
  return true;
}

async function doChecks(jsonDocument: EntireDocument) {
  for (const [sectionTitle, section] of Object.entries(jsonDocument)) {
    if (isTypeOfTB(section, NetworkSectionTB)) await checkNetworkSection(sectionTitle, section);
  }
  // Show final summary (outside the tree)
  log(""); // Separator line
  const statusMark = g_errors ? FAILURE_MARK : SUCCESS_MARK;
  const statusMessage = g_errors
    ? `${g_total_checks} checks, ${chalk.red(`${g_errors} errors`)}`
    : `${g_total_checks} checks passed`;
  log(`${statusMark} ${chalk.bold("Total:")} ${statusMessage}`);

  if (g_Arguments.checkOnly) {
    log(`${WARNING_MARK} filtered: ${chalk.yellow(`"${g_Arguments.checkOnlyCmdArg}"`)}`);
  }

  if (g_errors) {
    // Display detailed error summary
    if (g_error_details.length > 0) {
      logHeader1("Error Summary");
      for (let index = 0; index < g_error_details.length; index++) {
        const error = g_error_details[index];
        log(
          `\n${chalk.red(`[${index + 1}/${g_error_details.length}]`)} ` +
            `${chalk.cyan("Section:")} ${chalk.yellow(error.section)} | ` +
            `${chalk.cyan("Contract:")} ${chalk.yellow(error.contract)} ` +
            `${chalk.gray(`(${error.contractAddress})`)}` +
            `\n    ${chalk.cyan("Check Type:")} ${chalk.yellow(error.checksType)} | ` +
            `${chalk.cyan("Method:")} ${chalk.yellow(error.method)}` +
            `\n    ${chalk.cyan("Error:")} ${chalk.red(error.message)}`,
        );
      }
      log(""); // Empty line at the end
    }

    process.exit(g_errors);
  }
}

async function downloadAndCheckAllAbi<T extends EntireDocument | SeedDocument>(jsonDocument: T) {
  const abiDirectoryPath = path.resolve(path.dirname(g_Arguments.configPath), "abi");
  fs.mkdirSync(abiDirectoryPath, { recursive: true });
  logHeader1("ABI checking");
  await iterateLoadedContracts(jsonDocument, checkAllAbi);
  // Flush any pending ABI updates in consolidated mode
  flushAbiUpdates();
  // Reset ABI mode cache so newly downloaded ABIs are detected in subsequent checks
  resetAbiModeCache();

  log(
    `\n💡 To consolidate individual ABI files into a single compressed file, run:\n` +
      `   ${chalk.cyan(`yarn consolidate-abi ${path.relative(process.cwd(), abiDirectoryPath)}`)}\n`,
  );
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
        // Skip explorer call if ABI already exists and we only want to update missing
        if (g_Arguments.updateAbiMissingOnly && abiExistsForAddress(address)) {
          log(`ABI ${chalk.magenta(address)} ${chalk.green("Skipped (exists)")}`);
          continue;
        }
        const contractInfo = await loadContractInfoFromExplorer(
          address,
          explorerHostname,
          explorerKey,
          // chainId is optional in schema; only relevant for etherscan v2
          (explorerSection as { chainId?: number | string }).chainId,
        );
        if (!contractInfo) {
          continue;
        }
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

  const jsonDocument = loadStateWithOptionalSiblings();

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
      if (g_Arguments.updateAbi) {
        await downloadAndCheckAllAbi(jsonDocument);
      }
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
      if (g_Arguments.updateAbi) {
        await downloadAndCheckAllAbi(jsonDocument);
      }
      await doChecks(jsonDocument);
    }
  }
}

// eslint-disable-next-line unicorn/prefer-top-level-await
main().catch((error) => {
  logError(error);
  process.exitCode = 1;
});
