import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import chalk from "chalk";
import jsonDiff from "json-diff";

import { printError } from "./common";
import { log, LogCommand, logError, logErrorAndExit } from "./logger";
import { g_Arguments } from "./state-mate";
import { Abi, ContractInfo, isValidAbi } from "./types";

type AbiMode = "consolidated" | "individual" | "none";

let g_abiMode: AbiMode | null = null;
let g_consolidatedAbis: Record<string, Abi> | null = null;
let g_pendingAbiUpdates: Record<string, Abi> | null = null;
const CONSOLIDATED_ABI_FILENAME = "abis.json";
const CONSOLIDATED_ABI_FILENAME_GZ = "abis.json.gz";

function getConsolidatedAbiPath(): string {
  // Place abis.json alongside the config file, not in the abi subdirectory
  return path.join(path.dirname(g_Arguments.configPath), CONSOLIDATED_ABI_FILENAME);
}

function getConsolidatedAbiPathGz(): string {
  // Place abis.json.gz alongside the config file
  return path.join(path.dirname(g_Arguments.configPath), CONSOLIDATED_ABI_FILENAME_GZ);
}

function getConsolidatedAbiPathToUse(): { path: string; isCompressed: boolean } | null {
  const gzPath = getConsolidatedAbiPathGz();
  const jsonPath = getConsolidatedAbiPath();

  // Prefer compressed version if it exists
  if (fs.existsSync(gzPath)) {
    return { path: gzPath, isCompressed: true };
  }
  if (fs.existsSync(jsonPath)) {
    return { path: jsonPath, isCompressed: false };
  }
  return null;
}

function determineAbiMode(): AbiMode {
  if (g_abiMode !== null) {
    return g_abiMode;
  }

  const consolidatedFile = getConsolidatedAbiPathToUse();
  const consolidatedExists = consolidatedFile !== null;

  let individualFilesExist = false;
  if (fs.existsSync(g_Arguments.abiDirPath)) {
    const files = fs.readdirSync(g_Arguments.abiDirPath);
    individualFilesExist = files.some((file) => file.endsWith(".json") && file !== CONSOLIDATED_ABI_FILENAME);
  }

  if (consolidatedExists && individualFilesExist) {
    logErrorAndExit(
      `Cannot use both consolidated ${chalk.yellow(CONSOLIDATED_ABI_FILENAME)} and individual ABI files.\n` +
        `Please remove one format from ${chalk.magenta(g_Arguments.abiDirPath)}`,
    );
  }

  if (consolidatedExists) {
    g_abiMode = "consolidated";
  } else if (individualFilesExist) {
    g_abiMode = "individual";
  } else {
    g_abiMode = "none";
  }

  return g_abiMode;
}

function loadConsolidatedAbis(): Record<string, Abi> {
  if (g_consolidatedAbis !== null) {
    return g_consolidatedAbis;
  }

  const consolidatedFile = getConsolidatedAbiPathToUse();
  if (!consolidatedFile) {
    logErrorAndExit(
      `No consolidated ABI file found (neither ${CONSOLIDATED_ABI_FILENAME_GZ} nor ${CONSOLIDATED_ABI_FILENAME})`,
    );
  }

  try {
    let content: string;
    if (consolidatedFile.isCompressed) {
      // Read and decompress gzipped file
      const compressedData = fs.readFileSync(consolidatedFile.path);
      const decompressed = zlib.gunzipSync(compressedData);
      content = decompressed.toString("utf8");
    } else {
      // Read plain JSON file
      content = fs.readFileSync(consolidatedFile.path, "utf8");
    }

    const parsed: unknown = JSON.parse(content);

    if (typeof parsed !== "object" || parsed === null) {
      logErrorAndExit(`Consolidated ABI file ${chalk.magenta(consolidatedFile.path)} is not a valid JSON object`);
    }

    const { normalized } = normalizeConsolidatedAbiKeys(parsed as Record<string, Abi>);
    g_consolidatedAbis = normalized;

    // Validate all ABIs
    for (const [key, abi] of Object.entries(g_consolidatedAbis)) {
      if (!isValidAbi(abi)) {
        logErrorAndExit(
          `Consolidated ABI file ${chalk.magenta(consolidatedFile.path)} contains invalid ABI for key ${chalk.yellow(key)}`,
        );
      }
    }

    return g_consolidatedAbis;
  } catch (error) {
    logErrorAndExit(`Failed to read consolidated ABI file at ${consolidatedFile.path}: ${printError(error)}`);
  }
}

function getAbiKey(contractName: string, address?: string): string {
  return address ? `${contractName}-${address}` : contractName;
}

export function loadAbiFromFile(contractName: string, address: string): Abi | never {
  address = address.toLowerCase();
  const mode = determineAbiMode();

  if (mode === "consolidated") {
    const abis = loadConsolidatedAbis();
    const key = getAbiKey(contractName, address);

    // Try with address first, then without
    let abi = abis[key];
    if (!abi && address) {
      abi = abis[contractName];
    }

    if (!abi) {
      logErrorAndExit(
        `ABI not found in consolidated file for ${chalk.yellow(key)}\n` +
          `Available keys: ${Object.keys(abis).join(", ")}\n\n` +
          chalk.yellow.bold(`Try running with the '--update-abi' option to download the ABI`),
      );
    }

    return abi;
  } else if (mode === "individual") {
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
  } else {
    logErrorAndExit(`No ABI files found in ${chalk.magenta(g_Arguments.abiDirPath)}`);
  }
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

  const mode = determineAbiMode();

  if (mode === "consolidated") {
    // For consolidated mode, ensure all keys have lowercase addresses
    const abis = loadConsolidatedAbis();
    const { normalized: newAbis, renamed: changed } = normalizeConsolidatedAbiKeys(abis, {
      onRename: (from, to) => {
        log(`The ABI key renamed from ${chalk.yellow(from)} to ${chalk.yellow(to)}`);
      },
    });

    if (changed) {
      const consolidatedFile = getConsolidatedAbiPathToUse();
      const outputPath = consolidatedFile ? consolidatedFile.path : getConsolidatedAbiPathGz();
      const shouldCompress = !consolidatedFile || consolidatedFile.isCompressed;

      try {
        const jsonContent = JSON.stringify(newAbis, null, 2);

        if (shouldCompress) {
          const compressed = zlib.gzipSync(jsonContent);
          fs.writeFileSync(outputPath, compressed);
        } else {
          fs.writeFileSync(outputPath, jsonContent);
        }
        g_consolidatedAbis = newAbis; // Update cache
      } catch (error) {
        logErrorAndExit(`Failed to update consolidated ABI file: ${printError(error)}`);
      }
    }
  } else if (mode === "individual") {
    // For individual mode, use existing file-based renaming
    try {
      const abiDirectoryContent = fs.readdirSync(g_Arguments.abiDirPath);
      for (const fileName of abiDirectoryContent) {
        _renameAbiIfNeed(fileName);
      }
    } catch (error) {
      logErrorAndExit(`Failed to read ${chalk.yellow(g_Arguments.abiDirPath)}:\n ${printError(error)}`);
    }
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
  const mode = determineAbiMode();

  let savedAbi: Abi | null = null;
  let abiExists = false;

  if (mode === "consolidated") {
    const abis = loadConsolidatedAbis();
    const key = getAbiKey(contractName, address);
    savedAbi = abis[key] || abis[contractName] || null;
    abiExists = savedAbi !== null;
  } else if (mode === "individual") {
    const abiExistedPath = _findAbiPath(contractName, address, { shouldThrow: false });
    if (abiExistedPath) {
      savedAbi = loadAbiFromAbiPath(abiExistedPath);
      abiExists = true;
    }
  }

  if (abiExists && savedAbi && !jsonDiff.diffString(savedAbi, abiFromExplorer)) {
    logHandler.success("Matched");
    return;
  }

  const abiFileNameToSave =
    mode === "consolidated"
      ? getAbiKey(contractName, address)
      : _findAbiPath(contractName, address, { shouldThrow: false }) || _defaultAbiFilePath(contractName, address);

  _saveAbi(abiFileNameToSave, abiFromExplorer);
  logHandler.success(abiExists ? "Overwritten" : "Saved");
}

function _saveAbi(abiFileName: string, abiFromExplorer: Abi) {
  const mode = determineAbiMode();

  if (mode === "consolidated") {
    // Extract key from filename
    const basename = path.basename(abiFileName, ".json");

    // Initialize pending updates on first call
    if (!g_pendingAbiUpdates) {
      g_pendingAbiUpdates = { ...loadConsolidatedAbis() };
    }

    // Stage the update instead of writing immediately
    g_pendingAbiUpdates[basename] = abiFromExplorer;
  } else {
    // Individual file mode
    try {
      fs.writeFileSync(abiFileName, JSON.stringify(abiFromExplorer, null, 2));
    } catch (error) {
      logErrorAndExit(`Error writing file at ${chalk.magenta(abiFileName)}: ${printError(error)}`);
    }
  }
}

/**
 * Flushes all pending ABI updates to disk in consolidated mode.
 * This should be called after all ABI updates are complete to write once.
 */
export function flushAbiUpdates(): void {
  const mode = determineAbiMode();

  if (mode === "consolidated" && g_pendingAbiUpdates) {
    const consolidatedFile = getConsolidatedAbiPathToUse();
    const outputPath = consolidatedFile ? consolidatedFile.path : getConsolidatedAbiPathGz();
    const shouldCompress = !consolidatedFile || consolidatedFile.isCompressed;

    try {
      const jsonContent = JSON.stringify(g_pendingAbiUpdates, null, 2);

      if (shouldCompress) {
        // Write compressed file
        const compressed = zlib.gzipSync(jsonContent);
        fs.writeFileSync(outputPath, compressed);
      } else {
        // Write plain JSON file
        fs.writeFileSync(outputPath, jsonContent);
      }

      // Update cache only after successful write
      g_consolidatedAbis = g_pendingAbiUpdates;
      g_pendingAbiUpdates = null;
    } catch (error) {
      // Reset pending updates on error
      g_pendingAbiUpdates = null;
      logErrorAndExit(`Error writing consolidated ABI file at ${chalk.magenta(outputPath)}: ${printError(error)}`);
    }
  }
}

/**
 * Resets the cached ABI mode so it will be re-determined on next access.
 * This should be called after downloading ABIs to ensure the mode is
 * correctly detected based on newly created files.
 */
export function resetAbiModeCache(): void {
  g_abiMode = null;
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

function normalizeConsolidatedAbiKeys(
  abis: Record<string, Abi>,
  options: { onRename?: (from: string, to: string) => void } = {},
): { normalized: Record<string, Abi>; renamed: boolean } {
  const normalized: Record<string, Abi> = {};
  let renamed = false;

  for (const [key, abi] of Object.entries(abis)) {
    const normalizedKey = toLowerCaseAddress(key);

    if (normalizedKey !== key) {
      renamed = true;
      options.onRename?.(key, normalizedKey);
    }

    normalized[normalizedKey] = abi;
  }

  return { normalized: normalized, renamed };
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
