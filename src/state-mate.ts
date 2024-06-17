import { expect } from "chai";
import { BaseContract, Contract, getAddress, isAddress, JsonRpcProvider, Result } from "ethers";
import { readFileSync } from "fs";
import 'dotenv/config'
import path from "path";
import YAML from "yaml";

const SUCCESS_MARK = "✔";
const FAILURE_MARK = "❌";

// Contract entry fields
enum Ef {
  name = "name",
  address = "address",
  proxyChecks = "proxyChecks",
  checks = "checks",
  implementationChecks = "implementationChecks",
  ozNonEnumerableAcl = "ozNonEnumerableAcl",
}

type ViewResultPlainValue = null | string | boolean | bigint;

type ArbitraryObject = Omit<{ [key: string]: ViewResultPlainValue }, "args" | "result">;

type ViewResult = ViewResultPlainValue | ArbitraryObject;

type ArgsAndResult = { args: [string]; result: ViewResult; mustRevert?: boolean };

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
// ==========================

class LogCommand {
  private description: string;

  constructor(description: string) {
    this.description = description;
    this.initialPrint();
  }

  private initialPrint(): void {
    const indent = "  "; // SUCCESS_MARK printed length
    process.stdout.write(`${indent}${this.description}: ...`);
  }

  public printResult(success: boolean, result: string): void {
    const statusSymbol = success ? SUCCESS_MARK : FAILURE_MARK;
    process.stdout.cursorTo(0);
    process.stdout.clearLine(0);
    process.stdout.write(`${statusSymbol} ${this.description}: ${result}\n`);
  }

  public success(result: string): void {
    this.printResult(true, result);
  }

  public failure(result: string): void {
    this.printResult(false, result);
  }
}

function loadAbi(contractName: string) {
  return JSON.parse(readFileSync(`${g_abiDirectory}/${contractName}.json`).toString());
}

function loadStateFromYaml(stateFile: string) {
  const configContent = readFileSync(stateFile).toString();
  const reviver = (k: unknown, v: unknown) => {
    return typeof v === "number" ? BigInt(v) : v;
  };
  const state = YAML.parse(configContent, reviver);
  return state;
}

// Supports bigint as object values
function stringify(value: unknown) {
  if (value instanceof Object) {
    return JSON.stringify(
      value,
      (k, v) => {
        return typeof v == "bigint" ? parseInt(v.toString()) : v;
      },
      2,
    );
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

function logHeader1(arg: unknown) {
  const middleLine = `===== ${arg} =====`;
  const headerFooter = "=".repeat(middleLine.length);
  log(`\n${headerFooter}\n${middleLine}\n${headerFooter}`);
}

function logHeader2(arg: unknown) {
  log(`\n=== ${arg} ===`);
}

function logMethodSkipped(methodName: string) {
  log(`· ${methodName}: skipped`);
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
  const nonMutableFromAbi = getNonMutableFunctionNames(loadAbi(contractName));
  const nonCovered = nonMutableFromAbi.filter((x) => !checks.includes(x));
  if (nonCovered.length) {
    logError(
      `Section ${contractAlias} ${checksType} does not cover these non-mutable function from ABI: ${nonCovered}`,
    );
    process.exit(1);
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
  let expected: ViewResult;
  let args: unknown[] = [];
  let mustRevert: boolean = false;
  if (expectedOrObject === null) {
    logMethodSkipped(method);
    return;
  } else if (expectedOrObject instanceof Object && "args" in expectedOrObject && "result" in expectedOrObject) {
    expected = (expectedOrObject as ArgsAndResult).result;
    args = (expectedOrObject as ArgsAndResult).args;
    mustRevert = (expectedOrObject as ArgsAndResult).mustRevert || false;
  } else {
    expected = expectedOrObject as ViewResult;
  }

  const argsStr = args.length ? `(${args.toString()})` : "";
  const logHandle = new LogCommand(`.${method}${argsStr}`);

  let actual = undefined;
  try {
    actual = await contract.getFunction(method).staticCall(...args);
    if (typeof expected === "string" && isAddress(expected)) {
      expect(getAddress(actual)).to.equal(getAddress(expected));
    } else if (typeof expected === "object") {
      expectToEqualStruct(expected, actual);
    } else {
      expect(actual).to.equal(expected);
    }
    logHandle.success(stringify(actual));
  } catch (error) {
    if (mustRevert) {
      logHandle.success(`REVERTED with: ${(error as Error).message}`);
    } else {
      logHandle.failure(`REVERTED with: ${(error as Error).message}`);
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
      await checkContractEntry(
        {
          checks: entry[Ef.implementationChecks],
          name: entry.name,
          address: entry.implementation,
        },
        provider,
      );

      for (const methodName of getNonMutableFunctionNames(loadAbi(entry.name))) {
        logMethodSkipped(methodName);
      }
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

  logHeader1("Used state config:");
  // log(readFileSync(configPath).toString());

  await checkNetworkSection(state.l1, "L1");

  await checkNetworkSection(state.l2, "L2");
}

main().catch((error) => {
  logError(error);
  process.exitCode = 1;
});
