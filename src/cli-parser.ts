import path from "node:path";

import { Command } from "commander";

import { EntryField } from "./common";
import { logErrorAndExit } from "./logger";

type CheckOnlyOptionType = null | {
  section: string;
  contract?: string;
  checksType?: string;
  method?: string;
};

const collectOption = (value: string, previous: string[]): string[] => [...previous, value];

export function parseCmdLineArguments(argv: string[] = process.argv) {
  const program = new Command();
  program
    .argument("<config-path>", "path to .yaml state config file")
    .allowExcessArguments(false)
    .option(
      "-o, --only <check-path>",
      `only checks to do, e.g. 'l2/proxyAdmin/${EntryField.checks}/owner', 'l1', 'l1/controller'`,
    )
    .option("--generate", "generate a populated config from the seed one")
    .option(
      "--deployed <path>",
      "path to a '.deployed' YAML file that provides the address anchors for a wiring-only main config " +
        "(defaults to the sibling '<name>.deployed.<ext>' if it exists)",
    )
    .option(
      "--inputs <path>",
      "path to a '.inputs' YAML file that provides some or all config/externals anchors for a wiring-only " +
        "main config; repeat to compose disjoint input files (defaults to the sibling " +
        "'<name>.inputs.<ext>' if omitted and that sibling exists)",
      collectOption,
      [],
    )
    .option(
      "--overrides <path>",
      "path to a YAML file shaped like a '.inputs' file that OVERRIDES values of labels already defined " +
        "in the .inputs file (every label must already exist there and every value must differ); " +
        "explicit path only, never auto-loaded",
    )
    .option("--update-abi", "download all ABIs replacing existing files")
    .option("--update-abi-missing", "download only missing ABIs (skip existing)")
    .parse(argv);

  const configPath = program.args[0];
  const options = program.opts();
  const inputs = options.inputs as string[];
  if (options.overrides && inputs.length > 1 && !options.generate) {
    throw new Error(
      `--overrides currently supports exactly one --inputs file; it cannot be combined with repeated --inputs options`,
    );
  }
  let checkOnly: CheckOnlyOptionType = null;
  if (options.only) {
    const checksPath = String(options.only).split("/");
    if (checksPath.length === 0 || checksPath.length > 4) {
      logErrorAndExit(
        `Invalid checkOnly argument format, must be <section>/[<contractName>]/[<checks|proxyChecks|implementationChecks>]/<method>`,
      );
    }
    checkOnly = {
      section: checksPath[0],
      contract: checksPath[1],
      checksType: checksPath[2],
      method: checksPath[3],
    };
  }

  return {
    configPath,
    abiDirPath: path.join(path.dirname(configPath), "abi"),
    checkOnly,
    checkOnlyCmdArg: options.only,
    generate: options.generate,
    deployed: options.deployed as string | undefined,
    inputs,
    overrides: options.overrides as string | undefined,
    updateAbi: options.updateAbi || options.updateAbiMissing,
    updateAbiMissingOnly: options.updateAbiMissing,
  };
}
