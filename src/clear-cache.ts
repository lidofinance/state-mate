import path from "node:path";

import { program } from "commander";

import { clearCacheDirectory, initCacheDirectory } from "./cache-provider";
import { log, logErrorAndExit } from "./logger";

program.argument("<config-path>", "path to .yaml state config file").allowExcessArguments(false).parse();

const configPath = program.args[0];

if (!configPath) {
  logErrorAndExit("Config path is required");
}

const absoluteConfigPath = path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath);

log(`Clearing cache for config: ${absoluteConfigPath}`);

// Initialize cache directory (with cache enabled so we can clear it)
initCacheDirectory(absoluteConfigPath, { disabled: false });

// Clear the cache
clearCacheDirectory();

log("Cache cleared successfully");
