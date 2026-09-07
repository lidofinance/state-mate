import { CommanderError, program } from "commander";

import { EntryField, printError } from "./common";
import { type CheckOnly, context } from "./context";
import { FatalError, logErrorAndExit } from "./logger";

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
    .option("-J, --json", "one JSON report on stdout: verdict, counters, failed checks; see docs/json-output.md");

  // A usage error under --json must reach the caller as a report, so commander may neither
  // print nor exit on its own; the flag is read off argv because parsing is what failed
  let usageError = "";
  program.exitOverride().configureOutput({
    writeErr: (text) => {
      usageError += text;
    },
  });
  try {
    program.parse();
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) process.exit(0);
    if (process.argv.includes("--json") || process.argv.includes("-J")) {
      context.json = true;
      throw new FatalError(usageError.trim() || printError(error));
    }
    process.stderr.write(usageError);
    process.exit(error instanceof CommanderError ? error.exitCode : 1);
  }

  const configPath = program.args[0];
  const options = program.opts();
  // Set before the -o validation below, so that a malformed filter is reported the way the caller
  // asked, and under the filter they gave
  context.json = Boolean(options.json);
  context.checkOnlyCmdArg = options.only;
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
    json: Boolean(options.json),
  };
}
