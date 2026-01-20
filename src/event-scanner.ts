import { id as ethersId, JsonRpcProvider, Log } from "ethers";

import { RoleHoldersMap } from "./cache-provider";
import { log } from "./logger";

// OZ AccessControl event signatures
// event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
// event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
export const ROLE_GRANTED_TOPIC = ethersId("RoleGranted(bytes32,address,address)");
export const ROLE_REVOKED_TOPIC = ethersId("RoleRevoked(bytes32,address,address)");

export interface RoleEvent {
  role: string;
  account: string;
  sender: string;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
  eventType: "granted" | "revoked";
}

export interface EventScanOptions {
  batchSize: number;
  fromBlock: number;
  toBlock: number | "latest";
}

export interface EventScanResult {
  events: RoleEvent[];
  toBlock: number;
}

export function parseRoleEvent(eventLog: Log): RoleEvent {
  const isGrant = eventLog.topics[0] === ROLE_GRANTED_TOPIC;

  // topics[0] = event signature
  // topics[1] = role (bytes32, indexed)
  // topics[2] = account (address, indexed)
  // topics[3] = sender (address, indexed)
  const role = eventLog.topics[1].toLowerCase();
  const account = "0x" + eventLog.topics[2].slice(26); // Extract address from 32-byte topic
  const sender = "0x" + eventLog.topics[3].slice(26);

  return {
    role,
    account: account.toLowerCase(),
    sender: sender.toLowerCase(),
    blockNumber: eventLog.blockNumber,
    logIndex: eventLog.index,
    transactionHash: eventLog.transactionHash,
    eventType: isGrant ? "granted" : "revoked",
  };
}

export function buildRoleHoldersFromEvents(events: RoleEvent[]): RoleHoldersMap {
  const roleHolders: RoleHoldersMap = new Map();

  // Sort events by block number to process chronologically
  // For events in the same block, sort by log index
  const sortedEvents = [...events].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  for (const event of sortedEvents) {
    if (!roleHolders.has(event.role)) {
      roleHolders.set(event.role, new Set());
    }

    const holders = roleHolders.get(event.role)!;

    if (event.eventType === "granted") {
      holders.add(event.account);
    } else {
      holders.delete(event.account);
    }
  }

  return roleHolders;
}

export function mergeRoleHolders(base: RoleHoldersMap, newEvents: RoleEvent[]): RoleHoldersMap {
  // Clone the base map
  const result: RoleHoldersMap = new Map();
  for (const [role, holders] of base) {
    result.set(role, new Set(holders));
  }

  // Apply new events
  const sortedEvents = [...newEvents].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  for (const event of sortedEvents) {
    if (!result.has(event.role)) {
      result.set(event.role, new Set());
    }

    const holders = result.get(event.role)!;

    if (event.eventType === "granted") {
      holders.add(event.account);
    } else {
      holders.delete(event.account);
    }
  }

  return result;
}

export async function scanRoleEvents(
  provider: JsonRpcProvider,
  contractAddress: string,
  options: EventScanOptions,
): Promise<EventScanResult> {
  const { batchSize, fromBlock } = options;
  const toBlock = options.toBlock === "latest" ? await provider.getBlockNumber() : options.toBlock;

  const allEvents: RoleEvent[] = [];
  let processedBatches = 0;
  const totalBatches = Math.ceil((toBlock - fromBlock + 1) / batchSize);

  // Batch fetch events to avoid RPC limits
  for (let start = fromBlock; start <= toBlock; start += batchSize) {
    const end = Math.min(start + batchSize - 1, toBlock);
    processedBatches++;

    if (totalBatches > 1) {
      log(`    Scanning blocks ${start}-${end} (batch ${processedBatches}/${totalBatches})...`);
    }

    try {
      const logs = await provider.getLogs({
        address: contractAddress,
        topics: [[ROLE_GRANTED_TOPIC, ROLE_REVOKED_TOPIC]],
        fromBlock: start,
        toBlock: end,
      });

      for (const eventLog of logs) {
        allEvents.push(parseRoleEvent(eventLog));
      }
    } catch (error) {
      // If batch is too large, try smaller batches
      if (batchSize > 1000 && (error as Error).message?.includes("query returned more than")) {
        log(`    Batch too large, retrying with smaller batch size...`);
        const smallerResult = await scanRoleEvents(provider, contractAddress, {
          batchSize: Math.floor(batchSize / 2),
          fromBlock: start,
          toBlock: end,
        });
        allEvents.push(...smallerResult.events);
      } else {
        throw error;
      }
    }
  }

  return { events: allEvents, toBlock };
}
