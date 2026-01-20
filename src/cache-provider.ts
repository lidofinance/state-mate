import fs from "node:fs";
import path from "node:path";

import { log } from "./logger";

const CACHE_VERSION = "1.0.0";
const CACHE_DIR_NAME = "cache";
const CREATION_BLOCKS_FILE = "creation-blocks.json";
const EVENT_SCANS_FILE = "event-scans.json";

export interface ContractCreationCacheEntry {
  blockNumber: number;
  txHash: string;
  deployer: string;
}

export interface EventScanCacheEntry {
  roleHolders: Record<string, string[]>; // role -> holders array (serialized from Map<string, Set<string>>)
  lastScannedBlock: number;
}

interface CreationBlocksCache {
  version: string;
  entries: Record<string, ContractCreationCacheEntry>;
}

interface EventScansCache {
  version: string;
  entries: Record<string, EventScanCacheEntry>;
}

let g_creationBlockCache: CreationBlocksCache | null = null;
let g_eventScanCache: EventScansCache | null = null;
let g_cacheDirectory: string | null = null;
let g_creationBlockCacheDirty = false;
let g_eventScanCacheDirty = false;
let g_cacheDisabled = false;

export type RoleHoldersMap = Map<string, Set<string>>;

export function initCacheDirectory(configPath: string, options?: { disabled?: boolean }): void {
  g_cacheDirectory = path.join(path.dirname(configPath), CACHE_DIR_NAME);
  g_cacheDisabled = options?.disabled ?? false;
}

function getCacheDirectory(): string {
  if (!g_cacheDirectory) {
    throw new Error("Cache directory not initialized. Call initCacheDirectory() first.");
  }
  return g_cacheDirectory;
}

function ensureCacheDirectory(): void {
  const cacheDirectory = getCacheDirectory();
  if (!fs.existsSync(cacheDirectory)) {
    fs.mkdirSync(cacheDirectory, { recursive: true });
  }
}

function loadCreationBlocksCache(): CreationBlocksCache {
  if (g_creationBlockCache) {
    return g_creationBlockCache;
  }

  const cacheFile = path.join(getCacheDirectory(), CREATION_BLOCKS_FILE);
  if (fs.existsSync(cacheFile)) {
    try {
      const content = fs.readFileSync(cacheFile, "utf8");
      const cache = JSON.parse(content) as CreationBlocksCache;
      if (cache.version === CACHE_VERSION) {
        g_creationBlockCache = cache;
        return g_creationBlockCache;
      }
      log(`  Cache version mismatch for creation blocks, starting fresh`);
    } catch {
      log(`  Failed to read creation blocks cache, starting fresh`);
    }
  }

  g_creationBlockCache = { version: CACHE_VERSION, entries: {} };
  return g_creationBlockCache;
}

function loadEventScansCache(): EventScansCache {
  if (g_eventScanCache) {
    return g_eventScanCache;
  }

  const cacheFile = path.join(getCacheDirectory(), EVENT_SCANS_FILE);
  if (fs.existsSync(cacheFile)) {
    try {
      const content = fs.readFileSync(cacheFile, "utf8");
      const cache = JSON.parse(content) as EventScansCache;
      if (cache.version === CACHE_VERSION) {
        g_eventScanCache = cache;
        return g_eventScanCache;
      }
      log(`  Cache version mismatch for event scans, starting fresh`);
    } catch {
      log(`  Failed to read event scans cache, starting fresh`);
    }
  }

  g_eventScanCache = { version: CACHE_VERSION, entries: {} };
  return g_eventScanCache;
}

export function loadCreationBlockFromCache(address: string): ContractCreationCacheEntry | null {
  if (g_cacheDisabled) {
    return null;
  }
  const cache = loadCreationBlocksCache();
  const normalizedAddress = address.toLowerCase();
  return cache.entries[normalizedAddress] ?? null;
}

export function saveCreationBlockToCache(address: string, blockNumber: number, txHash: string, deployer: string): void {
  if (g_cacheDisabled) {
    return;
  }
  const cache = loadCreationBlocksCache();
  const normalizedAddress = address.toLowerCase();
  cache.entries[normalizedAddress] = { blockNumber, txHash, deployer };
  g_creationBlockCacheDirty = true;
}

export function loadEventScanFromCache(address: string, currentBlock: number): RoleHoldersMap | null {
  if (g_cacheDisabled) {
    return null;
  }
  const cache = loadEventScansCache();
  const normalizedAddress = address.toLowerCase();
  const entry = cache.entries[normalizedAddress];

  if (!entry) {
    return null;
  }

  // Only use cache if we've scanned up to the current block
  if (entry.lastScannedBlock < currentBlock) {
    return null;
  }

  // Convert serialized format back to Map<string, Set<string>>
  const roleHolders: RoleHoldersMap = new Map();
  for (const [role, holders] of Object.entries(entry.roleHolders)) {
    roleHolders.set(role, new Set(holders));
  }
  return roleHolders;
}

export function getLastScannedBlock(address: string): number | null {
  if (g_cacheDisabled) {
    return null;
  }
  const cache = loadEventScansCache();
  const normalizedAddress = address.toLowerCase();
  const entry = cache.entries[normalizedAddress];
  return entry?.lastScannedBlock ?? null;
}

export function getCachedRoleHolders(address: string): RoleHoldersMap | null {
  if (g_cacheDisabled) {
    return null;
  }
  const cache = loadEventScansCache();
  const normalizedAddress = address.toLowerCase();
  const entry = cache.entries[normalizedAddress];

  if (!entry) {
    return null;
  }

  const roleHolders: RoleHoldersMap = new Map();
  for (const [role, holders] of Object.entries(entry.roleHolders)) {
    roleHolders.set(role, new Set(holders));
  }
  return roleHolders;
}

export function saveEventScanToCache(address: string, roleHolders: RoleHoldersMap, lastScannedBlock: number): void {
  if (g_cacheDisabled) {
    return;
  }
  const cache = loadEventScansCache();
  const normalizedAddress = address.toLowerCase();

  // Convert Map<string, Set<string>> to serializable format
  const serializedRoleHolders: Record<string, string[]> = {};
  for (const [role, holders] of roleHolders) {
    serializedRoleHolders[role] = [...holders];
  }

  cache.entries[normalizedAddress] = {
    roleHolders: serializedRoleHolders,
    lastScannedBlock,
  };
  g_eventScanCacheDirty = true;
}

export function flushCacheUpdates(): void {
  if (g_cacheDisabled) {
    return;
  }
  ensureCacheDirectory();

  if (g_creationBlockCacheDirty && g_creationBlockCache) {
    const cacheFile = path.join(getCacheDirectory(), CREATION_BLOCKS_FILE);
    fs.writeFileSync(cacheFile, JSON.stringify(g_creationBlockCache, null, 2));
    g_creationBlockCacheDirty = false;
    log(`  Saved creation blocks cache`);
  }

  if (g_eventScanCacheDirty && g_eventScanCache) {
    const cacheFile = path.join(getCacheDirectory(), EVENT_SCANS_FILE);
    fs.writeFileSync(cacheFile, JSON.stringify(g_eventScanCache, null, 2));
    g_eventScanCacheDirty = false;
    log(`  Saved event scans cache`);
  }
}

export function clearCacheDirectory(): void {
  const cacheDirectory = getCacheDirectory();
  if (fs.existsSync(cacheDirectory)) {
    fs.rmSync(cacheDirectory, { recursive: true });
    log(`  Cleared cache directory: ${cacheDirectory}`);
  }
  // Reset in-memory caches after clearing disk cache
  g_creationBlockCache = null;
  g_eventScanCache = null;
  g_creationBlockCacheDirty = false;
  g_eventScanCacheDirty = false;
}

export function clearCacheState(): void {
  g_creationBlockCache = null;
  g_eventScanCache = null;
  g_cacheDirectory = null;
  g_creationBlockCacheDirty = false;
  g_eventScanCacheDirty = false;
  g_cacheDisabled = false;
}
