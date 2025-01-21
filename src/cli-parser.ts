import path from "node:path";

import { program } from "commander";

import { Ef } from "./common";
import { logErrorAndExit } from "./logger";

type CheckOnlyOptionType =
  | undefined
  | {
      section: string;
      contract?: string;
      checksType?: string;
      method?: string;
      schemas?: string;
    };

export function parseCmdLineArguments() {
  program
    .argument("<config-path>", "path to .yaml state config file")
    .allowExcessArguments(false)
    .option(
      "-o, --only <check-path>",
      `only checks to do, e.g. 'l2/proxyAdmin/${Ef.checks}/owner', 'l1', 'l1/controller'`,
    )
    .option("--generate", "generate a populated config from the seed one")
    .option("--abi", "check that the saved ABIs and explorer ABIs are equal")
    .option("--schemas", "generate main and seed JSON-schemas")
    .parse();

  const configPath = program.args[0];
  const options = program.opts();
  let checkOnly: CheckOnlyOptionType;
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
      schemas: checksPath[4],
    };
  }

  return {
    configPath,
    abiDirPath: path.join(path.dirname(configPath), "abi"),
    checkOnly,
    checkOnlyCmdArg: options.only ? String(options.only) : undefined,
    generate: options.generate ? String(options.generate) : undefined,
    abi: options.abi ? String(options.abi) : undefined,
    schemas: options.schemas ? String(options.schemas) : undefined,
  };
}
