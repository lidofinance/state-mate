import * as readline from "node:readline";

import chalk from "chalk";

export const SUCCESS_MARK = chalk.green("✔");
export const FAILURE_MARK = chalk.red("✘");
export const WARNING_MARK = chalk.yellow("⚠");

// Tree drawing characters (gray colored)
const TREE_BRANCH = chalk.gray("├──");
const TREE_LAST = chalk.gray("└──");
const TREE_PIPE = chalk.gray("│  ");
const TREE_SPACE = "   ";

// Track current item prefix for tree structure
let itemPrefix = "";

export function getItemPrefix(): string {
  return itemPrefix;
}

export class LogCommand {
  private description: string;

  constructor(description: string) {
    this.description = description;
    this.initialPrint();
  }

  public printResult(statusSymbol: string, result: string): void {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    const prefix = getItemPrefix();
    process.stdout.write(`${prefix}${statusSymbol} ${this.description}: ${chalk.yellow(result)}\n`);
  }

  public success(result: string): void {
    this.printResult(SUCCESS_MARK, result);
  }

  public failure(result: string): void {
    this.printResult(FAILURE_MARK, result);
  }

  public warning(result: string): void {
    this.printResult(WARNING_MARK, result);
  }

  private initialPrint(): void {
    const prefix = getItemPrefix();
    process.stdout.write(`${prefix}  ${this.description}: ...`);
  }
}

export function logHeader1(argument: string) {
  log(`\n${chalk.blueBright(argument)}`);
  itemPrefix = "";
}

export function logHeader2(path: string) {
  log(`${TREE_BRANCH} ${chalk.magenta(path)}`);
  itemPrefix = TREE_PIPE;
}

export function logSubHeader(path: string, isLast: boolean = false) {
  const branch = isLast ? TREE_LAST : TREE_BRANCH;
  log(`${TREE_PIPE}${branch} ${chalk.magenta(path)}`);
  itemPrefix = TREE_PIPE + (isLast ? TREE_SPACE : TREE_PIPE);
}

export function logMethodSkipped(methodName: string) {
  const prefix = getItemPrefix();
  log(`${prefix}${WARNING_MARK} .${methodName}: ${chalk.yellow("skipped")}`);
}

export function logFinalStatus(message: string, isSuccess: boolean, isLast: boolean = true) {
  const mark = isSuccess ? SUCCESS_MARK : FAILURE_MARK;
  const branch = isLast ? TREE_LAST : TREE_BRANCH;
  log(`${branch} ${mark} ${message}`);
  itemPrefix = "";
}

export function logWarningStatus(message: string) {
  log(`${TREE_LAST} ${WARNING_MARK} ${message}`);
}

export function log(argument: unknown) {
  console.log(argument);
}

export function logReplaceLine(argument: unknown) {
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(`${String(argument)}`);
}

export function logError(argument: unknown) {
  const prefix = getItemPrefix();
  console.error(`${prefix}ERROR: ${String(argument)}`);
}

export function logErrorAndExit(argument: unknown): never {
  logError(argument);
  console.trace();
  process.exit(1);
}
