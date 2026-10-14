import { AssertionError } from "chai";
import chalk from "chalk";
import { type Contract, type JsonRpcProvider, Result } from "ethers";

import { loadAbiFromFile } from "src/abi-provider";
import { type EntryField, getNonMutables, printError } from "src/common";
import { context, type ErrorDetail, stats } from "src/context";
import type { RetryingJsonRpcProvider } from "src/explorer";
import { LogCommand, logError, logErrorAndExit, logMethodSkipped } from "src/logger";
import { recordObservedCall } from "src/observed";
import { assertPinnedState } from "src/pinned-block";
import {
  type ArbitraryObject,
  type ContractEntry,
  isTypeOfTB,
  ProxyContractEntryTB,
  type StaticCallCheck,
  type StaticCallMustRevert,
  StaticCallMustRevertTB,
  type StaticCallResult,
  StaticCallResultTB,
  type ViewResult,
} from "src/typebox";
import type { Abi, AbiArgumentsLength, ChainId } from "src/types";

// Per-contract counters
let contractErrors: number = 0;
let contractChecks: number = 0;
let contractSkipped: number = 0;

let currentErrorContext: Partial<ErrorDetail> = {};

export function setErrorContext(update: Partial<ErrorDetail>): void {
  currentErrorContext = { ...currentErrorContext, ...update };
}

export function getErrorContext(): Readonly<Partial<ErrorDetail>> {
  return currentErrorContext;
}

export function clearErrorContext(): void {
  currentErrorContext = {};
}

export function resetContractCounters(): void {
  contractErrors = 0;
  contractChecks = 0;
  contractSkipped = 0;
}

export function getContractStats(): { checks: number; errors: number; skipped: number } {
  return { checks: contractChecks, errors: contractErrors, skipped: contractSkipped };
}

export function incErrors(errorMessage?: string): void {
  stats.errors += 1;
  contractErrors += 1;
  if (errorMessage) {
    stats.errorDetails.push({
      section: currentErrorContext.section || "unknown",
      contract: currentErrorContext.contract || "unknown",
      contractAddress: currentErrorContext.contractAddress || "unknown",
      checksType: currentErrorContext.checksType || "unknown",
      method: currentErrorContext.method || "unknown",
      message: errorMessage,
    });
  }
}

export function incChecks(): void {
  stats.totalChecks += 1;
  contractChecks += 1;
  countSelected();
}

export function incSkipped(): void {
  stats.skipped += 1;
  contractSkipped += 1;
  countSelected();
}

// The checks that run without being declared under a checks type
const AUTOMATIC_CHECKS = new Set(["implementation", "proxyAdmin", "proxyAdminOwner"]);

function countSelected(): void {
  if (context.checkOnly?.checksType && AUTOMATIC_CHECKS.has(currentErrorContext.checksType ?? "")) return;
  stats.selected += 1;
}

export enum CheckLevel {
  section = "section",
  contract = "contract",
  checksType = "checksType",
  method = "method",
}

export function needCheck(level: CheckLevel, name: string) {
  if (!context.checkOnly) {
    return true;
  }
  const checkOnTheLevel = context.checkOnly[level];
  return checkOnTheLevel == null || name === checkOnTheLevel;
}

export type CheckOutcome = { detail: string; ok: true } | { message: string; ok: false };

export type Failure = { error: string } | { reverted: string };
export type Answer = Failure | { value: unknown };

// How the clients word a call the EVM ended, from a revert to an exceptional halt: geth and Erigon
// ("invalid opcode: INVALID", "stack limit reached"), revm ("EVM error: InvalidFEOpcode"), Nethermind
// ("invalid instruction"), Besu ("INVALID_OPERATION", "INSUFFICIENT_STACK_ITEMS")
const EVM_FAILURE = new RegExp(
  [
    "revert",
    "invalid[\\s_]*(?:fe[\\s_]*)?(?:opcode|operation|instruction)",
    "bad[\\s_]*instruction",
    "opcode[\\s_]*not[\\s_]*found",
    "out[\\s_]*of[\\s_]*gas",
    "insufficient[\\s_]*gas",
    "stack[\\s_]*(?:under|over)flow",
    "stack[\\s_]*limit[\\s_]*reached",
    "(?:too[\\s_]*many|insufficient)[\\s_]*stack[\\s_]*items",
    "invalid[\\s_]*jump",
    "write[\\s_]*protection",
    "static[\\s_]*call[\\s_]*violation",
    "state[\\s_]*change[\\s_]*during[\\s_]*static[\\s_]*call",
    "illegal[\\s_]*state[\\s_]*change",
  ].join("|"),
  "i",
);
// What ethers raises once the call has left: the node failed it, the way to the node failed, or the
// address answered no data, as one without code at this block does. Any other error comes before
// sending, from arguments the config gives that do not encode
const SENT = new Set(["BAD_DATA", "CALL_EXCEPTION", "NETWORK_ERROR", "SERVER_ERROR", "TIMEOUT", "UNKNOWN_ERROR"]);

/**
 * A failed read, sorted by who ended it. Only the EVM reverts: ethers reports every eth_call error
 * as CALL_EXCEPTION, so a node without the state at a pinned block would read as a revert unless
 * the revert data or the node's own message shows that the EVM ended the call.
 */
export function failedCall(error: unknown): Failure {
  const { code, data, info } = error as { code?: unknown; data?: unknown; info?: { error?: { message?: unknown } } };
  const nodeMessage = info?.error?.message;
  // without revert data ethers says "missing revert data" whatever the node said, and an empty "0x"
  // varies by backend; the node names the cause the same way on both
  const empty = typeof data !== "string" || data === "0x";
  const text = empty && typeof nodeMessage === "string" ? nodeMessage : printError(error);
  if (code === "CALL_EXCEPTION" && (typeof data === "string" || EVM_FAILURE.test(String(nodeMessage ?? "")))) {
    return { reverted: text };
  }
  return { error: SENT.has(String(code)) ? text : `not sent: ${text}` };
}

/** The log line for a read that did not return a value. */
export function describeFailure(answer: Failure): string {
  return "reverted" in answer ? `REVERTED with: ${answer.reverted}` : `FAILED with: ${answer.error}`;
}

export abstract class SectionValidatorBase {
  /** Checks the run supplies rather than the config declares, e.g. the `null` coverage of an implementation ABI. */
  protected undeclared: ReadonlySet<string> = new Set();
  /** What argumentless reads answered, so that the enumeration expansion does not read a count twice. */
  protected answers = new Map<string, Answer>();

  constructor(
    protected provider: JsonRpcProvider,
    protected sectionName: EntryField,
    protected chainId: ChainId,
  ) {}

  public abstract validateSection(
    contractEntry: ContractEntry,
    contractAlias: string,
    basePath?: string,
  ): Promise<void>;

  /**
   * One check: counted once, logged once, and any failure attributed to this contract. A section
   * that routes everything through here cannot drift its tally from what actually ran, and a
   * check that could not be made fails by default instead of passing by silence.
   */
  protected async _check(label: string, run: () => Promise<CheckOutcome>): Promise<void> {
    incChecks();
    const logHandle = new LogCommand(label);
    setErrorContext({ method: label });

    let outcome: CheckOutcome;
    try {
      outcome = await run();
    } catch (error) {
      outcome = { message: `FAILED with: ${printError(error)}`, ok: false };
    }

    if (outcome.ok) {
      logHandle.success(outcome.detail);
      return;
    }
    logHandle.failure(outcome.message);
    incErrors(outcome.message);
  }

  /**
   * For proxy contracts, the checks run against the implementation ABI
   * since the proxy delegates calls to the implementation.
   */
  protected _loadContractAbi(contractEntry: ContractEntry): Abi {
    const implementation = isTypeOfTB(contractEntry, ProxyContractEntryTB) ? contractEntry.implementation : undefined;
    return loadAbiFromFile(this.chainId, contractEntry.name, implementation ?? contractEntry.address);
  }

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
      incSkipped();
      logMethodSkipped(method);
      // `null` declines to assert a value, not to look: with --observed the run still records what
      // the chain answered for every read the config declares
      if (context.observedPath && !this.undeclared.has(method)) {
        await this._recordOnly(contract, method, staticCallResult);
      }
      return;
    }
    incChecks();

    const { args, result: expected, signature = method } = staticCallResult;

    const argumentsString = args ? `(${args.toString()})` : "";
    const logHandle = new LogCommand(`.${signature}${argumentsString}`);
    setErrorContext({ method: `${signature}${argumentsString}` });

    let contractFunction: ReturnType<typeof contract.getFunction>;
    try {
      contractFunction = contract.getFunction(signature);
    } catch (error) {
      const errorMessage = printError(error);
      logHandle.failure(errorMessage);
      incErrors(errorMessage);
      return;
    }
    let actual: unknown;
    try {
      actual = await contractFunction.staticCall(...(args || ""));
    } catch (error) {
      const answer = await this._failed(error);
      this._answer(method, signature, args, answer);
      const errorMessage = describeFailure(answer);
      logHandle.failure(errorMessage);
      incErrors(errorMessage);
      return;
    }
    this._answer(method, signature, args, { value: actual });
    try {
      _assertEqual(actual, expected);
      logHandle.success(_stringify(actual));
    } catch (error) {
      const errorMessage = printError(error);
      logHandle.failure(errorMessage);
      incErrors(errorMessage);
    }
  }

  /** Read a check the config declines to assert, for the observed file alone. */
  protected async _recordOnly(contract: Contract, method: string, entry: StaticCallResult) {
    const { args, signature = method } = entry;
    let contractFunction: ReturnType<typeof contract.getFunction>;
    try {
      contractFunction = contract.getFunction(signature);
      // `balanceOf: null` names no account, and a bare overloaded name names no function: a call
      // would record ethers' complaint as a revert
      if (contractFunction.fragment.inputs.length !== (args?.length ?? 0)) return;
    } catch {
      return;
    }
    const label = `${signature}${args ? `(${args.toString()})` : ""}`;
    setErrorContext({ method: label });
    try {
      this._answer(method, signature, args, { value: await contractFunction.staticCall(...(args || "")) });
    } catch (error) {
      const answer = await this._failed(error);
      this._answer(method, signature, args, answer);
      // nothing asserts this read, so the log and the report are the only place a node failure shows
      if ("error" in answer) new LogCommand(`.${label}`).warning(`not read: the call ${describeFailure(answer)}`);
    }
  }

  /** A failed read. Under --block, a node error may mean the RPC dropped the pinned state, which stops the run. */
  protected async _failed(error: unknown): Promise<Failure> {
    const answer = failedCall(error);
    const provider = this.provider as RetryingJsonRpcProvider;
    if ("error" in answer && provider.pinned) await assertPinnedState(provider, true);
    return answer;
  }

  private _answer(method: string, signature: string, args: readonly unknown[] | undefined, answer: Answer) {
    recordObservedCall(currentErrorContext, signature, args, answer);
    if (!args?.length) this.answers.set(method, answer);
  }

  protected async _checkViewMustRevert(contract: Contract, method: string, staticCallMustRevert: StaticCallMustRevert) {
    incChecks();
    const { args, signature = method } = staticCallMustRevert;

    const argumentsString = args ? `(${args.toString()})` : "";
    const logHandle = new LogCommand(`.${signature}${argumentsString}`);
    setErrorContext({ method: `${signature}${argumentsString}` });

    let contractFunction: ReturnType<typeof contract.getFunction>;
    try {
      contractFunction = contract.getFunction(signature);
    } catch (error) {
      const errorMessage = printError(error);
      logHandle.failure(errorMessage);
      incErrors(errorMessage);
      return;
    }
    try {
      const actual: unknown = await contractFunction.staticCall(...(args || ""));
      this._answer(method, signature, args, { value: actual });
      const errorMessage = `Expected revert but got: ${_stringify(actual)}`;
      logHandle.failure(errorMessage);
      incErrors(errorMessage);
    } catch (error) {
      const answer = await this._failed(error);
      this._answer(method, signature, args, answer);
      // a node that refused the read has not shown that the function reverts
      if ("reverted" in answer) {
        logHandle.success(describeFailure(answer));
      } else {
        const errorMessage = `Expected revert but the call ${describeFailure(answer)}`;
        logHandle.failure(errorMessage);
        incErrors(errorMessage);
      }
    }
  }

  protected _reportNonCoveredNonMutableChecks(contractAlias: string, abi: Abi, checks: string[]) {
    const nonMutableFromAbi = getNonMutables(abi);
    const nonCovered = nonMutableFromAbi
      .filter((x) => !checks.includes(x.name))
      .map((x) => x.name || x) as AbiArgumentsLength;
    if (nonCovered.length > 0) {
      const errorMessage = `Section ${contractAlias} ${this.sectionName} does not cover these non-mutable function from ABI: ${chalk.red(nonCovered.join(", "))}`;
      logError(errorMessage);
      incErrors(`Non-covered functions: ${nonCovered.join(", ")}`);
    }
  }
}

export function _stringify(value: unknown) {
  return value instanceof Object ? JSON.stringify(value) : String(value);
}

function _assertEqual(actual: unknown, expected: ViewResult, errorMessage?: string) {
  if (Array.isArray(expected)) {
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
    const errorMessageDetailed = `${errorMessage} but fields "${field}" differ`;
    if (actualValue instanceof Result && Array.isArray(expectedValue as unknown)) {
      actualValue = actualValue.toArray();
    }
    _assertEqual(actualValue, expectedValue, errorMessageDetailed);
  }
}

function toBigIntIfPossible(value: unknown): bigint | unknown {
  if (typeof value === "string" || typeof value === "number") {
    try {
      return BigInt(value);
    } catch {
      return value;
    }
  }
  return value;
}

function _equalOrThrow(actual: unknown, expected: unknown, errorMessage?: string) {
  if (toBigIntIfPossible(actual) === toBigIntIfPossible(expected)) {
    return;
  }

  if (!errorMessage) {
    errorMessage = `Expected "${_stringify(expected)}" to equal actual "${_stringify(actual)}"`;
  }
  throw new AssertionError(errorMessage);
}
