import fs from "node:fs";
import path from "node:path";

import "dotenv/config";

import * as YAML from "yaml";

import { getNonMutables, readUrlOrFromEnv } from "./common";
import { logErrorAndExit } from "./logger";

import { g_Args } from "./state-mate";
import { ContractEntry, EntireDocument, ExplorerSectionTB, isTypeOfTB, NetworkSection } from "./typebox";
import { MethodCallResults } from "./types";

import { Contract, JsonRpcProvider } from "ethers";

import { Abi } from "./types";

import { loadAbiFromFile, loadContract } from "./abi-provider";

import { Ef } from "./common";
import { log } from "./logger";

import chalk from "chalk";
import { collectStaticCallResults, loadContractInfoFromExplorer } from "./explorer-provider";

const REPLACE_ME_PLACEHOLDER = "REPLACEME";
const YML = "yml";

export function makeBoilerplate(methodCallResults: MethodCallResults): { [key: string]: YAML.Scalar } {
  const result: { [key: string]: YAML.Scalar } = {};

  for (const { methodName, staticCallResult } of methodCallResults) {
    const value = new YAML.Scalar(REPLACE_ME_PLACEHOLDER);
    value.comment = staticCallResult;
    result[methodName] = value;
  }

  return result;
}

export type DeployedAddressInfo = Pick<NetworkSection, "explorerHostname" | "rpcUrl"> &
  Pick<ContractEntry, "address"> & {
    [Key in keyof Pick<NetworkSection, "explorerTokenEnv"> as `explorerKey`]: string;
  } & { deployedNode: YAML.Scalar } & { sectionName: string };

export async function iterateDeployedAddresses(
  seedDoc: YAML.Document,
  jsonDoc: EntireDocument,
  callback: (ctx: DeployedAddressInfo) => Promise<void>,
) {
  const abiDirPath = path.resolve(path.dirname(g_Args.configPath), "abi");
  fs.mkdirSync(abiDirPath, { recursive: true });

  for (const [networkSectionKey, addresses] of Object.entries(jsonDoc.deployed)) {
    const networkSection = jsonDoc[networkSectionKey as keyof EntireDocument];

    if (isTypeOfTB(networkSection, ExplorerSectionTB)) {
      const { explorerHostname, explorerTokenEnv } = networkSection;
      const rpcUrl = readUrlOrFromEnv(networkSection.rpcUrl);
      const explorerKey = explorerTokenEnv ? process.env[explorerTokenEnv] : "";

      for (const address of addresses) {
        const scalars: YAML.Scalar[] = _getScalarsForAnchors(seedDoc);
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
            sectionName: networkSectionKey,
          });
        } else {
          logErrorAndExit(`Couldn't to find the anchor for ${address} in the seed YAML file`);
        }
      }
    }
  }
}

function _getScalarsForAnchors(doc: YAML.Document): YAML.Scalar[] {
  const deployedSection = doc.get("deployed") as YAML.YAMLMap;
  const scalars: YAML.Scalar[] = [];
  {
    for (const deployedSectionNode of deployedSection.items) {
      for (const deployedNode of (deployedSectionNode.value as YAML.YAMLMap).items) {
        scalars.push(deployedNode as unknown as YAML.Scalar);
      }
    }
  }
  return scalars;
}

async function makeBoilerplateForAllNonMutableFunctions(abi: Abi, contract: Contract, contractName: string, ef: Ef) {
  log(`Generating YAML for contract ${contractName}'s non-mutable function values for section ${chalk.yellow(ef)} ...`);

  const nonMutables = getNonMutables(abi);

  const staticCallsResults = await collectStaticCallResults(nonMutables, contract);

  const boilerplate = makeBoilerplate(staticCallsResults);

  return boilerplate;
}

export async function doGenerateBoilerplate(seedConfigPath: string, jsonDoc: EntireDocument) {
  const seedDoc = YAML.parseDocument(fs.readFileSync(seedConfigPath, "utf-8"));
  const doc = new YAML.Document(seedDoc);

  await iterateDeployedAddresses(doc, jsonDoc, async (ctx: DeployedAddressInfo) => {
    const { address, deployedNode, explorerHostname, rpcUrl, sectionName, explorerKey } = ctx;
    const { contractName, implementation } = await loadContractInfoFromExplorer(address, explorerHostname, explorerKey);

    const provider = new JsonRpcProvider(rpcUrl);
    let contractEntryIfProxy = null;
    let contractEntryIfRegular = null;

    if (implementation) {
      const proxyAbi = loadAbiFromFile(contractName, address);
      const implementationAbi = loadAbiFromFile(implementation.contractName, implementation.address);
      const proxyContract = loadContract(contractName, address, provider);
      const contract = loadContract(implementation.contractName, address, provider);
      const implementationContract = loadContract(implementation.contractName, implementation.address, provider);
      const proxyChecks = await makeBoilerplateForAllNonMutableFunctions(
        proxyAbi,
        proxyContract,
        contractName,
        Ef.proxyChecks,
      );
      const checks = await makeBoilerplateForAllNonMutableFunctions(
        implementationAbi,
        contract,
        contractName,
        Ef.checks,
      );
      const implementationChecks = await makeBoilerplateForAllNonMutableFunctions(
        implementationAbi,
        implementationContract,
        contractName,
        Ef.implementationChecks,
      );
      contractEntryIfProxy = {
        [Ef.name]: implementation.contractName,
        [Ef.address]: doc.createAlias(deployedNode),
        proxyName: contractName,
        implementation: implementation.address,
        [Ef.proxyChecks]: proxyChecks,
        [Ef.checks]: checks,
        [Ef.implementationChecks]: implementationChecks,
      };
    } else {
      const abi = loadAbiFromFile(contractName, address);
      const contract = loadContract(contractName, address, provider);
      const checks = await makeBoilerplateForAllNonMutableFunctions(abi, contract, contractName, Ef.checks);
      contractEntryIfRegular = {
        name: contractName,
        address: doc.createAlias(deployedNode),
        checks: checks,
      };
    }

    const sectionNode = doc.get(sectionName) as YAML.YAMLMap;
    const contractEntry = implementation ? contractEntryIfProxy : contractEntryIfRegular;
    sectionNode.addIn([Ef.contracts], new YAML.Pair(ctx.deployedNode.anchor, contractEntry));
  });

  const generatedFilePath = path.join(
    path.dirname(seedConfigPath),
    `${path.basename(seedConfigPath, "." + YML)}.generated.${YML}`,
  );
  fs.writeFileSync(generatedFilePath, doc.toString());
  log(`Generated state config: ${chalk.bold(generatedFilePath)}`);
}
