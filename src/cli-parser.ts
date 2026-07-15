import { program } from "commander";

import { EntryField } from "./common";
import { CheckOnly } from "./context";
import { logErrorAndExit } from "./logger";

type CheckOnlyOptionType = null | CheckOnly;

export function parseCommandLineArguments() {
  program
    .argument("<config-path>", "path to a .yaml state config file, or a directory to run every config inside it")
    .allowExcessArguments(false)
    .option(
      "-o, --only <check-path>",
      `only checks to do, e.g. 'l2/proxyAdmin/${EntryField.checks}/owner', 'l1', 'l1/controller'`,
    )
    .option("--generate", "generate a populated config from the seed one")
    .option("--update-abi", "download missing ABIs (never overwrites existing ones)")
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
    checkOnly,
    checkOnlyCmdArg: options.only,
    generate: options.generate,
    updateAbi: options.updateAbi,
  };
}
