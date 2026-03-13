import path from "node:path";

import { program } from "commander";

import { EntryField } from "./common";
import { logErrorAndExit } from "./logger";

type CheckOnlyOptionType = null | {
  section: string;
  contract?: string;
  checksType?: string;
  method?: string;
};

export function parseCmdLineArguments() {
  program
    .argument("<config-path>", "path to .yaml state config file")
    .allowExcessArguments(false)
    .option(
      "-o, --only <check-path>",
      `only checks to do, e.g. 'l2/proxyAdmin/${EntryField.checks}/owner', 'l1', 'l1/controller'`,
    )
    .option("--generate", "generate a populated config from the seed one")
    .option("--update-abi", "download all ABIs replacing existing files")
    .option("--update-abi-missing", "download only missing ABIs (skip existing)")
    .parse();

  const configPath = program.args[0];
  const options = program.opts();
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
    updateAbi: options.updateAbi || options.updateAbiMissing,
    updateAbiMissingOnly: options.updateAbiMissing,
  };
}
