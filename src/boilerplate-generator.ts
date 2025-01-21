import fs from "node:fs";
import path from "node:path";

import "dotenv/config";

import chalk from "chalk";
import { Contract, JsonRpcProvider } from "ethers";
import * as YAML from "yaml";

import { loadAbiFromFile } from "./abi-provider";
import { getNonMutables, readUrlOrFromEnvironment as readUrlOrFromEnvironment, Ef, printError } from "./common";
import { collectStaticCallResults, loadContract, loadContractInfoFromExplorer } from "./explorer-provider";
import { logErrorAndExit, log } from "./logger";
import { g_Arguments as g_Arguments } from "./state-mate";
import { ContractEntry, EntireDocument, ExplorerSectionTB, isTypeOfTB, NetworkSection, SeedDocument } from "./typebox";
import { MethodCallResults, Abi } from "./types";

const REPLACE_ME_PLACEHOLDER = "REPLACEME";
const YML = "yml";

export async function doGenerateBoilerplate(seedConfigPath: string, jsonDocument: SeedDocument) {
  let seedDocument: unknown;
  try {
    seedDocument = YAML.parseDocument(fs.readFileSync(seedConfigPath, "utf8"));
  } catch (error) {
    logErrorAndExit(`Failed to read ${chalk.yellow(seedConfigPath)}\n: ${printError(error)}`);
  }
  const document = new YAML.Document(seedDocument);

  await _iterateDeployedAddresses(document, jsonDocument, async (context: DeployedAddressInfo) => {
    const { address, deployedNode, explorerHostname, rpcUrl, sectionName, explorerKey } = context;
    if (!explorerHostname) {
      logErrorAndExit(
        `The field ${chalk.magenta(`explorerHostname`)} is required in the ${chalk.magenta(g_Arguments.configPath)}`,
      );
    }
    const { contractName, implementation } = await loadContractInfoFromExplorer(address, explorerHostname, explorerKey);

    const provider = new JsonRpcProvider(rpcUrl);
    let contractEntryIfProxy;
    let contractEntryIfRegular;
    const logOperation = (section: Ef) => {
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

      logOperation(Ef.checks);
      const checks = await _makeBoilerplateForAllNonMutableFunctions(implementationAbi, contract);

      logOperation(Ef.proxyChecks);
      const proxyChecks = await _makeBoilerplateForAllNonMutableFunctions(proxyAbi, proxyContract);

      logOperation(Ef.implementationChecks);
      const implementationChecks = await _makeBoilerplateForAllNonMutableFunctions(
        implementationAbi,
        implementationContract,
      );
      contractEntryIfProxy = {
        [Ef.name]: implementation.contractName,
        [Ef.address]: document.createAlias(deployedNode),
        proxyName: contractName,
        implementation: implementation.address,
        [Ef.proxyChecks]: proxyChecks,
        [Ef.checks]: checks,
        [Ef.implementationChecks]: implementationChecks,
      };
    } else {
      const abi = loadAbiFromFile(contractName, address);
      const contract = loadContract(address, abi, provider);
      logOperation(Ef.checks);
      const checks = await _makeBoilerplateForAllNonMutableFunctions(abi, contract);
      contractEntryIfRegular = {
        name: contractName,
        address: document.createAlias(deployedNode),
        checks: checks,
      };
    }

    const sectionNode = document.get(sectionName) as YAML.YAMLMap;
    const contractEntry = implementation ? contractEntryIfProxy : contractEntryIfRegular;
    sectionNode.addIn([Ef.contracts], new YAML.Pair(context.deployedNode.anchor, contractEntry));
  });

  const generatedFilePath = path.join(
    path.dirname(seedConfigPath),
    `${path.basename(seedConfigPath, "." + YML)}.generated.${YML}`,
  );
  fs.writeFileSync(generatedFilePath, document.toString());
  log(`Generated state config: ${chalk.bold(generatedFilePath)}`);
}

type DeployedAddressInfo = Pick<NetworkSection, "explorerHostname" | "rpcUrl"> &
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