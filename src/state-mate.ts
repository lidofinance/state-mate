import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import "dotenv/config";
import { expect } from "chai";
import { BaseContract, Contract, getAddress, isAddress, JsonRpcProvider, Result } from "ethers";
import * as YAML from "yaml";
import chalk from "chalk";

const SUCCESS_MARK = chalk.green("✔");
const FAILURE_MARK = chalk.red("✘");
const WARNING_MARK = chalk.yellow("⚠");

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: Unreachable code error
BigInt.prototype.toJSON = function (): number {
  return Number(this);
};

// Contract entry fields
enum Ef {
  name = "name",
  address = "address",
  checks = "checks",
  proxyChecks = "proxyChecks",
  implementationChecks = "implementationChecks",
  ozNonEnumerableAcl = "ozNonEnumerableAcl",
}

type ViewResultPlainValue = null | string | boolean | bigint;

type ArbitraryObject = Omit<{ [key: string]: ViewResultPlainValue }, "args" | "result">;

type ViewResult = ViewResultPlainValue | ArbitraryObject | never[];

type ArgsAndResult = {
  args: [string];
  result: ViewResult;
  mustRevert?: boolean;
  signature?: string;
  bigint?: boolean;
};

type ChecksEntryValue = ViewResult | ArgsAndResult | [ArgsAndResult];

type Checks = {
  [key: string]: ChecksEntryValue;
};

type OzNonEnumerableAcl = {
  [key: string]: [string];
};

type RegularContractEntry = {
  address: string;
  name: string;
  checks: Checks;
  ozNonEnumerableAcl?: OzNonEnumerableAcl;
};

type ProxyContractEntry = RegularContractEntry & {
  proxyName: string;
  implementation: string;
  proxyChecks: Checks;
  implementationChecks: Checks;
};

type NetworkSection = {
  rpcUrl: string;
  contracts: {
    [key: string]: ProxyContractEntry;
  };
};

type Abi = [
  {
    name: string;
    type: string;
    stateMutability: string;
  },
];

// ==== GLOBAL VARIABLES ====
let g_abiDirectory: string;
let g_errors = 0;

// ==========================

class LogCommand {
  private description: string;

  constructor(description: string) {
    this.description = description;
    this.initialPrint();
  }

  public printResult(success: boolean, result: string): void {
    const statusSymbol = success ? SUCCESS_MARK : FAILURE_MARK;
    process.stdout.cursorTo(0);
    process.stdout.clearLine(0);
    process.stdout.write(`${statusSymbol} ${this.description}: ${chalk.yellow(result)}\n`);
  }

  public success(result: string): void {
    this.printResult(true, result);
  }

  public failure(result: string): void {
    this.printResult(false, result);
  }

  private initialPrint(): void {
    const indent = "  "; // SUCCESS_MARK printed length
    process.stdout.write(`${indent}${this.description}: ...`);
  }
}

function loadAbi(contractName: string) {
  let path = `${g_abiDirectory}/${contractName}.json`;
  if (!existsSync(path)) {
    path = `${g_abiDirectory}/${contractName}.sol/${contractName}.json`;
  }
  const abi = JSON.parse(readFileSync(path).toString());
  return abi.abi ?? abi;
}

function loadStateFromYaml(stateFile: string) {
  const file = path.resolve(stateFile);
  const configContent = readFileSync(file).toString();
  const reviver = (_: unknown, v: unknown) => {
    return typeof v === "number" ? BigInt(v) : v;
  };
  return YAML.parse(configContent, reviver);
}

// Supports bigint as object values
function stringify(value: unknown) {
  if (value instanceof Object) {
    return JSON.stringify(value);
  } else {
    return `${value}`;
  }
}

async function loadContract(contractName: string, address: string, provider: JsonRpcProvider) {
  const abi = loadAbi(contractName);
  return new Contract(address, abi, provider);
}

function isUrl(maybeUrl: string) {
  try {
    new URL(maybeUrl);
    return true;
  } catch (_) {
    return false;
  }
}

function log(arg: unknown) {
  console.log(arg);
}

function logError(arg: unknown) {
  console.error(arg);
}

function logHeader1(arg: string) {
  const length = "=====  =====".length + arg.length;
  const middleLine = chalk.grey(`===== ${chalk.blueBright(arg)} =====`);
  const headerFooter = chalk.grey("=".repeat(length));
  log(`\n${headerFooter}\n${middleLine}\n${headerFooter}`);
}

function logHeader2(arg: unknown) {
  log(chalk.gray(`\n===== ${chalk.magenta(arg)} =====`));
}

function logMethodSkipped(methodName: string) {
  log(`${WARNING_MARK} .${methodName}: ${chalk.yellow("skipped")}`);
}

function getNonMutableFunctionNames(abi: Abi) {
  const result = [];
  for (const e of abi) {
    if (e.type == "function" && !["payable", "nonpayable"].includes(e.stateMutability)) {
      result.push(e.name);
    }
  }
  return result;
}

function reportNonCoveredNonMutableChecks(
  contractAlias: string,
  checksType: string,
  contractName: string,
  checks: string[],
) {
  const abi = loadAbi(contractName);
  const nonMutableFromAbi = getNonMutableFunctionNames(abi);
  const nonCovered = nonMutableFromAbi.filter((x) => !checks.includes(x));
  if (nonCovered.length) {
    logError(
      `Section ${contractAlias} ${checksType} does not cover these non-mutable function from ABI: ${chalk.red(nonCovered.join(", "))}`,
    );
    g_errors++;
  }
}

async function checkContractEntry(
  { address, name, checks, ozNonEnumerableAcl }: RegularContractEntry,
  provider: JsonRpcProvider,
) {
  expect(isAddress(address), `${address} is invalid address`).to.be.true;

  const contract: BaseContract = await loadContract(name, address, provider);
  for (const [method, checkEntryValue] of Object.entries(checks)) {
    if (checkEntryValue instanceof Array) {
      // In case of empty array we need to check it as a single entry
      if (checkEntryValue.length === 0) {
        await checkViewFunction(contract, method, checkEntryValue);
        continue;
      }

      // In case it is not an array of calls, check it as a single entry
      const isCall = checkEntryValue.some((x) => typeof x === "object" && "args" in x);
      if (!isCall) {
        await checkViewFunction(contract, method, checkEntryValue);
        continue;
      }

      // In case it is an array of calls, check each call
      for (const viewResultOrObject of checkEntryValue) {
        await checkViewFunction(contract, method, viewResultOrObject);
      }
    } else {
      await checkViewFunction(contract, method, checkEntryValue);
    }
  }

  if (ozNonEnumerableAcl) {
    logHeader2("Non-enumerable OZ Acl checks");
    for (const role in ozNonEnumerableAcl) {
      for (const holder of ozNonEnumerableAcl[role]) {
        const isRoleOnHolder = await contract.getFunction("hasRole").staticCall(role, holder);
        const logHandle = new LogCommand(`.hasRole(${role}, ${holder})`);
        try {
          expect(isRoleOnHolder).to.be.true;
          logHandle.success(`${isRoleOnHolder}`);
        } catch (error) {
          logHandle.failure(`REVERTED with: ${(error as Error).message}`);
          g_errors++;
        }
      }
    }
  }
}

function expectToEqualStruct(expected: null | ArbitraryObject, actual: Result) {
  if (expected === null) {
    return;
  }

  const actualAsObject = actual.toObject();
  const errorMessage = `expected ${stringify(actualAsObject)} to equal ${stringify(expected)}`;

  expect(Object.keys(actualAsObject).length, errorMessage).to.equal(Object.keys(expected).length);
  for (const field in actualAsObject) {
    const expectedValue = expected[field];
    if (expectedValue === null) {
      continue;
    }
    let actualValue = actualAsObject[field];
    const errorMessageDetailed = errorMessage + ` but fields "${field}" differ`;
    if (actualValue instanceof Result && (expectedValue as unknown) instanceof Array) {
      actualValue = actualValue.toArray();
    }
    expect(actualValue, errorMessageDetailed).to.deep.equal(expectedValue);
  }
}

async function checkViewFunction(contract: BaseContract, method: string, expectedOrObject: ChecksEntryValue) {
  // Skip check if expected is null
  if (expectedOrObject === null) {
    logMethodSkipped(method);
    return;
  }

  let expected: ViewResult;
  let args: unknown[] = [];
  let mustRevert: boolean = false;
  let signature: string = method;
  let bigint: boolean = false;

  if (typeof expectedOrObject === "object" && "args" in expectedOrObject && "result" in expectedOrObject) {
    ({
      args,
      result: expected,
      mustRevert = false,
      signature = method,
      bigint = false,
    } = expectedOrObject as ArgsAndResult);
  } else {
    expected = expectedOrObject as ViewResult;
  }

  const argsStr = args.length ? `(${args.toString()})` : "";
  const logHandle = new LogCommand(`.${signature}${argsStr}`);

  try {
    const actual = await contract.getFunction(signature).staticCall(...args);
    // console.log("actual", actual);
    // console.log("expected", expected);
    if (typeof expected === "string") {
      if (isAddress(expected)) {
        expect(getAddress(actual)).to.equal(getAddress(expected));
      } else if (bigint) {
        expect(actual).to.equal(BigInt(expected));
      } else {
        expect(actual).to.equal(expected);
      }
    } else if (Array.isArray(expected)) {
      expect(actual).to.deep.equal(expected);
    } else if (typeof expected === "object") {
      expectToEqualStruct(expected, actual);
    } else {
      expect(actual).to.equal(expected);
    }
    logHandle.success(stringify(actual));
  } catch (error) {
    const errorMessage = `REVERTED with: ${(error as Error).message}`;
    if (mustRevert) {
      logHandle.success(errorMessage);
    } else {
      logHandle.failure(errorMessage);
      g_errors++;
    }
  }
}

async function checkNetworkSection(section: NetworkSection, sectionTitle: string) {
  if (!section) {
    log(`Network section ${sectionTitle} is empty, skipped`);
    return;
  }

  const rpcUrl = isUrl(section.rpcUrl) ? section.rpcUrl : process.env[section.rpcUrl];
  if (!(rpcUrl && isUrl(rpcUrl))) {
    logError(`ERROR: Invalid RPC URL ${rpcUrl} is specified via env variable ${section.rpcUrl}`);
    process.exit(1);
  }

  const provider = new JsonRpcProvider(rpcUrl);
  for (const contractAlias in section.contracts) {
    const entry = section.contracts[contractAlias];
    logHeader1(`Contract (${sectionTitle}): ${contractAlias} (${entry.name}, ${entry.address})`);

    reportNonCoveredNonMutableChecks(contractAlias, Ef.checks, entry.name, Object.keys(entry.checks));
    if (entry.proxyName) {
      reportNonCoveredNonMutableChecks(contractAlias, Ef.proxyChecks, entry.proxyName, Object.keys(entry.proxyChecks));
    }

    if (Ef.checks in entry) {
      logHeader2(Ef.checks);
      await checkContractEntry(
        {
          checks: entry[Ef.checks],
          name: entry.name,
          address: entry.address,
        },
        provider,
      );
    }

    if (Ef.proxyChecks in entry) {
      logHeader2(Ef.proxyChecks);
      await checkContractEntry(
        {
          checks: entry[Ef.proxyChecks],
          name: entry.proxyName,
          address: entry.address,
        },
        provider,
      );
    }

    if (entry.implementationChecks) {
      logHeader2(Ef.implementationChecks);
      // For implementation by default skip all checks
      const allNonMutable = getNonMutableFunctionNames(loadAbi(entry.name));
      const skippedChecks: Checks = {};
      allNonMutable.reduce((acc, x)=> (acc[x] = null, acc), skippedChecks);
      await checkContractEntry(
        {
          checks: { ...skippedChecks, ...entry[Ef.implementationChecks] },
          name: entry.name,
          address: entry.implementation,
        },
        provider,
      );
    }
  }
}

function parseCommandLineArgs(argv: string[]) {
  if (argv.length != 3) {
    logError(`ERROR: Invalid number of arguments. Expected: <path-to-state-config-yaml>.
The "abi" directory is expected to be located nearby.`);
    process.exit(1);
  }
  const firstArg = argv[2];
  if (["--help", "-h"].includes(firstArg)) {
    log(`TODO`);
    process.exit(0);
  }
  const configPath = argv[2];
  return {
    configPath,
    abiDirPath: path.join(path.dirname(configPath), "abi"),
  };
}

export async function main() {
  const { configPath, abiDirPath } = parseCommandLineArgs(process.argv);
  g_abiDirectory = abiDirPath;

  const state = loadStateFromYaml(configPath);

  logHeader1(`Used state config: ${chalk.magenta(configPath)}`);

  await checkNetworkSection(state.l1, "L1");

  await checkNetworkSection(state.l2, "L2");

  if (g_errors) {
    logError(`\n${FAILURE_MARK} ${chalk.bold(`${g_errors} errors found!`)}`);
    process.exit(1);
  }
}

main().catch((error) => {
  logError(error);
  process.exitCode = 1;
});
