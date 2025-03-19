import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import chalk from "chalk";
import dotenv from "dotenv";

import { log, LogCommand, logHeader1, logHeader2 } from "../logger";

type EnvironmentVariables = Record<string, string[]>;

type PrintableReport = {
  yamlFolderName: string;
  yamlFile: string;
  fileNameEnd: string;
  output: string;
};

type Response = {
  result?: Result;
  output?: string;
};

class Result {
  public checks?: number;
  public errors: number;

  constructor(response: string) {
    const checksMatch = response.match(/(\d+) checks performed/);
    const errorsMatch = response.match(/(\d+) errors found/);

    this.checks = checksMatch ? Number.parseInt(checksMatch[1], 10) : undefined;
    this.errors = errorsMatch ? Number.parseInt(errorsMatch[1], 10) : 0;
  }
  isValid(): boolean {
    return !!this?.checks;
  }
  succeededChecks(): number | undefined {
    return this.checks ? this.checks - this.errors : undefined;
  }

  toString(): string {
    return this.checks ? `${this.checks - this.errors}/${this.checks}` : "";
  }

  equals(other?: Result): boolean {
    if (!other) return false;
    return this.checks === other.checks && this.errors === other.errors;
  }
}

class ResultsMatcher {
  constructor(
    private forkResult?: Result,
    private originResult?: Result,
  ) {}
  areMatched(): boolean {
    return this.forkResult?.equals(this.originResult) ?? false;
  }
  toString(): string {
    if (!this.forkResult || !this.originResult) return "";
    const print = (forkCounter?: number, originCounter?: number): string => {
      const report = `${forkCounter ?? 0} vs ${originCounter ?? 0}`;
      return `${forkCounter === originCounter ? chalk.green(report) : chalk.red(report)}`;
    };

    const formattedReport =
      `(total checks: ${print(this.forkResult.checks, this.originResult?.checks)}; ` +
      `succeeded checks: ${print(this.forkResult.succeededChecks(), this.originResult.succeededChecks())}; ` +
      `errors: ${print(this.forkResult.errors, this.originResult.errors)})`;

    return formattedReport;
  }
}

const FORK_REPO_OPTIONS = undefined; // --abi, --schemas, --generate, -o l1
const ORIGIN_REPO_OPTIONS = undefined; // --generate, -o l1
const FORK_REPO_PATH: string = process.cwd();
let ORIGIN_REPO_PATH: string;

function setEnvironmentsFromFolder(folder: string, environmentVariables?: EnvironmentVariables) {
  if (environmentVariables && environmentVariables[folder]) {
    Object.assign(process.env, environmentVariables[folder]);
    log(
      `The following environment variables are additionally set:\n ${JSON.stringify(environmentVariables[folder], null, 2)}`,
    );
  }
}

function processAllYamlFolders(
  yamlFolderAbsolutePath: string,
  requiredFolders: string[],
  environmentVariables?: EnvironmentVariables,
) {
  const folders = getOnlyRequiredFolders(yamlFolderAbsolutePath, requiredFolders);

  for (const folder of folders) {
    setEnvironmentsFromFolder(folder, environmentVariables);

    const yamlSubFolderAbsolutePath = path.join(yamlFolderAbsolutePath, folder);
    const yamlFiles = getAllYamlFilesFromFolder(yamlSubFolderAbsolutePath);
    if (yamlFiles.length > 0) {
      logHeader1(yamlSubFolderAbsolutePath);
      for (const yamlFile of yamlFiles) {
        logHeader2(yamlFile);
        processYamlFile(yamlFolderAbsolutePath, folder, yamlFile);
      }
    }

    const subfolderPath = path.join(yamlFolderAbsolutePath, folder);
    processAllYamlFolders(subfolderPath, []);
  }
}

function getOnlyRequiredFolders(repoPath: string, selectedFolders: string[]): string[] {
  return fs
    .readdirSync(repoPath)
    .filter(
      (folder) =>
        fs.statSync(path.join(repoPath, folder)).isDirectory() &&
        (selectedFolders.length === 0 || selectedFolders.includes(folder)),
    );
}

function getAllYamlFilesFromFolder(yamlFolderAbsolutePath: string): string[] {
  return fs
    .readdirSync(yamlFolderAbsolutePath)
    .filter((file) => [".yml", ".yaml"].some((extension) => file.endsWith(extension)) && !file.includes("seed"));
}

function processYamlFile(currentFolderPath: string, yamlFolderName: string, yamlFile: string) {
  const yamlFileAbsolutePath = path.join(currentFolderPath, yamlFolderName, yamlFile);

  process.chdir(FORK_REPO_PATH);
  const forkResponse: Response = runStateMate(yamlFileAbsolutePath, FORK_REPO_OPTIONS);
  if (forkResponse.output) {
    const forkReport: PrintableReport = {
      yamlFolderName: yamlFolderName,
      yamlFile: yamlFile,
      fileNameEnd: "_fork.txt",
      output: forkResponse.output,
    };
    writeToFile(forkReport);
  }

  process.chdir(ORIGIN_REPO_PATH);
  const originResponse: Response = runStateMate(yamlFileAbsolutePath, ORIGIN_REPO_OPTIONS);
  if (originResponse.output) {
    const originReport: PrintableReport = {
      yamlFolderName,
      yamlFile,
      fileNameEnd: "_origin.txt",
      output: originResponse.output,
    };
    writeToFile(originReport);
  }

  const logHandler = new LogCommand(path.join(yamlFolderName, yamlFile));
  const resultsMatcher = new ResultsMatcher(forkResponse?.result, originResponse?.result);
  if (resultsMatcher.areMatched()) {
    logHandler.success(`Matched ${resultsMatcher.toString()}`);
  } else {
    logHandler.failure(`Unmatched ${resultsMatcher.toString()}`);
  }
}

function runStateMate(yamlFileAbsolutePath: string, options?: string): Response {
  const yamlFileRelativePath = path.relative(FORK_REPO_PATH, yamlFileAbsolutePath);
  const command = `yarn run start ${yamlFileRelativePath}${options ? ` ${options}` : ""}`;

  const logHandler = new LogCommand(`Calling ${chalk.magenta(command)} in ${chalk.magenta(process.cwd())}`);
  const output = run(command);
  if (output) {
    const result = new Result(output);
    if (result.isValid()) {
      logHandler.success(`Done (${result.toString()})`);
    } else {
      logHandler.failure("Failed with report");
    }
    return { result, output };
  } else {
    logHandler.failure("Failed without report");
    return {};
  }
}

function run(command: string): string | null {
  try {
    const output = execSync(command, { stdio: ["ignore", "pipe", "pipe"] }).toString();
    return output;
  } catch (error) {
    if (error instanceof Error && "stdout" in error && error.stdout && "stderr" in error && error.stderr) {
      const output = String(error.stdout) + String(error.stderr);
      return output;
    }
    return null;
  }
}

function writeToFile(report: PrintableReport) {
  const { yamlFolderName, yamlFile, fileNameEnd, output } = report;
  const reportDirectoryPath = path.resolve(path.join(FORK_REPO_PATH, "reports"), yamlFolderName);
  fs.mkdirSync(reportDirectoryPath, { recursive: true });
  const reportFilePath = path.join(reportDirectoryPath, path.parse(yamlFile).name + fileNameEnd);
  fs.writeFileSync(reportFilePath, output, "utf8");
}

async function main() {
  const [_, __, otherRepoPath, ...requiredFolders] = process.argv;

  if (!otherRepoPath) {
    console.error("Usage: yarn test <path/to/other/repo> [folder1 folder2 ...]");
    process.exit(1);
  }
  ORIGIN_REPO_PATH = otherRepoPath;

  const filePath = path.resolve(__dirname, "env-vars.json");

  const environmentVariables: EnvironmentVariables = JSON.parse(fs.readFileSync(filePath, "utf8"));

  dotenv.config();
  log(`The following environment variables are set:\n ${JSON.stringify(environmentVariables["common"], null, 2)}`);
  Object.assign(process.env, environmentVariables["common"]);

  const yamlFolderAbsolutePath = path.join(process.cwd(), "configs");

  if (requiredFolders.length > 0) {
    logHeader1(`Test is running only for ${requiredFolders.join(", ")}`);
  }

  processAllYamlFolders(yamlFolderAbsolutePath, requiredFolders, environmentVariables);
}

// eslint-disable-next-line unicorn/prefer-top-level-await
main().catch((error) => console.error(error));
