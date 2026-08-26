import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import chalk from "chalk";

import { normalizeChainId, printError } from "./common";
import { context } from "./context";
import { LogCommand, log, logErrorAndExit, WARNING_MARK } from "./logger";
import { type Abi, type ChainId, type ContractInfo, isValidAbi } from "./types";

type StoredAbi = { name: string; abi: Abi };

let consolidatedAbisCache: Record<string, StoredAbi> | null = null;
let pendingAbiUpdates: Record<string, StoredAbi> | null = null;
const walkedAbiKeys = new Map<string, Set<string>>();
const fetchedAbiKeys = new Map<string, Set<string>>();
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
    // No file yet (fresh config): start empty, the download pass will populate it
    consolidatedAbisCache = {};
    return consolidatedAbisCache;
  }

  // --update-abi is the upgrade path from any store state: a file the loader cannot read,
  // the pre-consolidation format included, starts over instead of blocking its own rebuild
  const invalid = (reason: string): Record<string, StoredAbi> | never => {
    if (context.updateAbi) {
      // The rebuild starts empty, so the unreadable archive is the only copy of whatever it
      // holds; move it aside instead of overwriting it with a partial download. A later recovery
      // must not overwrite an earlier backup either
      let backupPath = `${abisPath}.invalid`;
      for (let index = 1; fs.existsSync(backupPath); index++) backupPath = `${abisPath}.invalid.${index}`;
      fs.renameSync(abisPath, backupPath);
      log(
        `${WARNING_MARK} ${chalk.yellow(`${reason}; the archive is preserved at ${chalk.magenta(backupPath)}, rebuilding the store from scratch`)}`,
      );
      consolidatedAbisCache = {};
      return consolidatedAbisCache;
    }
    logErrorAndExit(`${reason}. Run with ${chalk.yellow("--update-abi")} to rebuild the store`);
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(zlib.gunzipSync(fs.readFileSync(abisPath)).toString("utf8"));
  } catch (error) {
    return invalid(`Failed to read consolidated ABI file at ${chalk.magenta(abisPath)}: ${printError(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    return invalid(`Consolidated ABI file ${chalk.magenta(abisPath)} is not a valid JSON object`);
  }

  const normalized: Record<string, StoredAbi> = {};
  for (const [address, value] of Object.entries(parsed)) {
    const entry = value as StoredAbi;
    if (typeof entry !== "object" || entry === null || typeof entry.name !== "string" || !isValidAbi(entry.abi)) {
      return invalid(
        `Consolidated ABI file ${chalk.magenta(abisPath)} contains an invalid entry for ${chalk.yellow(address)}: ` +
          `expected { name, abi }`,
      );
    }
    normalized[address.toLowerCase()] = entry;
  }

  consolidatedAbisCache = normalized;
  return consolidatedAbisCache;
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
  const key = getAbiKey(chainId, address);

  if (!fs.existsSync(getConsolidatedAbiPath())) {
    logErrorAndExit(
      `No consolidated ABI file found at ${chalk.magenta(getConsolidatedAbiPath())}\n\n` +
        chalk.yellow.bold(`The explorer served no ABI for it; check that the contract is verified`),
    );
  }

  // Everything the checks actually load is in use, wherever the config keeps the address;
  // the --update-abi sweep must never drop it
  _markWalked(key);

  const abis = loadConsolidatedAbis();
  const entry = abis[key];

  if (!entry) {
    logErrorAndExit(
      `ABI not found for ${chalk.yellow(`${contractName} @ ${key}`)}\n` +
        `Known contracts:\n${formatKnownContracts(abis)}\n\n` +
        chalk.yellow.bold(`Missing ABIs download on every run, so the explorer served none for this address`),
    );
  }

  if (entry.name !== contractName) {
    logErrorAndExit(
      `The ABI stored for ${chalk.yellow(key)} belongs to ${chalk.yellow(entry.name)}, ` +
        `while the config expects ${chalk.yellow(contractName)}.\n` +
        `Fix the contract name in the YAML, or delete the entry from ${chalk.magenta(CONSOLIDATED_ABI_FILENAME_GZ)} ` +
        `and re-run to download it again`,
    );
  }

  return entry.abi;
}

export function getAbiNameForAddress(chainId: ChainId, address: string): string | undefined {
  return loadConsolidatedAbis()[getAbiKey(chainId, address)]?.name;
}

/**
 * Marks the stored entry for an address the explorer refuses to serve, so the rebuild sweep keeps
 * it. Without the mark an unverified contract drops out of the store and the next run fails on a
 * missing ABI.
 */
export function keepStoredAbi(chainId: ChainId, address: string): string | undefined {
  const key = getAbiKey(chainId, address);
  const entry = loadConsolidatedAbis()[key];
  if (!entry) return undefined;

  _markFetched(key);
  return entry.name;
}

export async function checkAllAbi(chainId: ChainId, contractInfo: ContractInfo) {
  const { contractName, address, abi } = contractInfo;
  await _checkAbi(chainId, contractName, address, abi);
}

async function _checkAbi(chainId: ChainId, contractName: string, address: string, abiFromExplorer: Abi): Promise<void> {
  const key = getAbiKey(chainId, address);
  _markFetched(key);
  const logHandler = new LogCommand(`ABI ${chalk.magenta(`${contractName} @ ${address.toLowerCase()}`)}`);

  if (!context.updateAbi && Object.hasOwn(loadConsolidatedAbis(), key)) {
    logHandler.success("Skipped (exists)");
    return;
  }

  _saveAbi(key, { name: contractName, abi: abiFromExplorer });
  logHandler.success(context.updateAbi ? "Downloaded" : "Saved");
}

/**
 * Reports whether this run already re-downloaded or kept the address, whatever config did it.
 * Reading an ABI for checks does not count: a rebuild must still refresh it.
 */
export function wasFetchedThisRun(chainId: ChainId, address: string): boolean {
  return fetchedAbiKeys.get(getConsolidatedAbiPath())?.has(getAbiKey(chainId, address)) ?? false;
}

function _markWalked(key: string) {
  _markIn(walkedAbiKeys, key);
}

function _markFetched(key: string) {
  _markIn(walkedAbiKeys, key);
  _markIn(fetchedAbiKeys, key);
}

function _markIn(registry: Map<string, Set<string>>, key: string) {
  const storePath = getConsolidatedAbiPath();
  let keys = registry.get(storePath);
  if (!keys) {
    keys = new Set();
    registry.set(storePath, keys);
  }
  keys.add(key);
}

function _saveAbi(key: string, entry: StoredAbi) {
  // Merge into what the store already holds; the rebuild never starts empty, so a download the
  // explorer refuses cannot cost a stored ABI. pruneAbiStores drops the unreferenced keys instead.
  pendingAbiUpdates ??= { ...loadConsolidatedAbis() };

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

/** Only tests run more than one --update-abi rebuild per process. */
export function resetAbiRebuildState(): void {
  walkedAbiKeys.clear();
  fetchedAbiKeys.clear();
}

/**
 * Drops every store key the --update-abi run did not walk, which is how entries no config
 * references any more disappear. Runs once, after the last config of a directory: one store
 * serves every config in it, and pruning earlier would sweep the keys of configs not walked yet.
 */
export function pruneAbiStores(): void {
  if (!context.updateAbi) return;

  for (const [storePath, walked] of walkedAbiKeys) {
    if (!fs.existsSync(storePath)) continue;
    try {
      const store = JSON.parse(zlib.gunzipSync(fs.readFileSync(storePath)).toString("utf8")) as Record<
        string,
        StoredAbi
      >;
      const kept = Object.fromEntries(Object.entries(store).filter(([key]) => walked.has(key.toLowerCase())));
      const dropped = Object.keys(store).length - Object.keys(kept).length;
      if (dropped === 0) continue;
      // temp + rename keeps the store whole if the write dies short, same as flushAbiUpdates
      fs.writeFileSync(`${storePath}.tmp`, zlib.gzipSync(JSON.stringify(kept, null, 2)));
      fs.renameSync(`${storePath}.tmp`, storePath);
      log(`Pruned ${chalk.yellow(dropped)} ABI entries no config references from ${chalk.magenta(storePath)}`);
    } catch (error) {
      // A store the sweep cannot read keeps its extra keys, which is safe; the other stores
      // still get their pass
      log(`${WARNING_MARK} ${chalk.yellow(`could not prune ${chalk.magenta(storePath)}: ${printError(error)}`)}`);
    }
  }
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
    // temp + rename keeps the store whole if the process dies mid-write
    fs.writeFileSync(`${outputPath}.tmp`, compressed);
    fs.renameSync(`${outputPath}.tmp`, outputPath);

    // Update cache only after successful write
    consolidatedAbisCache = pendingAbiUpdates;
    pendingAbiUpdates = null;
  } catch (error) {
    pendingAbiUpdates = null;
    logErrorAndExit(`Error writing consolidated ABI file at ${chalk.magenta(outputPath)}: ${printError(error)}`);
  }
}
