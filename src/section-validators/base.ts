import { assert, AssertionError } from "chai";
import chalk from "chalk";
import { Contract, JsonRpcProvider, Result } from "ethers";

import { Ef, getNonMutables, printError } from "src/common";
import { LogCommand, logError, logErrorAndExit, logMethodSkipped } from "src/logger";
import { g_Arguments } from "src/state-mate";
import {
  ArbitraryObject,
  ContractEntry,
  isTypeOfTB,
  StaticCallCheck,
  StaticCallMustRevert,
  StaticCallMustRevertTB,
  StaticCallResult,
  StaticCallResultTB,
  ViewResult,
} from "src/typebox";
import { Abi, AbiArgumentsLength } from "src/types";

export let g_errors: number = 0;

export function incErrors(): void {
  g_errors += 1;
}

export enum CheckLevel {
  section = "section",
  contract = "contract",
  checksType = "checksType",
  method = "method",
}

export function needCheck(level: CheckLevel, name: string) {
  if (!g_Arguments.checkOnly) {
    return true;
  }
  const checkOnTheLevel = g_Arguments.checkOnly[level];
  return checkOnTheLevel === null || checkOnTheLevel === undefined || name === checkOnTheLevel;
}

export abstract class SectionValidatorBase {
  constructor(
    protected provider: JsonRpcProvider,
    protected sectionName: Ef,
  ) {}

  public abstract validateSection(contractEntry: ContractEntry, contractAlias: string): Promise<void>;

  protected async _checkViewFunction(contract: Contract, method: string, staticCallCheck: StaticCallCheck) {
    if (isTypeOfTB(staticCallCheck, StaticCallResultTB)) {
      await this._checkViewResult(contract, method, staticCallCheck);
    } else if (isTypeOfTB(staticCallCheck, StaticCallMustRevertTB)) {
      await this._checkViewMustRevert(contract, method, staticCallCheck);
    } else {
      logErrorAndExit(`Unknown static call check type: ${JSON.stringify(staticCallCheck)}`);
    }
  }

  protected async _checkViewResult(contract: Contract, method: string, staticCallResult: StaticCallResult) {
    if (staticCallResult.result === null) {
      logMethodSkipped(method);
      return;
    }

    const { args, result: expected, signature = method } = staticCallResult;

    const argumentsString = args ? `(${args.toString()})` : "";
    const logHandle = new LogCommand(`.${signature}${argumentsString}`);
    let contractFunction: ReturnType<typeof contract.getFunction>;
    try {
      contractFunction = contract.getFunction(signature);
    } catch (error) {
      logHandle.failure(printError(error));
      g_errors++;
      return;
    }
    try {
      const actual: unknown = await contractFunction.staticCall(...(args || ""));
      _assertEqual(actual, expected);
      logHandle.success(_stringify(actual));
    } catch (error) {
      logHandle.failure(`REVERTED with: ${printError(error)}`);
      g_errors++;
    }
  }

  protected async _checkViewMustRevert(contract: Contract, method: string, staticCallMustRevert: StaticCallMustRevert) {
    const { args, signature = method } = staticCallMustRevert;

    const argumentsString = args ? `(${args.toString()})` : "";
    const logHandle = new LogCommand(`.${signature}${argumentsString}`);
    let contractFunction: ReturnType<typeof contract.getFunction>;
    try {
      contractFunction = contract.getFunction(signature);
    } catch (error) {
      logHandle.failure(printError(error));
      g_errors++;
      return;
    }
    try {
      const actual: unknown = await contractFunction.staticCall(...(args || ""));
      logHandle.failure(_stringify(actual));
      g_errors++;
    } catch (error) {
      logHandle.success(`REVERTED with: ${printError(error)}`);
    }
  }

  protected _reportNonCoveredNonMutableChecks(contractAlias: string, abi: Abi, checks: string[]) {
    const nonMutableFromAbi = getNonMutables(abi);
    const nonCovered = nonMutableFromAbi
      .filter((x) => !checks.includes(x.name))
      .map((x) => x.name || x) as AbiArgumentsLength;
    if (nonCovered.length > 0) {
      logError(
        `Section ${contractAlias} ${this.sectionName} does not cover these non-mutable function from ABI: ${chalk.red(nonCovered.join(", "))}`,
      );
      incErrors();
    }
  }
}

function _stringify(value: unknown) {
  return value instanceof Object ? JSON.stringify(value) : `${String(value)}`;
}

function _assertEqual(actual: unknown, expected: ViewResult, errorMessage?: string) {
  if (typeof actual === "bigint") {
    assert(typeof expected === "string" || typeof expected === "bigint");
    _equalOrThrow(actual, BigInt(expected), errorMessage);
  } else if (Array.isArray(expected)) {
    _equalOrThrow(
      (actual as unknown[]).length,
      expected.length,
      `Array length differ: actual = '${String(actual)}', expected = '${String(expected)}'`,
    );
    if (!errorMessage) {
      errorMessage = `Actual value '${String(actual)} is not equal to expected array '[${String(expected)}]`;
    }
    for (let index = 0; index < (actual as unknown[]).length; ++index) {
      _assertEqual((actual as unknown[])[index], expected[index], errorMessage);
    }
  } else if (typeof expected === "object") {
    _assertEqualStruct(expected, actual as Result);
  } else {
    _equalOrThrow(actual, expected, errorMessage);
  }
}

function _assertEqualStruct(expected: null | ArbitraryObject, actual: Result) {
  if (expected === null) {
    return;
  }

  const actualAsObject = actual.toObject();
  const errorMessage = `expected ${_stringify(actualAsObject)} to equal ${_stringify(expected)}`;

  _equalOrThrow(Object.keys(actualAsObject).length, Object.keys(expected).length, errorMessage);
  for (const field in actualAsObject) {
    const expectedValue = expected[field];
    if (expectedValue === null) {
      continue;
    }
    let actualValue: unknown = actualAsObject[field];
    const errorMessageDetailed = errorMessage + ` but fields "${field}" differ`;
    if (actualValue instanceof Result && Array.isArray(expectedValue as unknown)) {
      actualValue = actualValue.toArray();
    }
    _assertEqual(actualValue, expectedValue, errorMessageDetailed);
  }
}

function _equalOrThrow(actual: unknown, expected: unknown, errorMessage?: string) {
  if (actual !== expected) {
    if (!errorMessage) {
      errorMessage = `Expected "${_stringify(expected)}" to equal actual "${_stringify(actual)}"`;
    }
    throw new AssertionError(errorMessage);
  }
}
