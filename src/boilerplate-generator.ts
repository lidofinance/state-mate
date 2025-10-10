import fs from "node:fs";
import path from "node:path";

import "dotenv/config";

import chalk from "chalk";
import { Contract, JsonRpcProvider } from "ethers";
import * as YAML from "yaml";

import { loadAbiFromFile } from "./abi-provider";
import { getNonMutables, readUrlOrFromEnvironment, EntryField, printError } from "./common";
import { collectStaticCallResults, loadContract, loadContractInfoFromExplorer } from "./explorer-provider";
import { logErrorAndExit, log, logError } from "./logger";
import { g_Arguments as g_Arguments } from "./state-mate";
import { ContractEntry, EntireDocument, ExplorerSectionTB, isTypeOfTB, NetworkSection, SeedDocument } from "./typebox";
import { MethodCallResults, Abi } from "./types";

const REPLACE_ME_PLACEHOLDER = "REPLACEME";
const YML = "yml";
const MAIN_SCHEMA_NAME = "main-schema.json";

export async function doGenerateBoilerplate(seedConfigPath: string, jsonDocument: SeedDocument) {
  let seedYaml: unknown;
  try {
    const seedDocument = fs.readFileSync(seedConfigPath, "utf8");

    seedYaml = YAML.parseDocument(seedDocument);
  } catch (error) {
    logErrorAndExit(`Failed to read ${chalk.yellow(seedConfigPath)}\n: ${printError(error)}`);
  }
  const document = new YAML.Document(seedYaml);

  await _iterateDeployedAddresses(document, jsonDocument, async (context: DeployedAddressInfo) => {
    const { address, deployedNode, explorerHostname, rpcUrl, sectionName, explorerKey, chainId } = context;
    if (!explorerHostname) {
      logErrorAndExit(
        `The field ${chalk.magenta(`explorerHostname`)} is required in the ${chalk.magenta(g_Arguments.configPath)}`,
      );
    }
    const contractInfo = await loadContractInfoFromExplorer(address, explorerHostname, explorerKey, chainId);
    if (!contractInfo) {
      return;
    }
    const { contractName, implementation } = contractInfo;

    const provider = new JsonRpcProvider(rpcUrl);
    let contractEntryIfProxy;
    let contractEntryIfRegular;
    const logOperation = (section: EntryField) => {
      log(
        `Generating YAML for non-mutable function values for contract ${chalk.magenta(`${contractName}-${address}`)}, section ${chalk.yellow(section)} ...`,
      );
    };
    if (implementation) {
      const proxyAbi = loadAbiFromFile(contractName, address);
      const proxyContract = loadContract(address, proxyAbi, provider);

      const abi = loadAbiFromFile(implementation.contractName, address);
      const contract = loadContract(address, abi, provider);

      const implementationAbi = loadAbiFromFile(implementation.contractName, implementation.address);
      const implementationContract = loadContract(implementation.address, implementationAbi, provider);

      logOperation(EntryField.checks);
      const checks = await _makeBoilerplateForAllNonMutableFunctions(implementationAbi, contract);

      logOperation(EntryField.proxyChecks);
      const proxyChecks = await _makeBoilerplateForAllNonMutableFunctions(proxyAbi, proxyContract);

      logOperation(EntryField.implementationChecks);
      const implementationChecks = await _makeBoilerplateForAllNonMutableFunctions(
        implementationAbi,
        implementationContract,
      );
      contractEntryIfProxy = {
        [EntryField.name]: implementation.contractName,
        [EntryField.address]: document.createAlias(deployedNode),
        proxyName: contractName,
        implementation: implementation.address,
        [EntryField.proxyChecks]: proxyChecks,
        [EntryField.checks]: checks,
        [EntryField.implementationChecks]: implementationChecks,
      };
    } else {
      const abi = loadAbiFromFile(contractName, address);
      const contract = loadContract(address, abi, provider);
      logOperation(EntryField.checks);
      const checks = await _makeBoilerplateForAllNonMutableFunctions(abi, contract);
      contractEntryIfRegular = {
        name: contractName,
        address: document.createAlias(deployedNode),
        checks: checks,
      };
    }

    const sectionNode = document.get(sectionName) as YAML.YAMLMap;
    const contractEntry = implementation ? contractEntryIfProxy : contractEntryIfRegular;
    sectionNode.addIn([EntryField.contracts], new YAML.Pair(context.deployedNode.anchor, contractEntry));
  });

  const generatedFilePath = path.join(
    path.dirname(seedConfigPath),
    `${path.basename(seedConfigPath, "." + YML)}.generated.${YML}`,
  );
  writeGeneratedYaml(generatedFilePath, document.toString());
}

function writeGeneratedYaml(filePath: string, fileContent: string) {
  const generatedDocument = addSchemaIntoYaml(filePath, fileContent.toString());
  try {
    fs.writeFileSync(filePath, generatedDocument);
    log(`Generated state config: ${chalk.bold(filePath)}`);
  } catch (error) {
    logError(`Failed to write generated YAML-file ${chalk.yellow(filePath)}:\n${printError(error)}`);
  }
}

function addSchemaIntoYaml(filePath: string, fileContent: string): string {
  const schemaPath = path.join(path.dirname(__dirname), "schemas");
  const relativePathToMainSchema = path.join(path.relative(path.dirname(filePath), schemaPath), MAIN_SCHEMA_NAME);
  const regex = /\$schema=.*/;
  fileContent = regex.test(fileContent)
    ? fileContent.replace(regex, `$schema=${relativePathToMainSchema}`)
    : `# yaml-language-server: $schema=${relativePathToMainSchema}\n` + fileContent;

  return fileContent;
}

type DeployedAddressInfo = Pick<NetworkSection, "explorerHostname" | "rpcUrl" | "chainId"> &
  Pick<ContractEntry, "address"> & {
    [Key in keyof Pick<NetworkSection, "explorerTokenEnv"> as `explorerKey`]: string;
  } & { deployedNode: YAML.Scalar } & { sectionName: string };

async function _iterateDeployedAddresses<T extends EntireDocument | SeedDocument>(
  seedDocument: YAML.Document,
  jsonDocument: T,
  callback: (context: DeployedAddressInfo) => Promise<void>,
) {
  const abiDirectoryPath = path.resolve(path.dirname(g_Arguments.configPath), "abi");
  fs.mkdirSync(abiDirectoryPath, { recursive: true });

  for (const [explorerSectionKey, addresses] of Object.entries(jsonDocument.deployed)) {
    const explorerSection = jsonDocument[explorerSectionKey as keyof T];

    if (isTypeOfTB(explorerSection, ExplorerSectionTB)) {
      const { explorerHostname, explorerTokenEnv } = explorerSection;
      const rpcUrl = readUrlOrFromEnvironment(explorerSection.rpcUrl);
      const explorerKey = explorerTokenEnv ? process.env[explorerTokenEnv] : "";
      const scalars: YAML.Scalar[] = _getScalarsWithAnchors(seedDocument, explorerSectionKey);
      for (const address of addresses) {
        const deployedNode = scalars.find((scalar) => {
          return (scalar.value as string) === address;
        });
        if (deployedNode) {
          await callback({
            address,
            explorerHostname,
            explorerKey,
            rpcUrl,
            chainId: explorerSection.chainId,
            deployedNode,
            sectionName: explorerSectionKey,
          });
        } else {
          logErrorAndExit(`Couldn't to find the anchor for ${address} in the seed YAML file`);
        }
      }
    }
  }
}

function _getScalarsWithAnchors(document: YAML.Document, explorerSectionKey: string): YAML.Scalar[] {
  const section = document.getIn(["deployed", explorerSectionKey]);

  if (YAML.isSeq(section) && section.items.every((element) => YAML.isScalar(element))) {
    return section.items;
  }

  return [];
}

async function _makeBoilerplateForAllNonMutableFunctions(abi: Abi, contract: Contract) {
  const nonMutables = getNonMutables(abi);

  const staticCallsResults = await collectStaticCallResults(nonMutables, contract);

  const boilerplate = _makeBoilerplate(staticCallsResults);

  return boilerplate;
}

function _makeBoilerplate(methodCallResults: MethodCallResults): { [key: string]: YAML.Scalar } {
  const result: { [key: string]: YAML.Scalar } = {};

  for (const { methodName, staticCallResult } of methodCallResults) {
    const value = new YAML.Scalar(REPLACE_ME_PLACEHOLDER);
    value.comment = staticCallResult;
    result[methodName] = value;
  }

  return result;
}
