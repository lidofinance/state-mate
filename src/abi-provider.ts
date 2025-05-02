import fs from "node:fs";
import path from "node:path";

import chalk from "chalk";
import jsonDiff from "json-diff";

import { printError } from "./common";
import { log, LogCommand, logError, logErrorAndExit } from "./logger";
import { g_Arguments } from "./state-mate";
import { Abi, ContractInfo, isValidAbi } from "./types";

export function loadAbiFromFile(contractName: string, address: string): Abi | never {
  address = address.toLowerCase();
  let abiPath;

  try {
    abiPath = _findAbiPath(contractName, address, { shouldThrow: true });
  } catch (error) {
    logErrorAndExit(
      `Error finding ABI file for contract
        ${contractName} in ${g_Arguments.abiDirPath}: ${printError(error)}\n\n` +
        chalk.yellow.bold(`Try running with the '--update-abi' option to download the unnecessary ABI`),
    );
  }
  return loadAbiFromAbiPath(abiPath);
}

export async function checkAllAbi(contractInfo: ContractInfo) {
  const { contractName, address, abi, implementation } = contractInfo;
  await _checkAbi(contractName, address, abi);
  if (implementation) {
    await _checkAbi(implementation.contractName, address, implementation.abi);
    await _checkAbi(implementation.contractName, implementation.address, implementation.abi);
  }
}

export function renameAllAbiToLowerCase() {
  if (!fs.existsSync(g_Arguments.abiDirPath)) return;
  try {
    const abiDirectoryContent = fs.readdirSync(g_Arguments.abiDirPath);

    for (const fileName of abiDirectoryContent) {
      _renameAbiIfNeed(fileName);
    }
  } catch (error) {
    logErrorAndExit(`Failed to read ${chalk.yellow(g_Arguments.abiDirPath)}:\n ${printError(error)}`);
  }
}

function loadAbiFromAbiPath(abiPath: string): Abi | never {
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

async function _checkAbi(contractName: string, address: string, abiFromExplorer: Abi): Promise<void> {
  address = address.toLowerCase();
  const logHandler = new LogCommand(`ABI ${chalk.magenta(`${contractName}-${address}.json`)}`);
  const abiExistedPath = _findAbiPath(contractName, address, { shouldThrow: false });

  if (abiExistedPath) {
    const savedAbi = loadAbiFromAbiPath(abiExistedPath);
    if (!jsonDiff.diffString(savedAbi, abiFromExplorer)) {
      logHandler.success("Matched");
      return;
    }
  }

  const abiFileNameToSave = abiExistedPath || _defaultAbiFilePath(contractName, address);
  _saveAbi(abiFileNameToSave, abiFromExplorer);
  logHandler.success(abiExistedPath ? "Overwritten" : "Saved");
}

function _saveAbi(abiFileName: string, abiFromExplorer: Abi) {
  try {
    fs.writeFileSync(abiFileName, JSON.stringify(abiFromExplorer, null, 2));
  } catch (error) {
    logErrorAndExit(`Error writing file at ${chalk.magenta(abiFileName)}:" ${printError(error)}`);
  }
}

function _findAbiPath(contractName: string, contractAddress: string, shouldThrow: { shouldThrow: true }): string;

function _findAbiPath(
  contractName: string,
  contractAddress: string,
  shouldThrow?: { shouldThrow: false },
): string | null;

function _findAbiPath(
  contractName: string,
  contractAddress: string,
  { shouldThrow }: { shouldThrow?: boolean } = { shouldThrow: false },
): string | null {
  if (!contractName || !g_Arguments.abiDirPath) return null;

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
    try {
      const abiDirectoryContent = fs.readdirSync(g_Arguments.abiDirPath);

      abiFileName = abiDirectoryContent.find((fileName) => {
        return abiVariantsName.find((variantName) => {
          return toLowerCaseAddress(fileName) === variantName;
        });
      });
    } catch (error) {
      logErrorAndExit(`Failed to read ${chalk.yellow(g_Arguments.abiDirPath)}:\n ${printError(error)}`);
    }
  }
  if (!abiFileName && shouldThrow) {
    return _generateAbiNotFoundError(abiVariantsName);
  }

  return abiFileName ? path.join(g_Arguments.abiDirPath, abiFileName) : null;
}

function toLowerCaseAddress(fileName: string): string {
  const match = fileName.match(/0x[0-9a-fA-F]{40}/);
  if (!match) return fileName;

  const address = match[0];

  return fileName.replace(address, address.toLowerCase());
}

function _renameAbiIfNeed(fileName: string): void {
  const newFileName = toLowerCaseAddress(fileName);

  if (fileName !== newFileName) {
    try {
      fs.renameSync(path.resolve(g_Arguments.abiDirPath, fileName), path.resolve(g_Arguments.abiDirPath, newFileName));
      log(`The ABI successfully was renamed from ${chalk.yellow(fileName)} to ${chalk.yellow(newFileName)}`);
    } catch (error) {
      logError(
        `Failed to rename the ABI ${chalk.yellow(fileName)} to ${chalk.yellow(newFileName)}:\n${printError(error)}`,
      );
    }
  }
}
function _defaultAbiFilePath(contractName: string, address?: string) {
  const abiFileName = address ? `${contractName}-${address}.json` : `${contractName}.json`;

  return path.join(g_Arguments.abiDirPath, abiFileName);
}

function _generateAbiNotFoundError(abiVariantsName: string[]): never {
  const variantsName: string = abiVariantsName.map((name) => path.join(g_Arguments.abiDirPath, name)).join("\n");
  throw new Error(`Could not find ABI file. The following combinations were tried:\n` + variantsName);
}
