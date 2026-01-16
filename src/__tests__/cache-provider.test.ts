import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearCacheDirectory,
  clearCacheState,
  flushCacheUpdates,
  initCacheDirectory,
  loadCreationBlockFromCache,
  loadEventScanFromCache,
  RoleHoldersMap,
  saveCreationBlockToCache,
  saveEventScanToCache,
} from "../cache-provider";

describe("cache-provider", () => {
  let testDirectory: string;
  let testConfigPath: string;

  beforeEach(() => {
    // Create a temporary directory for each test
    testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "state-mate-cache-test-"));
    testConfigPath = path.join(testDirectory, "test-config.yaml");
    // Create a dummy config file
    fs.writeFileSync(testConfigPath, "test: true");
    // Reset cache state
    clearCacheState();
    // Initialize with test config path
    initCacheDirectory(testConfigPath);
  });

  afterEach(() => {
    // Clean up temporary directory
    clearCacheState();
    fs.rmSync(testDirectory, { recursive: true, force: true });
  });

  describe("creation block cache", () => {
    it("returns null for uncached address", () => {
      const result = loadCreationBlockFromCache("0x1234567890123456789012345678901234567890");
      expect(result).toBeNull();
    });

    it("round trip works - save and load", () => {
      const address = "0x1234567890123456789012345678901234567890";
      const blockNumber = 12_345_678;
      const txHash = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
      const deployer = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

      saveCreationBlockToCache(address, blockNumber, txHash, deployer);
      const result = loadCreationBlockFromCache(address);

      expect(result).not.toBeNull();
      expect(result?.blockNumber).toBe(blockNumber);
      expect(result?.txHash).toBe(txHash);
      expect(result?.deployer).toBe(deployer);
    });

    it("normalizes addresses to lowercase", () => {
      const address = "0xABCDEF1234567890ABCDEF1234567890ABCDEF12";
      const blockNumber = 12_345_678;

      saveCreationBlockToCache(address, blockNumber, "0x123", "0xdeployer");

      // Query with lowercase
      const result = loadCreationBlockFromCache(address.toLowerCase());
      expect(result).not.toBeNull();
      expect(result?.blockNumber).toBe(blockNumber);
    });

    it("persists to disk after flush", () => {
      const address = "0x1234567890123456789012345678901234567890";
      saveCreationBlockToCache(address, 12_345, "0xhash", "0xdeployer");
      flushCacheUpdates();

      const cacheFile = path.join(testDirectory, "cache", "creation-blocks.json");
      expect(fs.existsSync(cacheFile)).toBe(true);

      const content = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      expect(content.entries[address.toLowerCase()]).toBeDefined();
    });
  });

  describe("event scan cache", () => {
    it("returns null for uncached scan", () => {
      const result = loadEventScanFromCache("0x1234567890123456789012345678901234567890", 100_000);
      expect(result).toBeNull();
    });

    it("round trip works - save and load", () => {
      const address = "0x1234567890123456789012345678901234567890";
      const currentBlock = 100_000;
      const roleHolders: RoleHoldersMap = new Map();
      const roleId = "0x0000000000000000000000000000000000000000000000000000000000000001";
      const holder = "0xholder1234567890holder1234567890holder12";
      roleHolders.set(roleId, new Set([holder]));

      saveEventScanToCache(address, roleHolders, currentBlock);
      const result = loadEventScanFromCache(address, currentBlock);

      expect(result).not.toBeNull();
      expect(result?.get(roleId)?.has(holder)).toBe(true);
    });

    it("returns null if current block is ahead of cached block", () => {
      const address = "0x1234567890123456789012345678901234567890";
      const cachedBlock = 100_000;
      const currentBlock = 100_001;
      const roleHolders: RoleHoldersMap = new Map();

      saveEventScanToCache(address, roleHolders, cachedBlock);
      const result = loadEventScanFromCache(address, currentBlock);

      expect(result).toBeNull();
    });

    it("returns cached data if current block equals cached block", () => {
      const address = "0x1234567890123456789012345678901234567890";
      const blockNumber = 100_000;
      const roleHolders: RoleHoldersMap = new Map();
      roleHolders.set("role1", new Set(["holder1"]));

      saveEventScanToCache(address, roleHolders, blockNumber);
      const result = loadEventScanFromCache(address, blockNumber);

      expect(result).not.toBeNull();
      expect(result?.get("role1")?.has("holder1")).toBe(true);
    });

    it("persists to disk after flush", () => {
      const address = "0x1234567890123456789012345678901234567890";
      const roleHolders: RoleHoldersMap = new Map();
      roleHolders.set("role1", new Set(["holder1"]));

      saveEventScanToCache(address, roleHolders, 100_000);
      flushCacheUpdates();

      const cacheFile = path.join(testDirectory, "cache", "event-scans.json");
      expect(fs.existsSync(cacheFile)).toBe(true);

      const content = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      expect(content.entries[address.toLowerCase()]).toBeDefined();
    });
  });

  describe("cache persistence", () => {
    it("loads existing cache from disk on re-initialization", () => {
      const address = "0x1234567890123456789012345678901234567890";
      saveCreationBlockToCache(address, 12_345, "0xhash", "0xdeployer");
      flushCacheUpdates();

      // Clear in-memory cache and re-initialize
      clearCacheState();
      initCacheDirectory(testConfigPath);

      const result = loadCreationBlockFromCache(address);
      expect(result).not.toBeNull();
      expect(result?.blockNumber).toBe(12_345);
    });
  });

  describe("cache disabled", () => {
    beforeEach(() => {
      // Re-initialize with cache disabled
      clearCacheState();
      initCacheDirectory(testConfigPath, { disabled: true });
    });

    it("returns null for creation block when disabled", () => {
      const address = "0x1234567890123456789012345678901234567890";
      saveCreationBlockToCache(address, 12_345, "0xhash", "0xdeployer");
      const result = loadCreationBlockFromCache(address);
      expect(result).toBeNull();
    });

    it("returns null for event scan when disabled", () => {
      const address = "0x1234567890123456789012345678901234567890";
      const roleHolders: RoleHoldersMap = new Map();
      roleHolders.set("role1", new Set(["holder1"]));

      saveEventScanToCache(address, roleHolders, 100_000);
      const result = loadEventScanFromCache(address, 100_000);
      expect(result).toBeNull();
    });

    it("does not write to disk when disabled", () => {
      const address = "0x1234567890123456789012345678901234567890";
      saveCreationBlockToCache(address, 12_345, "0xhash", "0xdeployer");
      flushCacheUpdates();

      const cacheFile = path.join(testDirectory, "cache", "creation-blocks.json");
      expect(fs.existsSync(cacheFile)).toBe(false);
    });
  });

  describe("clearCacheDirectory", () => {
    it("removes cache directory and clears in-memory cache", () => {
      const address = "0x1234567890123456789012345678901234567890";
      saveCreationBlockToCache(address, 12_345, "0xhash", "0xdeployer");
      flushCacheUpdates();

      const cacheDirectory = path.join(testDirectory, "cache");
      expect(fs.existsSync(cacheDirectory)).toBe(true);

      clearCacheDirectory();

      expect(fs.existsSync(cacheDirectory)).toBe(false);
      // In-memory cache is also cleared
      const result = loadCreationBlockFromCache(address);
      expect(result).toBeNull();
    });

    it("handles non-existent cache directory gracefully", () => {
      // clearCacheDirectory should not throw if cache dir doesn't exist
      expect(() => clearCacheDirectory()).not.toThrow();
    });
  });
});
