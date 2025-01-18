import fs from "node:fs";
import path from "node:path";

import { confirm as askUserToConfirm } from "@inquirer/prompts";
import chalk from "chalk";
import jsonDiff from "json-diff";

import { printError } from "./common";
import { log, LogCommand, logErrorAndExit, WARNING_MARK } from "./logger";
import { g_Arguments } from "./state-mate";
import { Abi, ContractInfo, isValidAbi } from "./types";

export function loadAbiFromFile(contractName: string, address: string): Abi | never {
  address = address.toLowerCase();
  let abiPath = undefined;

  try {
    abiPath = _findAbiPath(contractName, address, { shouldThrow: true });
  } catch (error) {
    logErrorAndExit(`Error finding ABI file for contract 
        ${contractName} in ${g_Arguments.abiDirPath}: ${printError(error)}`);
  }
  try {
    const abiFileContent = fs.readFileSync(abiPath, "utf8");
    const abiJson: unknown = JSON.parse(abiFileContent);

    const abi: unknown = abiJson instanceof Object && "abi" in abiJson ? abiJson.abi : abiJson;
    if (!isValidAbi(abi)) {
      logErrorAndExit(`ABI file ${abiPath} does not contain valid ABI`);
    }
    return abi;
  } catch (error) {
    logErrorAndExit(`Failed to read ABI file at ${abiPath}: ${printError(error)} `);
  }
}

export async function saveAllAbi(contractInfo: ContractInfo) {
  const { contractName, address, abi, implementation } = contractInfo;
  await _saveAbiIfNotExist(contractName, address, abi);
  if (implementation) {
    await _saveAbiIfNotExist(implementation.contractName, address, implementation.abi);
    await _saveAbiIfNotExist(implementation.contractName, implementation.address, implementation.abi);
  }
}

async function _saveAbiIfNotExist(contractName: string, address: string, abiFromExplorer: Abi): Promise<void> {
  address = address.toLowerCase();
  const abiPath = _findAbiPath(contractName, address);

  if (abiPath) {
    const differences: string = _getJsonDiff(abiPath, abiFromExplorer);
    if (!differences) {
      log(
        `The ABI already exists and fully matches the one from the explorer: ${chalk.magenta(path.basename(abiPath))} `,
      );
      return;
    }
    if (
      !(await askUserToConfirm({
        message: `The ABI already exists: ${chalk.magenta(path.basename(abiPath))}, but it differs from the one from the explorer. Overwrite?`,
      }))
    ) {
      log(
        `\n ${WARNING_MARK}${WARNING_MARK}${WARNING_MARK} ` +
          `${chalk.yellow(`The ABI ${path.basename(abiPath)} will not be overwritten as per user's decision`)}\n`,
      );
      return;
    }
  }
  const abiFileName = abiPath || _getAbiFilePathByDefault(contractName, address);
  try {
    fs.writeFileSync(abiFileName, JSON.stringify(abiFromExplorer, undefined, 2));
    log(`The ABI has been saved at ${chalk.magenta(abiFileName)}`);
  } catch (error) {
    logErrorAndExit(`Error writing file at ${chalk.magenta(abiFileName)}:" ${printError(error)}`);
  }
}

export function checkAllAbiForDiffs(contractInfo: ContractInfo) {
  const { contractName, address, abi, implementation } = contractInfo;
  _checkOneAbiForDiffs(contractName, address, abi);
  if (implementation) {
    _checkOneAbiForDiffs(implementation.contractName, address, implementation.abi);
    _checkOneAbiForDiffs(implementation.contractName, implementation.address, implementation.abi);
  }
}

export function _checkOneAbiForDiffs(contractName: string, address: string, abiFromExplorer: Abi) {
  address = address.toLowerCase();
  const logHandle = new LogCommand(`${contractName.padEnd(30)} (${address})`);

  try {
    const abiPath = _findAbiPath(contractName, address, { shouldThrow: true });
    const diff: string = _getJsonDiff(abiPath, abiFromExplorer);
    if (diff) {
      logHandle.warning(`FAILED\n${diff}`);
    } else {
      logHandle.success("OK");
    }
  } catch (error) {
    logHandle.failure(`Failed\n${printError(error)}`);
  }
}

function _getJsonDiff(abiPath: string, abiFromExplorer: Abi): string {
  const abiFile = fs.readFileSync(abiPath, "utf8");
  const savedAbi: unknown = JSON.parse(abiFile);
  return jsonDiff.diffString(savedAbi, abiFromExplorer);
}

function _findAbiPath(contractName: string, contractAddress: string, shouldThrow: { shouldThrow: true }): string;

function _findAbiPath(
  contractName: string,
  contractAddress: string,
  shouldThrow?: { shouldThrow: false },
): string | undefined;

function _findAbiPath(
  contractName: string,
  contractAddress: string,
  { shouldThrow }: { shouldThrow?: boolean } = { shouldThrow: false },
): string | undefined {
  if (!contractName || !g_Arguments.abiDirPath) return undefined;

  contractAddress = contractAddress.toLowerCase();
  // prettier-ignore
  const abiVariantsName = [
    `${contractName}.json`,
    `${contractName}.sol/${contractName}.json`,
    ...(contractAddress ? [
      `${contractName}-${contractAddress}.json`,
    ] : [])
  ];

  let abiFileName = abiVariantsName.find((variantPath) =>
    fs.existsSync(path.join(g_Arguments.abiDirPath, variantPath)),
  );
  if (!abiFileName) {
    const abiDirectoryContent = fs.readdirSync(g_Arguments.abiDirPath);
    abiFileName = abiDirectoryContent.find((fileName) => {
      const match = fileName.match(/0x[0-9a-fA-F]{40}/);
      if (!match) return;

      const address = match[0];

      const newFileName = fileName.replace(address, address.toLowerCase());
      //Is renaming required?
      return abiVariantsName.find((variantName) => {
        return newFileName === variantName;
      });
    });
  }
  if (!abiFileName && shouldThrow) {
    return _generateAbiNotFoundError(abiVariantsName);
  }

  return abiFileName ? path.join(g_Arguments.abiDirPath, abiFileName) : undefined;
}

function _getAbiFilePathByDefault(contractName: string, address?: string) {
  const abiFileName = address ? `${contractName}-${address}.json` : `${contractName}.json`;

  return path.join(g_Arguments.abiDirPath, abiFileName);
}

function _generateAbiNotFoundError(abiVariantsName: string[]): never {
  const variantsName: string = abiVariantsName.map((name) => path.join(g_Arguments.abiDirPath, name)).join("\n");
  throw new Error(`Could not find ABI file. The following combinations were tried:\n` + variantsName);
}
