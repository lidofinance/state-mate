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
    .option("--update-abi", "re-download every ABI; missing ones are downloaded without the flag too")
    .option("--skip-implementation-check", "do not verify implementation addresses against the chain")
    .option("--allow-unverified-explorer", "download ABIs even when the explorer does not confirm the config's chainId")
    .option("-q, --quiet", "print only contract headers, per-contract totals and errors")
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
    updateAbi: options.updateAbi,
    skipImplementationCheck: Boolean(options.skipImplementationCheck),
    allowUnverifiedExplorer: Boolean(options.allowUnverifiedExplorer),
    quiet: Boolean(options.quiet),
  };
}
