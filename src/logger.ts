import chalk from "chalk";

export const SUCCESS_MARK = chalk.green("✔");
export const FAILURE_MARK = chalk.red("✘");
export const WARNING_MARK = chalk.yellow("⚠");
export class LogCommand {
  private description: string;

  constructor(description: string) {
    this.description = description;
    this.initialPrint();
  }

  public printResult(statusSymbol: string, result: string): void {
    process.stdout.cursorTo(0);
    process.stdout.clearLine(0);
    process.stdout.write(`${statusSymbol} ${this.description}: ${chalk.yellow(result)}\n`);
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
    const indent = "  "; // SUCCESS_MARK printed length
    process.stdout.write(`${indent}${this.description}: ...`);
  }
}

export function logHeader1(argument: string) {
  const length = "=====  =====".length + argument.length;
  const middleLine = chalk.grey(`===== ${chalk.blueBright(argument)} =====`);
  const headerFooter = chalk.grey("=".repeat(length));
  log(`\n${headerFooter}\n${middleLine}\n${headerFooter}`);
}

export function logHeader2(argument: unknown) {
  log(chalk.gray(`\n===== ${chalk.magenta(argument)} =====`));
}

export function logMethodSkipped(methodName: string) {
  log(`${WARNING_MARK} .${methodName}: ${chalk.yellow("skipped")}`);
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
  console.error(`ERROR: ${String(argument)}`);
  console.error();
  console.trace();
}

export function logErrorAndExit(argument: unknown): never {
  logError(argument);
  process.exit(1);
}
