// import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import https from 'https';
import http from 'http';

import "dotenv/config";
import { assert } from "chai";
import { BaseContract, Contract, isAddress, JsonRpcProvider, Result } from "ethers";
import * as YAML from "yaml";
import chalk from "chalk";
import { program } from "commander";

const SUCCESS_MARK = chalk.green("✔");
const FAILURE_MARK = chalk.red("✘");
const WARNING_MARK = chalk.yellow("⚠");
const REPLACE_ME_PLACEHOLDER = "REPLACEME";
const YML = "yml";

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
  result = "result",
  contracts = "contracts",
  explorerHostname = "explorerHostname",
  explorerTokenEnv = "explorerTokenEnv",
  rpcUrl = "rpcUrl",
}

enum CheckLevel {
  section = "section",
  contract = "contract",
  checksType = "checksType",
  method = "method",
}

type ViewResultPlainValue = null | string | boolean | bigint;

type ArbitraryObject = Omit<{ [key: string]: ViewResultPlainValue }, "args" | "result">;

type ViewResult = ViewResultPlainValue | ArbitraryObject;

type ArgsResult = {
  args: [string];
  result: ViewResult;
  mustRevert?: boolean;
  signature?: string;
  bigint?: boolean;
};

type ChecksEntryValue = ViewResult | [ArgsResult];

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
    inputs: unknown[];
  },
];

type CheckOnlyOptionType = null | { section: string, contract: string | null, checksType: string | null, method: string | null };

type ContractInfoFromExplorer = {
  contractName: string,
  abi: Abi,
  address: string,
  implementation: null | {
    contractName: string,
    abi: Abi,
    address: string,
  }
};

type YamlDoc = ReturnType<typeof YAML.parseDocument> | YAML.Document;

type DeployedAddressInfo = {
  deployedNode: YAML.Scalar,
  sectionName: string,
  address: string,
  rpcUrl: string,
  explorerHostname: string,
  explorerKey?: string,
};


// ==== GLOBAL VARIABLES ====
let g_Args: ReturnType<typeof parseCmdLineArgs>;
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

function getAbiFileName(contractName: string, address?: string) {
  return address ? `${contractName}-${address}.json` : `${contractName}.json`;
}

function loadAbiFromFile(contractName?: string, address?: string) {
  let abiPath = "";
  if (contractName && address && g_Args.generate) {
    abiPath = path.join(g_Args.abiDirPath, getAbiFileName(contractName, address));
  }
  else if (contractName) {
      abiPath = path.join(g_Args.abiDirPath, `${contractName}.json`);
      if (!fs.existsSync(abiPath)) {
        abiPath = `${g_Args.abiDirPath}/${contractName}.sol/${contractName}.json`;
      }
      if (!fs.existsSync(abiPath)) {
        abiPath = path.join(g_Args.abiDirPath, getAbiFileName(contractName, address));
      }
  } else {
    assert(address);
    const abiDirContent = fs.readdirSync(g_Args.abiDirPath);
    let abiFileName = "";
    for (const fileName of abiDirContent) {
      if (fileName.split("-")[1] === `${address}.json`) {
        abiFileName = fileName;
        break;
      }
    }
    if (!abiFileName) {
      logErrorAndExit(`Cannot find ABI file for address ${address} in ${g_Args.abiDirPath}`);
    }
    abiPath = path.join(g_Args.abiDirPath, abiFileName);
  }
  const abiFileContent = fs.readFileSync(abiPath, "utf-8");
  assert(abiFileContent);
  const abi = JSON.parse(abiFileContent);
  return abi.abi ?? abi;
}

function loadStateFromYaml(stateFile: string) {
  const file = path.resolve(stateFile);
  const configContent = fs.readFileSync(file, 'utf-8');
  const reviver = (_: unknown, v: unknown) => {
    return typeof v === "bigint" ? String(v) : v;
  };

  const config = YAML.parse(configContent, reviver, { schema: "core", intAsBigInt: true });
  return config;
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
  const abi = loadAbiFromFile(contractName, address);
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

function needCheck(level: CheckLevel, name: string) {
  if (g_Args.checkOnly === null) {
    return true;
  }
  const checkOnTheLevel = g_Args.checkOnly[level];
  return checkOnTheLevel === null || checkOnTheLevel === undefined || name === checkOnTheLevel;
}

function log(arg: unknown) {
  console.log(arg);
}

function logError(arg: unknown) {
  console.error(`ERROR: ${arg}`);
}

function logErrorAndExit(arg: unknown) {
  logError(arg);
  process.exit(1);
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

async function sleep(timeoutMs: number) {
  await new Promise(resolve => setTimeout(resolve, timeoutMs));
}

function getNonMutables(abi: Abi) {
  const result: { name: string, numArgs: number }[] = [];
  for (const e of abi) {
    if (e.type == "function" && !["payable", "nonpayable"].includes(e.stateMutability)) {
      result.push({ name: e.name, numArgs: e.inputs.length});
    }
  }
  return result;
}

async function makeBoilerplateForAllNonMutableFunctions(abi: Abi, contract: Contract) {
  const nonMutables = getNonMutables(abi);
  const result: { [key: string]: YAML.Scalar } = {};
  for (const methodInfo of nonMutables) {
    const value = new YAML.Scalar(REPLACE_ME_PLACEHOLDER);
    const view = contract.getFunction(methodInfo.name);
    value.comment = methodInfo.numArgs > 0
      ? ` need to specify args`
      : ` ${await view.staticCall()}`;
    result[methodInfo.name] = value;
  }
  return result;
}

function reportNonCoveredNonMutableChecks(
  contractAlias: string,
  checksType: string,
  contractName: string,
  checks: string[],
) {
  const abi = loadAbiFromFile(contractName);
  const nonMutableFromAbi = getNonMutables(abi);
  const nonCovered = nonMutableFromAbi.filter((x) => !checks.includes(x.name));
  if (nonCovered.length) {
    logError(
      `Section ${contractAlias} ${checksType} does not cover these non-mutable function from ABI: ${chalk.red(nonCovered.join(", "))}`,
    );
    g_errors++;
  }
}

function parseAsArgsResultsArray(entry: ChecksEntryValue): [ArgsResult] | null {
  if (entry instanceof Array && entry.length > 0 && entry[0].args instanceof Array && Ef.result in entry[0]) {
    return entry
  }
  return null;
}

async function checkContractEntry(
  { address, name, checks, ozNonEnumerableAcl }: RegularContractEntry,
  provider: JsonRpcProvider,
) {
  assert(isAddress(address), `${address} is invalid address`);
  const contract = await loadContract(name, address, provider);
  for (const [method, checkEntryValue] of Object.entries(checks)) {
    if (!needCheck(CheckLevel.method, method)) {
      continue;
    }
    const argsResultsArray = parseAsArgsResultsArray(checkEntryValue)
    if (argsResultsArray === null) {
      await checkViewFunction(contract, method, checkEntryValue as unknown as ArgsResult);
    } else {
      for (const argsResult of argsResultsArray) {
        await checkViewFunction(contract, method, argsResult);
      }
    }
  }

  if (ozNonEnumerableAcl) {
    logHeader2("Non-enumerable OZ Acl checks");
    for (const role in ozNonEnumerableAcl) {
      for (const holder of ozNonEnumerableAcl[role]) {
        const isRoleOnHolder = await contract.getFunction("hasRole").staticCall(role, holder);
        const logHandle = new LogCommand(`.hasRole(${role}, ${holder})`);
        try {
          assert(isRoleOnHolder);
          logHandle.success(`${isRoleOnHolder}`);
        } catch (error) {
          logHandle.failure(`REVERTED with: ${(error as Error).message}`);
          g_errors++;
        }
      }
    }
  }
}

function assertEqual(actual: unknown, expected: ViewResult, errorMessage?: string) {
  if (typeof actual === "bigint") {
    assert(typeof expected === "string" || typeof expected === "bigint");
    assert.strictEqual(actual, BigInt(expected), errorMessage);
  } else if (Array.isArray(expected)) {
    assert.strictEqual((actual as unknown[]).length, expected.length,
      `Array length differ: actual = '${actual}', expected = '${expected}'`);
    if (!errorMessage) {
      errorMessage = `Actual value '${actual} is not equal to expected array '[${expected}]`;
    }
    for (let i = 0; i < (actual as unknown[]).length; ++i) {
      assertEqual((actual as unknown[])[i], expected[i], errorMessage);
    }
  } else if (typeof expected === "object") {
    assertEqualStruct(expected, actual as Result);
  } else {
    assert.strictEqual(actual, expected, errorMessage);
  }
}

function assertEqualStruct(expected: null | ArbitraryObject, actual: Result) {
  if (expected === null) {
    return;
  }

  const actualAsObject = actual.toObject();
  const errorMessage = `expected ${stringify(actualAsObject)} to equal ${stringify(expected)}`;

  assert.strictEqual(Object.keys(actualAsObject).length, Object.keys(expected).length, errorMessage);
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
    assertEqual(actualValue, expectedValue, errorMessageDetailed);
  }
}

async function checkViewFunction(contract: BaseContract, method: string, expectedOrObject: ArgsResult) {
  // Skip check if expected is null
  if (expectedOrObject === null) {
    logMethodSkipped(method);
    return;
  }

  let expected: ViewResult;
  let args: unknown[] = [];
  let mustRevert: boolean = false;
  let signature: string = method;

  if (typeof expectedOrObject === "object" && "args" in expectedOrObject && "result" in expectedOrObject) {
    ({
      args,
      result: expected,
      mustRevert = false,
      signature = method,
    } = expectedOrObject as ArgsResult);
  } else {
    expected = expectedOrObject as ViewResult;
  }

  const argsStr = args.length ? `(${args.toString()})` : "";
  const logHandle = new LogCommand(`.${signature}${argsStr}`);

  try {
    const actual = await contract.getFunction(signature).staticCall(...args);

    assertEqual(actual, expected);

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

function readUrlOrFromEnv(urlOrEnvVarName: string) {
  if (isUrl(urlOrEnvVarName)) {
    return urlOrEnvVarName;
  } else {
    const valueFromEnv = process.env[urlOrEnvVarName] || "";
    if (!isUrl(valueFromEnv)) {
      logErrorAndExit(`Value "${valueFromEnv}" from env var "${urlOrEnvVarName}" is not a valid RPC url`);
    }
    return valueFromEnv;
  }
}

async function checkNetworkSection(state: { [key: string]: unknown }, sectionTitle: string) {
  if (g_Args.checkOnly && g_Args.checkOnly.section !== sectionTitle) {
    return;
  }

  const section = state[sectionTitle] as NetworkSection;

  if (!section) {
    log(`Network section ${sectionTitle} is empty, skipped`);
    return;
  }

  const rpcUrl = readUrlOrFromEnv(section.rpcUrl);
  if (!(rpcUrl && isUrl(rpcUrl))) {
    logErrorAndExit(`Invalid RPC URL ${rpcUrl} is specified via env variable ${section.rpcUrl}`);
  }

  const provider = new JsonRpcProvider(rpcUrl);
  for (const contractAlias in section.contracts) {
    if (!needCheck(CheckLevel.contract, contractAlias)) {
      continue;
    }
    const entry = section.contracts[contractAlias];
    logHeader1(`Contract (${sectionTitle}): ${contractAlias} (${entry.name}, ${entry.address})`);

    if (Ef.checks in entry && needCheck(CheckLevel.checksType, Ef.checks)) {
      logHeader2(Ef.checks);

      reportNonCoveredNonMutableChecks(contractAlias, Ef.checks, entry.name, Object.keys(entry[Ef.checks]));

      await checkContractEntry(
        {
          checks: entry[Ef.checks],
          name: entry.name,
          address: entry.address,
        },
        provider,
      );
    }

    if (Ef.proxyChecks in entry && needCheck(CheckLevel.checksType, Ef.proxyChecks)) {
      logHeader2(Ef.proxyChecks);
      reportNonCoveredNonMutableChecks(contractAlias, Ef.proxyChecks, entry.proxyName, Object.keys(entry.proxyChecks));
      await checkContractEntry(
        {
          checks: entry[Ef.proxyChecks],
          name: entry.proxyName,
          address: entry.address,
        },
        provider,
      );
    }

    if (Ef.implementationChecks in entry && needCheck(CheckLevel.checksType, Ef.implementationChecks)) {
      logHeader2(Ef.implementationChecks);
      // For implementation by default skip all checks
      const allNonMutable = getNonMutables(loadAbiFromFile(entry.name));
      const skippedChecks: Checks = {};
      allNonMutable.reduce((acc, x)=> (acc[x.name] = null, acc), skippedChecks);
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

function httpGetAsync(url: string) {
  return new Promise((resolve, reject) => {
    https.get(url, (response: http.IncomingMessage) => {
      let data = '';

      // A chunk of data has been received.
      response.on('data', (chunk) => {
        data += chunk;
      });

      // The whole response has been received.
      response.on('end', () => {

        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP status code ${response.statusCode}`));
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function loadContractInfoFromExplorer(address: string, explorerHostname: string, explorerKey?: string): Promise<ContractInfoFromExplorer> {
  let sourcesUrl = `https://${explorerHostname}/api?module=contract&action=getsourcecode&address=${address}`;
  if (explorerKey) {
    sourcesUrl = `${sourcesUrl}&apikey=${explorerKey}`;
  }
  let sourcesResponse = JSON.parse(await httpGetAsync(sourcesUrl) as string);
  if (sourcesResponse.message.indexOf("rate limit") > -1) {
    log(`Reached rate limit ${explorerHostname}, waiting for 5 seconds...`);
    await sleep(5000);
    sourcesResponse = JSON.parse(await httpGetAsync(sourcesUrl) as string);
  }
  if (sourcesResponse.message != "OK") {
    // TODO: error, but check ContractName instead
    logErrorAndExit(`Failed to download from ${explorerHostname}: ${sourcesResponse.message}\n${JSON.stringify(sourcesResponse, null, 2)}`);
  }
  const contractInfo = sourcesResponse.result[0]
  const contractName = contractInfo["ContractName"];
  const abi = JSON.parse(contractInfo["ABI"]) as Abi;
  let implementation = null;
  const implementationAddress = contractInfo["Implementation"];
  if (implementationAddress) {
    implementation = await loadContractInfoFromExplorer(implementationAddress, explorerHostname, explorerKey);
  }

  return { contractName, abi, address, implementation };
}

async function iterateDeployedAddresses(doc: YamlDoc, callback: (ctx: DeployedAddressInfo) => void) {
  const deployedSection = doc.get("deployed") as YAML.YAMLMap;
  const deployedSectionEntries = deployedSection.items as YAML.Pair<YAML.Scalar, YAML.YAMLMap>[];
  for (const deployedSectionNode of deployedSectionEntries) {
    const sectionName = deployedSectionNode.key.value as string;

    const explorerTokenEnv = doc.getIn([`${sectionName}`, Ef.explorerTokenEnv]) as string;
    const explorerHostname = doc.getIn([`${sectionName}`, Ef.explorerHostname]) as string;
    const rpcUrl = readUrlOrFromEnv(doc.getIn([`${sectionName}`, Ef.rpcUrl]) as string);
    const explorerKey = process.env[explorerTokenEnv];
    for (const deployedNode of (deployedSectionNode.value as YAML.YAMLMap).items) {
      const address = deployedNode.value as string;

      await callback({
        deployedNode: deployedNode as unknown as YAML.Scalar,
        sectionName,
        address,
        explorerHostname,
        explorerKey,
        rpcUrl,
      });
    }
  }
}

async function downloadAndSaveAbis(configPath: string) {
  const doc = YAML.parseDocument(fs.readFileSync(configPath, "utf-8"));
  const abiDirPath = path.join(path.dirname(configPath), "abi");
  if (!fs.existsSync(abiDirPath)) {
    fs.mkdirSync(abiDirPath);
  }

  function writeAbi(contractName: string, address: string, abi: Abi) {
    const abiPath = path.join(abiDirPath, getAbiFileName(contractName, address));
    if (fs.existsSync(abiPath)) {
      log(`ABI already exists: ${abiPath}`);
    } else {
      fs.writeFileSync(abiPath, JSON.stringify(abi, null, 2));
      log(`Saved ABI to ${abiPath}`);
    }
  }

  await iterateDeployedAddresses(doc, async (ctx: DeployedAddressInfo) => {
    const address = ctx.deployedNode.value as string;
    const { abi, contractName, implementation } = await loadContractInfoFromExplorer(address, ctx.explorerHostname, ctx.explorerKey);
    if (implementation) {
      writeAbi(contractName, address, abi);
      writeAbi(implementation.contractName, address, implementation.abi);
      writeAbi(implementation.contractName, implementation.address, implementation.abi);
    } else {
      writeAbi(contractName, address, abi);
    }
  });
}

async function generateBoilerplate(seedConfigPath: string) {
  const seedDoc = YAML.parseDocument(fs.readFileSync(seedConfigPath, "utf-8"));

  const doc = new YAML.Document(seedDoc);

  await iterateDeployedAddresses(doc, async (ctx: DeployedAddressInfo) => {
    const address = ctx.deployedNode.value as string;
    const { contractName, implementation } = await loadContractInfoFromExplorer(address, ctx.explorerHostname, ctx.explorerKey);

    const provider = new JsonRpcProvider(ctx.rpcUrl);
    let contractEntryIfProxy = null;
    let contractEntryIfRegular = null;
    if (implementation) {
      const proxyAbi = loadAbiFromFile(contractName, address);
      const implementationAbi = loadAbiFromFile(implementation.contractName, implementation.address);
      const proxyContract = await loadContract(contractName, address, provider);
      const contract = await loadContract(implementation.contractName, address, provider);
      const implementationContract = await loadContract(implementation.contractName, implementation.address, provider);
      contractEntryIfProxy = {
        [Ef.name]: implementation.contractName,
        [Ef.address]: doc.createAlias(ctx.deployedNode),
        proxyName: contractName,
        implementation: implementation.address,
        [Ef.proxyChecks]: await makeBoilerplateForAllNonMutableFunctions(proxyAbi, proxyContract),
        [Ef.checks]: await makeBoilerplateForAllNonMutableFunctions(implementationAbi, contract),
        [Ef.implementationChecks]: await makeBoilerplateForAllNonMutableFunctions(implementationAbi, implementationContract),
      };
    } else {
      const abi = loadAbiFromFile(contractName, address);
      const contract = await loadContract(contractName, address, provider);
      contractEntryIfRegular = {
        name: contractName,
        address: doc.createAlias(ctx.deployedNode),
        checks: await makeBoilerplateForAllNonMutableFunctions(abi, contract),
      };
    }

    const sectionNode = doc.get(ctx.sectionName) as YAML.YAMLMap;
    const contractEntry = implementation ? contractEntryIfProxy : contractEntryIfRegular;
    sectionNode.addIn([Ef.contracts], {
      [ctx.deployedNode.anchor as string]: contractEntry,
    });
  });

  const generatedFilePath = path.join(path.dirname(seedConfigPath),
    `${path.basename(seedConfigPath, "."+YML)}.generated.${YML}`);
  fs.writeFileSync(generatedFilePath, doc.toString());
  log(`Generated state config: ${chalk.bold(generatedFilePath)}`);
}

async function doChecks(configPath: string) {
  const state = loadStateFromYaml(configPath);

  logHeader1(`Used state config: ${chalk.magenta(configPath)}`);

  for (const key of Object.keys(state)) {
    const section = state[key];
    if (section && section[Ef.rpcUrl] && section[Ef.contracts]) {
      await checkNetworkSection(state, key);
    }
  }

  if (g_errors) {
    logErrorAndExit(`\n${FAILURE_MARK} ${chalk.bold(`${g_errors} errors found!`)}`);
  }

  if (g_Args.checkOnly) {
    log(`\n${WARNING_MARK}${WARNING_MARK}${WARNING_MARK} Checks run only for "${chalk.bold(chalk.blue(g_Args.checkOnlyCmdArg))}"\n`);
  }
}

function parseCmdLineArgs() {
  program
    .argument("<config-path>", "path to .yaml state config file")
    .allowExcessArguments(false)
    .option("-o, --only <check-path>", `only checks to do, e.g. 'l2/proxyAdmin/${Ef.checks}/owner', 'l1', 'l1/controller'`)
    .option("--generate", "NB: currently, boilerplate generation only works with downloading ABIs from explorer")
    .option("--save-abi-from-explorer", "for addresses in 'deployed' section download ABIs to abi directory")
    .parse();

  const configPath = program.args[0];
  const options = program.opts();
  let checkOnly: CheckOnlyOptionType = null;
  if (options.only) {
    const checksPath = options.only.split("/");
    if (checksPath.length < 1 || checksPath.length > 4) {
      logErrorAndExit(`Invalid checkOnly argument format, must be <section>/[<contractName>]/[<checks|proxyChecks|implementationChecks>]/<method>`);
    }
    checkOnly = {
      section: checksPath[0],
      contract: checksPath[1],
      checksType: checksPath[2],
      method: checksPath[3],
    };
  }

  return {
    configPath,
    abiDirPath: path.join(path.dirname(configPath), "abi"),
    checkOnly,
    checkOnlyCmdArg: options.only,
    generate: options.generate,
    saveAbiFromExplorer: options.saveAbiFromExplorer,
  };
}

export async function main() {
  g_Args = parseCmdLineArgs();
  if (g_Args.saveAbiFromExplorer) {
    await downloadAndSaveAbis(g_Args.configPath);
  }
  if (g_Args.generate) {
    await generateBoilerplate(g_Args.configPath);
  } else {
    await doChecks(g_Args.configPath);
  }
}

main().catch((error) => {
  logError(error);
  process.exitCode = 1;
});
