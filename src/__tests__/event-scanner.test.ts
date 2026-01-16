import { Log } from "ethers";
import { describe, expect, it } from "vitest";

import {
  buildRoleHoldersFromEvents,
  mergeRoleHolders,
  parseRoleEvent,
  RoleEvent,
  ROLE_GRANTED_TOPIC,
  ROLE_REVOKED_TOPIC,
} from "../event-scanner";

// Helper to create mock Log objects
function createMockLog(
  topic0: string,
  role: string,
  account: string,
  sender: string,
  blockNumber: number,
  txHash: string,
): Log {
  // Pad addresses to 32 bytes (topics are 32 bytes)
  const paddedRole = role.padEnd(66, "0").slice(0, 66);
  const paddedAccount = "0x" + "0".repeat(24) + account.slice(2).toLowerCase();
  const paddedSender = "0x" + "0".repeat(24) + sender.slice(2).toLowerCase();

  return {
    topics: [topic0, paddedRole, paddedAccount, paddedSender],
    blockNumber,
    transactionHash: txHash,
    // These are not used by parseRoleEvent but required by Log type
    address: "0x1234567890123456789012345678901234567890",
    data: "0x",
    index: 0,
    transactionIndex: 0,
    removed: false,
    blockHash: "0x" + "0".repeat(64),
    toJSON: () => ({}),
    getBlock: async () => null as never,
    getTransaction: async () => null as never,
    getTransactionReceipt: async () => null as never,
    removedEvent: () => null as never,
    provider: null as never,
  } as unknown as Log;
}

describe("parseRoleEvent", () => {
  const testRole = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const testAccount = "0x1234567890123456789012345678901234567890";
  const testSender = "0xabcdef1234567890abcdef1234567890abcdef12";

  it("correctly parses RoleGranted events", () => {
    const log = createMockLog(ROLE_GRANTED_TOPIC, testRole, testAccount, testSender, 12_345, "0xabc123");

    const result = parseRoleEvent(log);

    expect(result.eventType).toBe("granted");
    expect(result.role).toBe(testRole);
    expect(result.account).toBe(testAccount.toLowerCase());
    expect(result.blockNumber).toBe(12_345);
    expect(result.transactionHash).toBe("0xabc123");
  });

  it("correctly parses RoleRevoked events", () => {
    const log = createMockLog(ROLE_REVOKED_TOPIC, testRole, testAccount, testSender, 12_346, "0xdef456");

    const result = parseRoleEvent(log);

    expect(result.eventType).toBe("revoked");
    expect(result.role).toBe(testRole);
    expect(result.account).toBe(testAccount.toLowerCase());
    expect(result.blockNumber).toBe(12_346);
  });
});

describe("buildRoleHoldersFromEvents", () => {
  const roleA = "0x0000000000000000000000000000000000000000000000000000000000000001";
  const roleB = "0x0000000000000000000000000000000000000000000000000000000000000002";
  const holder1 = "0x1111111111111111111111111111111111111111";
  const holder2 = "0x2222222222222222222222222222222222222222";
  const sender = "0x3333333333333333333333333333333333333333";

  it("builds correct map from grant events", () => {
    const events: RoleEvent[] = [
      { role: roleA, account: holder1, sender, blockNumber: 100, transactionHash: "0x1", eventType: "granted" },
      { role: roleA, account: holder2, sender, blockNumber: 101, transactionHash: "0x2", eventType: "granted" },
    ];

    const result = buildRoleHoldersFromEvents(events);

    expect(result.get(roleA)?.has(holder1)).toBe(true);
    expect(result.get(roleA)?.has(holder2)).toBe(true);
    expect(result.get(roleA)?.size).toBe(2);
  });

  it("handles revoke events correctly", () => {
    const events: RoleEvent[] = [
      { role: roleA, account: holder1, sender, blockNumber: 100, transactionHash: "0x1", eventType: "granted" },
      { role: roleA, account: holder1, sender, blockNumber: 200, transactionHash: "0x2", eventType: "revoked" },
    ];

    const result = buildRoleHoldersFromEvents(events);

    expect(result.get(roleA)?.has(holder1)).toBe(false);
    expect(result.get(roleA)?.size).toBe(0);
  });

  it("processes events in chronological order", () => {
    // Events are out of order but should be sorted by block number
    const events: RoleEvent[] = [
      { role: roleA, account: holder1, sender, blockNumber: 200, transactionHash: "0x2", eventType: "revoked" },
      { role: roleA, account: holder1, sender, blockNumber: 100, transactionHash: "0x1", eventType: "granted" },
    ];

    const result = buildRoleHoldersFromEvents(events);

    // After sorting: grant at 100, revoke at 200 -> holder should be removed
    expect(result.get(roleA)?.has(holder1)).toBe(false);
  });

  it("handles multiple roles per address", () => {
    const events: RoleEvent[] = [
      { role: roleA, account: holder1, sender, blockNumber: 100, transactionHash: "0x1", eventType: "granted" },
      { role: roleB, account: holder1, sender, blockNumber: 101, transactionHash: "0x2", eventType: "granted" },
    ];

    const result = buildRoleHoldersFromEvents(events);

    expect(result.get(roleA)?.has(holder1)).toBe(true);
    expect(result.get(roleB)?.has(holder1)).toBe(true);
  });

  it("empty events returns empty map", () => {
    const result = buildRoleHoldersFromEvents([]);

    expect(result.size).toBe(0);
  });

  it("handles grant-revoke-grant sequence", () => {
    const events: RoleEvent[] = [
      { role: roleA, account: holder1, sender, blockNumber: 100, transactionHash: "0x1", eventType: "granted" },
      { role: roleA, account: holder1, sender, blockNumber: 200, transactionHash: "0x2", eventType: "revoked" },
      { role: roleA, account: holder1, sender, blockNumber: 300, transactionHash: "0x3", eventType: "granted" },
    ];

    const result = buildRoleHoldersFromEvents(events);

    expect(result.get(roleA)?.has(holder1)).toBe(true);
  });
});

describe("mergeRoleHolders", () => {
  const roleA = "0x0000000000000000000000000000000000000000000000000000000000000001";
  const holder1 = "0x1111111111111111111111111111111111111111";
  const holder2 = "0x2222222222222222222222222222222222222222";
  const sender = "0x3333333333333333333333333333333333333333";

  it("merges new events with existing role holders", () => {
    const base = new Map<string, Set<string>>();
    base.set(roleA, new Set([holder1]));

    const newEvents: RoleEvent[] = [
      { role: roleA, account: holder2, sender, blockNumber: 200, transactionHash: "0x2", eventType: "granted" },
    ];

    const result = mergeRoleHolders(base, newEvents);

    expect(result.get(roleA)?.has(holder1)).toBe(true);
    expect(result.get(roleA)?.has(holder2)).toBe(true);
    expect(result.get(roleA)?.size).toBe(2);
  });

  it("does not modify the original base map", () => {
    const base = new Map<string, Set<string>>();
    base.set(roleA, new Set([holder1]));

    const newEvents: RoleEvent[] = [
      { role: roleA, account: holder2, sender, blockNumber: 200, transactionHash: "0x2", eventType: "granted" },
    ];

    mergeRoleHolders(base, newEvents);

    // Original base should be unchanged
    expect(base.get(roleA)?.has(holder2)).toBe(false);
  });

  it("handles revoke in new events removing from base", () => {
    const base = new Map<string, Set<string>>();
    base.set(roleA, new Set([holder1]));

    const newEvents: RoleEvent[] = [
      { role: roleA, account: holder1, sender, blockNumber: 200, transactionHash: "0x2", eventType: "revoked" },
    ];

    const result = mergeRoleHolders(base, newEvents);

    expect(result.get(roleA)?.has(holder1)).toBe(false);
  });
});
