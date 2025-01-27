import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import chalk from "chalk";
import dotenv from "dotenv";

import { log, LogCommand, logHeader1, logHeader2 } from "./logger";

dotenv.config();

class Result {
  private checks: number;
  private errors: number;

  constructor(response: string) {
    const checksMatch = response.match(/(\d+) checks performed/);
    const errorsMatch = response.match(/(\d+) errors found/);

    this.checks = checksMatch ? Number.parseInt(checksMatch[1], 10) : 0;
    this.errors = errorsMatch ? Number.parseInt(errorsMatch[1], 10) : 0;
  }

  succeededChecks(): number {
    return this.checks - this.errors;
  }

  toString(): string {
    return `${this.checks - this.errors}/${this.checks}`;
  }

  equals(other: Result | null): boolean {
    if (!other) return false;
    return this.checks === other.checks && this.errors === other.errors;
  }
}

class ResultsMatcher {
  constructor(
    private currentResult: Result | null,
    private otherResult: Result | null,
  ) {}
  areMatched(): boolean {
    return this.currentResult !== null && this.otherResult !== null && this.currentResult.equals(this.otherResult);
  }
  toString(): string {
    let formattedReport: string = "";
    if (this.currentResult !== null && this.otherResult !== null) {
      const currentSucceededChecks = this.currentResult.succeededChecks();
      const otherSucceededChecks = this.otherResult.succeededChecks();
      const report = `${currentSucceededChecks} vs ${otherSucceededChecks}`;
      formattedReport =
        `Succeeded checks: ` +
        `${currentSucceededChecks === otherSucceededChecks ? chalk.green(report) : chalk.red(report)}`;
    }
    return formattedReport;
  }
}


const ENV_VARS: Record<string, Record<string, string>> = {
  common: {
    L1_MAINNET_RPC_URL: "https://ethereum-rpc.publicnode.com",
    L2_MAINNET_RPC_URL: "https://swell-mainnet.alt.technology",
    ETHERSCAN_TOKEN: "",
  },
  dvv: {},
  mantle: {},
  mode: {},
  bsc: { BSCSCAN_TOKEN: "" },
};

function getAllYamlFolders(repoPath: string, selectedFolders: string[]): string[] {
  const yamlDirectory = path.join(repoPath, "configs");
  return fs
    .readdirSync(yamlDirectory)
    .filter((folder) => selectedFolders.length === 0 || selectedFolders.includes(folder));
}

function getAllYamlFiles(repoPath: string, folder: string): string[] {
  const folderPath = path.join(repoPath, "configs", folder);
  return fs
    .readdirSync(folderPath)
    .filter((file) => [".yml", ".yaml"].some((extension) => file.endsWith(extension)) && !file.includes("seed"));
}

async function main() {
  const [_, __, otherRepoPath, ...selectedFolders] = process.argv;

  if (!otherRepoPath) {
    console.error("Usage: yarn test <path/to/other/repo> [folder1 folder2 ...]");
    process.exit(1);
  }

  if (selectedFolders.length > 0) {
    logHeader1(`Test is running only for ${selectedFolders.join(", ")}`);
  }

  log(`The following environment variables are set:\n ${JSON.stringify(ENV_VARS["common"], null, 2)}`);
  Object.assign(process.env, ENV_VARS["common"]);

  const currentPath = process.cwd();

  for (const folder of getAllYamlFolders(currentPath, selectedFolders)) {
    logHeader1(folder);
    if (ENV_VARS[folder]) {
      Object.assign(process.env, ENV_VARS[folder]);
      log(`The following environment variables are additionally set:\n ${JSON.stringify(ENV_VARS[folder], null, 2)}`);
    }
    for (const yamlFile of getAllYamlFiles(currentPath, folder)) {
      logHeader2(yamlFile);
      process.chdir(currentPath);
      const currentResult: Result | null = runStateMate(currentPath, folder, yamlFile, CURRENT_REPO_OPTIONS);
      const otherResult: Result | null = runStateMate(otherRepoPath, folder, yamlFile, OTHER_REPO_OPTIONS);

      const logHandler = new LogCommand(path.join(folder, yamlFile));
      const resultsMatcher = new ResultsMatcher(currentResult, otherResult);
      if (resultsMatcher.areMatched()) {
        logHandler.success(`Matched ${resultsMatcher.toString()}`);
      } else {
        logHandler.failure(`Unmatched ${resultsMatcher.toString()}`);
      }
    }
  }
}

function runStateMate(repoPath: string, folder: string, yamlFile: string, options?: string): Result | null {
  process.chdir(repoPath);
  const yamlFilePath = path.relative(repoPath, path.join("configs", folder, yamlFile));
  const command = `yarn run start ${yamlFilePath}${options ? ` ${options}` : ""}`;
  const logHandler = new LogCommand(`Calling ${chalk.magenta(command)} in ${chalk.magenta(repoPath)}`);

  try {
    const output = execSync(command, { stdio: ["ignore", "pipe", "ignore"] }).toString();
    const result = new Result(output);
    logHandler.success(`Done (${result.toString()})`);
    return result;
  } catch (error) {
    if (error instanceof Error && "stdout" in error && error.stdout) {
      const result = new Result(String(error.stdout));
      logHandler.success(`Done (${result.toString()})`);
      return result;
    }
    logHandler.failure("Failed");
    return null;
  }
}

// eslint-disable-next-line unicorn/prefer-top-level-await
main().catch((error) => console.error(error));
