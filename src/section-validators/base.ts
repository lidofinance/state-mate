import { BaseContract, JsonRpcProvider } from "ethers";
import { printError } from "../common";
import { LogCommand, logErrorAndExit, logMethodSkipped } from "../logger";
import { assertEqual, stringify } from "../statements-functions";
import {
  ContractEntry,
  isTypeOfTB,
  StaticCallCheck,
  StaticCallMustRevert,
  StaticCallMustRevertTB,
  StaticCallResult,
  StaticCallResultTB,
} from "../typebox";

export let g_errors: number = 0;

export function incErrors(): void {
  g_errors += 1;
}

export abstract class SectionValidatorBase {
  constructor(protected provider: JsonRpcProvider) {}

  public abstract validateSection(contractEntry: ContractEntry): Promise<void>;

  protected async _checkViewFunction(contract: BaseContract, method: string, staticCallCheck: StaticCallCheck) {
    if (isTypeOfTB(staticCallCheck, StaticCallResultTB)) {
      await this._checkViewResult(contract, method, staticCallCheck);
    } else if (isTypeOfTB(staticCallCheck, StaticCallMustRevertTB)) {
      await this._checkViewMustRevert(contract, method, staticCallCheck);
    } else {
      logErrorAndExit(`Unknown static call check type: ${JSON.stringify(staticCallCheck)}`);
    }
  }

  protected async _checkViewResult(contract: BaseContract, method: string, staticCallResult: StaticCallResult) {
    if (staticCallResult.result === null) {
      logMethodSkipped(method);
      return;
    }

    const { args, result: expected, signature = method } = staticCallResult;

    const argsStr = args ? `(${args.toString()})` : "";
    const logHandle = new LogCommand(`.${signature}${argsStr}`);

    try {
      const actual: unknown = await contract.getFunction(signature).staticCall(...(args || ""));
      assertEqual(actual, expected);
      logHandle.success(stringify(actual));
    } catch (error) {
      logHandle.failure(`REVERTED with: ${printError(error)}`);
      g_errors++;
    }
  }

  protected async _checkViewMustRevert(
    contract: BaseContract,
    method: string,
    staticCallMustRevert: StaticCallMustRevert,
  ) {
    const { args, signature = method } = staticCallMustRevert;

    const argsStr = args ? `(${args.toString()})` : "";
    const logHandle = new LogCommand(`.${signature}${argsStr}`);

    try {
      const actual: unknown = await contract.getFunction(signature).staticCall(...(args ?? ""));
      logHandle.failure(stringify(actual));
      g_errors++;
    } catch (error) {
      logHandle.success(`REVERTED with: ${printError(error)}`);
    }
  }
}
