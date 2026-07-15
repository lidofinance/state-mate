import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import chalk from "chalk";

import { normalizeChainId, printError } from "./common";
import { context } from "./context";
import { LogCommand, logErrorAndExit } from "./logger";
import { Abi, ChainId, ContractInfo, isValidAbi } from "./types";

type StoredAbi = { name: string; abi: Abi };

let consolidatedAbisCache: Record<string, StoredAbi> | null = null;
let pendingAbiUpdates: Record<string, StoredAbi> | null = null;
const CONSOLIDATED_ABI_FILENAME_GZ = "abis.json.gz";
const KEYS_PREVIEW_LIMIT = 40;

function getConsolidatedAbiPath(): string {
  // abis.json.gz lives alongside the config file
  return path.join(path.dirname(context.configPath), CONSOLIDATED_ABI_FILENAME_GZ);
}

function loadConsolidatedAbis(): Record<string, StoredAbi> {
  if (consolidatedAbisCache !== null) {
    return consolidatedAbisCache;
  }

  const abisPath = getConsolidatedAbiPath();
  if (!fs.existsSync(abisPath)) {
    // No file yet (fresh config): start empty, --update-abi will populate it
    consolidatedAbisCache = {};
    return consolidatedAbisCache;
  }

  try {
    const content = zlib.gunzipSync(fs.readFileSync(abisPath)).toString("utf8");
    const parsed: unknown = JSON.parse(content);

    if (typeof parsed !== "object" || parsed === null) {
      logErrorAndExit(`Consolidated ABI file ${chalk.magenta(abisPath)} is not a valid JSON object`);
    }

    const normalized: Record<string, StoredAbi> = {};
    for (const [address, value] of Object.entries(parsed)) {
      const entry = value as StoredAbi;
      if (typeof entry !== "object" || entry === null || typeof entry.name !== "string" || !isValidAbi(entry.abi)) {
        logErrorAndExit(
          `Consolidated ABI file ${chalk.magenta(abisPath)} contains an invalid entry for ${chalk.yellow(address)}: ` +
            `expected { name, abi }`,
        );
      }
      normalized[address.toLowerCase()] = entry;
    }

    consolidatedAbisCache = normalized;
    return consolidatedAbisCache;
  } catch (error) {
    logErrorAndExit(`Failed to read consolidated ABI file at ${abisPath}: ${printError(error)}`);
  }
}

function formatKnownContracts(abis: Record<string, StoredAbi>): string {
  const lines = Object.entries(abis).map(([key, { name }]) => `${name} @ ${key}`);
  if (lines.length <= KEYS_PREVIEW_LIMIT) {
    return lines.join("\n");
  }
  return `${lines.slice(0, KEYS_PREVIEW_LIMIT).join("\n")}\n... (+${lines.length - KEYS_PREVIEW_LIMIT} more)`;
}

function getAbiKey(chainId: ChainId, address: string): string {
  return `${normalizeChainId(chainId)}:${address.toLowerCase()}`;
}

export function loadAbiFromFile(chainId: ChainId, contractName: string, address: string): Abi | never {
  const normalizedAddress = address.toLowerCase();
  const key = getAbiKey(chainId, address);

  if (!fs.existsSync(getConsolidatedAbiPath())) {
    logErrorAndExit(
      `No consolidated ABI file found at ${chalk.magenta(getConsolidatedAbiPath())}\n\n` +
        chalk.yellow.bold(`Try running with the '--update-abi' option to download the ABIs`),
    );
  }

  const abis = loadConsolidatedAbis();
  const isLegacyStore = Object.keys(abis).every((storedKey) => !storedKey.includes(":"));
  const entry = abis[key] ?? (isLegacyStore ? abis[normalizedAddress] : undefined);

  if (!entry) {
    logErrorAndExit(
      `ABI not found for ${chalk.yellow(`${contractName} @ ${key}`)}\n` +
        `Known contracts:\n${formatKnownContracts(abis)}\n\n` +
        chalk.yellow.bold(`Try running with the '--update-abi' option to download the ABI`),
    );
  }

  if (entry.name !== contractName) {
    logErrorAndExit(
      `The ABI stored for ${chalk.yellow(key)} belongs to ${chalk.yellow(entry.name)}, ` +
        `while the config expects ${chalk.yellow(contractName)}.\n` +
        `Fix the contract name in the YAML, or delete the entry from ${chalk.magenta(CONSOLIDATED_ABI_FILENAME_GZ)} ` +
        `and re-run with '--update-abi'`,
    );
  }

  return entry.abi;
}

export function getAbiNameForAddress(chainId: ChainId, address: string): string | undefined {
  return loadConsolidatedAbis()[getAbiKey(chainId, address)]?.name;
}

export async function checkAllAbi(chainId: ChainId, contractInfo: ContractInfo) {
  const { contractName, address, abi, implementation } = contractInfo;
  await _checkAbi(chainId, contractName, address, abi);
  if (implementation) {
    await _checkAbi(chainId, implementation.contractName, implementation.address, implementation.abi);
  }
}

async function _checkAbi(chainId: ChainId, contractName: string, address: string, abiFromExplorer: Abi): Promise<void> {
  const key = getAbiKey(chainId, address);
  const logHandler = new LogCommand(`ABI ${chalk.magenta(`${contractName} @ ${address.toLowerCase()}`)}`);

  if (Object.hasOwn(loadConsolidatedAbis(), key)) {
    logHandler.success("Skipped (exists)");
    return;
  }

  _saveAbi(key, { name: contractName, abi: abiFromExplorer });
  logHandler.success("Saved");
}

function _saveAbi(key: string, entry: StoredAbi) {
  // Initialize pending updates on first call
  if (!pendingAbiUpdates) {
    pendingAbiUpdates = { ...loadConsolidatedAbis() };
  }

  // Stage the update instead of writing immediately
  pendingAbiUpdates[key] = entry;
}

/**
 * Drops the in-memory store cache. Needed by unit tests that switch config directories
 * within one process; production code loads a single store per run.
 */
export function resetAbiCache(): void {
  consolidatedAbisCache = null;
  pendingAbiUpdates = null;
}

/**
 * Flushes all pending ABI updates to disk.
 * This should be called after all ABI updates are complete to write once.
 */
export function flushAbiUpdates(): void {
  if (!pendingAbiUpdates) return;

  const outputPath = getConsolidatedAbiPath();
  try {
    const compressed = zlib.gzipSync(JSON.stringify(pendingAbiUpdates, null, 2));
    fs.writeFileSync(outputPath, compressed);

    // Update cache only after successful write
    consolidatedAbisCache = pendingAbiUpdates;
    pendingAbiUpdates = null;
  } catch (error) {
    pendingAbiUpdates = null;
    logErrorAndExit(`Error writing consolidated ABI file at ${chalk.magenta(outputPath)}: ${printError(error)}`);
  }
}
