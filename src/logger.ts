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

export function logHeader1(arg: string) {
  const length = "=====  =====".length + arg.length;
  const middleLine = chalk.grey(`===== ${chalk.blueBright(arg)} =====`);
  const headerFooter = chalk.grey("=".repeat(length));
  log(`\n${headerFooter}\n${middleLine}\n${headerFooter}`);
}

export function logHeader2(arg: unknown) {
  log(chalk.gray(`\n===== ${chalk.magenta(arg)} =====`));
}

export function logMethodSkipped(methodName: string) {
  log(`${WARNING_MARK} .${methodName}: ${chalk.yellow("skipped")}`);
}

export function log(arg: unknown) {
  console.log(arg);
}

export function logReplaceLine(arg: unknown) {
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(`${String(arg)}`);
}

export function logError(arg: unknown) {
  console.error(`ERROR: ${String(arg)}`);
  console.error();
  console.trace();
}

export function logErrorAndExit(arg: unknown): never {
  logError(arg);
  process.exit(1);
}
