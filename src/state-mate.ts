import fs from "node:fs";
import path from "node:path";

import "dotenv/config";

import type { Static, TSchema } from "@sinclair/typebox";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import chalk from "chalk";
import * as YAML from "yaml";

import {
  checkAllAbi,
  flushAbiUpdates,
  getAbiNameForAddress,
  keepStoredAbi,
  pruneAbiStores,
  resetAbiCache,
  wasFetchedThisRun,
} from "./abi-provider";
import { parseCommandLineArguments } from "./cli-parser";
import {
  normalizeChainId,
  printError,
  readUrlOrFromEnvironment,
  YAML_PARSE_OPTIONS,
  YAML_TO_JS_OPTIONS,
} from "./common";
import { context, registerSecret, resetStats, stats } from "./context";
import { DEPLOYED_SPEC } from "./deployed-addresses";
import {
  assertProviderChain,
  createProvider,
  explorerNeedsApiKey,
  loadContractInfo,
  verifyChainIdWithExplorer,
} from "./explorer";
import { INPUTS_SPEC } from "./inputs";
import {
  FAILURE_MARK,
  FatalError,
  log,
  logError,
  logErrorAndExit,
  logHeader1,
  SUCCESS_MARK,
  WARNING_MARK,
} from "./logger";
import { beginConfig, emitReport, endConfig } from "./report";
import { ContractSectionValidator } from "./section-validators/contract";
import {
  configDelegatesAnchors,
  loadStateWithSiblings,
  resolveSiblingFilePath,
  type SiblingSpec,
} from "./sibling-delegation";
import {
  type EntireDocument,
  EntireDocumentTB,
  EthereumStringFormat,
  ExplorerSectionTB,
  isTypeOfTB,
  MaxIntFormat,
  type NetworkSection,
  NetworkSectionTB,
} from "./typebox";
import type { ContractInfo } from "./types";

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
  const file = path.resolve(configPath);
  try {
    const configContent = fs.readFileSync(file, "utf8");

    return YAML.parse(configContent, { ...YAML_PARSE_OPTIONS, ...YAML_TO_JS_OPTIONS });
  } catch (error) {
    logErrorAndExit(`Failed to convert the YAML file ${chalk.magenta(configPath)} to JSON:\n${printError(error)}`);
  }
}

// Load the main config, composing it with separate `.deployed` and/or `.inputs` sibling files when
// `--deployed`/`--inputs` names them — they are never loaded automatically. Both may be in play at
// once.
type SelectedSibling = { path: string; spec: SiblingSpec; noun: string };

// Inline `config:`/`externals:` sections would bypass every `.inputs` invariant (`&label` anchors,
// the address check on externals). The schema must list those keys for composed documents, so the
// rejection lives here: they are legal only when delegated from a `.inputs` file.
function rejectInlineInputsSections(document: unknown): unknown {
  if (typeof document === "object" && document !== null) {
    const inline = INPUTS_SPEC.ownedSectionKeys.filter((key) => Object.hasOwn(document, key));
    if (inline.length > 0) {
      logErrorAndExit(
        `${chalk.magenta(context.configPath)} holds top-level ${inline.map((key) => `\`${key}:\``).join(" / ")} ` +
          `section(s) inline; they are only allowed in ${INPUTS_SPEC.fileLabel}, ` +
          `selected with \`${INPUTS_SPEC.optionName} <path>\``,
      );
    }
  }
  return document;
}

function loadStateWithOptionalSiblings(): unknown {
  const siblings: SelectedSibling[] = [];
  const siblingKinds: { spec: SiblingSpec; argument: string | undefined; noun: string }[] = [
    { spec: DEPLOYED_SPEC, argument: context.deployed, noun: "deployed address(es)" },
    { spec: INPUTS_SPEC, argument: context.inputs, noun: "input anchor(s)" },
  ];
  try {
    for (const { spec, argument, noun } of siblingKinds) {
      // Explicit-only: a sibling file is applied when — and only when — its flag names it. A
      // same-named file next to the main config is never picked up on its own.
      const siblingPath = resolveSiblingFilePath(spec, argument);
      if (siblingPath) {
        siblings.push({ path: siblingPath, spec, noun });
      }
    }
  } catch (error) {
    logErrorAndExit(printError(error));
  }

  if (siblings.length === 0) {
    // A wiring-only main config cannot be parsed without the sibling anchors it delegates to — fail
    // with a clear message instead of the raw "Unresolved alias" parse error below. With no sibling
    // in play this is the usual cause: the flag that names it was simply omitted.
    if (configDelegatesAnchors(context.configPath)) {
      logErrorAndExit(
        `${chalk.magenta(context.configPath)} delegates anchors to sibling file(s) — pass ` +
          `${DEPLOYED_SPEC.optionName} / ${INPUTS_SPEC.optionName} with the file(s) defining them ` +
          `(sibling files are never loaded automatically)`,
      );
    }
    // The inline-sections rejection applies on every non-composed load path, these ones included.
    return rejectInlineInputsSections(loadStateFromYaml(context.configPath));
  }

  const { document, labels } = loadStateWithSiblings(
    context.configPath,
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
  // A filter that selects nothing verified nothing, and "passed" would say otherwise
  if (context.checkOnly && stats.selected === 0) {
    logErrorAndExit(
      `${chalk.yellow(`-o "${context.checkOnlyCmdArg}"`)} matched nothing in ${chalk.magenta(context.configPath)}`,
    );
  }
  // Show final summary (outside the tree)
  log(""); // Separator line
  const statusMark = stats.errors ? FAILURE_MARK : SUCCESS_MARK;
  // The skip count rides on the summary line so that --quiet, which hides the per-method notes,
  // still says how much of the config went unverified
  const skippedNote = stats.skipped ? `, ${chalk.yellow(`${stats.skipped} skipped`)}` : "";
  const statusMessage = stats.errors
    ? `${stats.totalChecks} checks, ${chalk.red(`${stats.errors} errors`)}${skippedNote}`
    : `${stats.totalChecks} checks passed${skippedNote}`;
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

export async function downloadAndCheckAllAbi(jsonDocument: EntireDocument) {
  logHeader1("ABI checking");
  await iterateLoadedContracts(jsonDocument, checkAllAbi);
  flushAbiUpdates();
}

async function iterateLoadedContracts(
  jsonDocument: EntireDocument,
  callback: (chainId: string, contractInfo: ContractInfo) => Promise<void> | void,
) {
  for (const [explorerSectionKey, addresses] of Object.entries(jsonDocument.deployed)) {
    const explorerSection = jsonDocument[explorerSectionKey as keyof EntireDocument];

    if (isTypeOfTB(explorerSection, ExplorerSectionTB) || isTypeOfTB(explorerSection, NetworkSectionTB)) {
      const { explorerHostname, explorerTokenEnv } = explorerSection;
      const chainId = normalizeChainId(explorerSection.chainId);
      // `checks` resolve their ABI at `implementation:`, so the walk covers those addresses even
      // when the config lists only the proxy in deployed; Safe singletons are pinned exactly so.
      // Deduplicated by case: a duplicated address must not spend two download slots
      const implementations = Object.values("contracts" in explorerSection ? explorerSection.contracts : {})
        .map((entry) => (entry as { implementation?: string }).implementation)
        .filter((value): value is string => typeof value === "string");
      const seen = new Set<string>();
      const uniqueAddresses = [...addresses, ...implementations].filter((address) => {
        if (seen.has(address.toLowerCase())) return false;
        seen.add(address.toLowerCase());
        return true;
      });
      if (!explorerHostname) {
        log(
          `${WARNING_MARK} ${chalk.yellow(`No ${chalk.magenta("explorerHostname")} in the ${chalk.magenta(context.configPath)}, ABIs cannot be downloaded for ${explorerSectionKey}`)}`,
        );
        if (context.updateAbi) {
          // A chain with no explorer cannot re-download, so the rebuild keeps what the store
          // already holds for it
          for (const address of uniqueAddresses) {
            const keptName = keepStoredAbi(chainId, address);
            if (keptName) log(`ABI ${chalk.magenta(`${keptName} @ ${address}`)} ${chalk.green("Kept (no explorer)")}`);
          }
        }
        continue;
      }
      const explorerKey = explorerTokenEnv ? process.env[explorerTokenEnv] : "";
      if (explorerKey) registerSecret(explorerKey, `$${explorerTokenEnv}`);

      if (!explorerTokenEnv && explorerNeedsApiKey(explorerHostname)) {
        log(
          `${WARNING_MARK} ${chalk.yellow("explorerTokenEnv")} is not set in the ${chalk.magenta(context.configPath)}, the section ${chalk.magenta(explorerSectionKey)}`,
        );
      } else if (explorerTokenEnv && !explorerKey) {
        log(`\n${WARNING_MARK} ${chalk.yellow(`The env var ${explorerTokenEnv} is not set`)}\n`);
      }
      const toDownload: string[] = [];
      for (const address of uniqueAddresses) {
        const existingAbiName = getAbiNameForAddress(chainId, address);
        // Bytecode at an address never changes, so a stored ABI can only be refreshed on demand;
        // a rebuild re-downloads each address once, sibling configs of the run reuse the result
        const fresh = context.updateAbi && !wasFetchedThisRun(chainId, address);
        if (existingAbiName !== undefined && !fresh) {
          log(`ABI ${chalk.magenta(`${existingAbiName} @ ${address}`)} ${chalk.green("Skipped (exists)")}`);
          continue;
        }
        toDownload.push(address);
      }

      // The probe matters only when something will be downloaded: a fresh ABI from an explorer
      // of another network would be stored under the config's chainId regardless. A full store
      // must not depend on the explorer being awake, so nothing is asked otherwise
      if (toDownload.length > 0) {
        const explorerVerified = await verifyChainIdWithExplorer(explorerHostname, chainId, explorerKey);
        if (!explorerVerified && !context.allowUnverifiedExplorer) {
          logErrorAndExit(
            `${chalk.magenta(explorerHostname)} did not confirm chainId ${chalk.yellow(chainId)}, and ${chalk.yellow(toDownload.length)} ABIs are missing. ` +
              `Retry when the explorer answers, or pass ${chalk.yellow("--allow-unverified-explorer")}`,
          );
        }
      }

      // All requests start at once and the pacer spaces them to the explorer's per-second budget,
      // so a slow response never stalls the rest; the callbacks stay sequential to keep the log
      // readable and the store writes ordered
      const downloads = await Promise.all(
        toDownload.map(async (address) => ({
          address,
          info: await loadContractInfo(address, explorerHostname, explorerKey, chainId),
        })),
      );
      for (const { address, info } of downloads) {
        if (info) {
          await callback(chainId, info);
          continue;
        }
        const keptName = keepStoredAbi(chainId, address);
        if (keptName) {
          log(`ABI ${chalk.magenta(`${keptName} @ ${address}`)} ${chalk.green("Kept (explorer served none)")}`);
        }
      }
    }
  }
}

async function checkNetworkSection(sectionTitle: string, section: NetworkSection) {
  if (context.checkOnly && context.checkOnly.section !== sectionTitle) {
    return;
  }
  const rpcUrl = readUrlOrFromEnvironment(section.rpcUrl);
  const provider = createProvider(rpcUrl);
  const chainId = normalizeChainId(section.chainId);
  // assertProviderChain vouches for the RPC; the explorer is probed by the ABI pass, and only
  // when it has something to download
  await assertProviderChain(provider, chainId);
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
    } else if (
      /\.ya?ml$/.test(entry.name) &&
      !entry.name.includes(".seed.") &&
      !/\.(deployed|inputs)\.ya?ml$/.test(entry.name)
    ) {
      // Skip old seed files and anchor-only siblings, which are not standalone configs.
      files.push(fullPath);
    }
  }
  return files.toSorted((a, b) => a.localeCompare(b));
}

async function main() {
  Object.assign(context, parseCommandLineArguments());
  if (context.json) {
    // Ctrl+C must still leave one parseable report, carrying whatever ran before it
    process.once("SIGINT", () => emitReport(130, "interrupted by SIGINT", () => process.exit(130)));
  }

  if (!fs.existsSync(context.configPath)) {
    logErrorAndExit(`No such file or directory: ${chalk.magenta(context.configPath)}`);
  }

  if (fs.statSync(context.configPath).isDirectory()) {
    if (context.deployed || context.inputs) {
      logErrorAndExit("The --deployed and --inputs options require a single config file, not a directory");
    }
    if (context.checkOnly) {
      logErrorAndExit(`The ${chalk.yellow("-o")} option requires a single config file, not a directory`);
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
      beginConfig(configPath);
      await runConfig();
      endConfig();
      if (stats.errors) failed.push(`${configPath} (${stats.errors} errors)`);
    }
    pruneAbiStores();
    log("");
    if (failed.length > 0) {
      logError(
        `${FAILURE_MARK} ${chalk.bold(`${failed.length}/${configs.length} configs failed:`)}\n${failed.join("\n")}`,
      );
      exit(1);
      return;
    }
    log(`${SUCCESS_MARK} ${chalk.bold(`All ${configs.length} configs passed`)}`);
    exit(0);
    return;
  }

  // No prune here: a single-file run has walked only its own addresses, and sweeping the shared
  // store now would drop the sibling configs' ABIs
  beginConfig(context.configPath);
  await runConfig();
  endConfig();
  exit(stats.errors);
}

// Under --json the report owns the exit code; the log mode keeps exiting on the spot
function exit(code: number): void {
  if (context.json) {
    emitReport(code);
  } else if (code) {
    process.exit(code);
  }
}

async function runConfig() {
  const jsonDocument = loadStateWithOptionalSiblings();

  if (validateJsonWithSchema(jsonDocument, EntireDocumentTB)) {
    await downloadAndCheckAllAbi(jsonDocument);
    await doChecks(jsonDocument);
  }
}

// Do not run when imported (e.g. by unit tests) — only as the CLI entrypoint
if (require.main === module) {
  main().catch((error) => {
    if (context.json) {
      emitReport(1, printError(error));
      // A FatalError is fully told by the report; anything else is a bug worth its stack
      if (!(error instanceof FatalError)) console.error(error);
    } else {
      logError(error);
    }
    process.exitCode = 1;
  });
}
