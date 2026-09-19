import { context } from "./context";
import type { RetryingJsonRpcProvider } from "./explorer";
import { log, logErrorAndExit } from "./logger";

// The block tag sits at a fixed position in the parameters of every read ethers sends
const BLOCK_TAG_POSITION: Record<string, number> = {
  eth_call: 1,
  eth_getStorageAt: 2,
  eth_getCode: 1,
  eth_getBalance: 1,
};

/** "latest" or a decimal block number; null when the text is neither. */
export function parseBlockOption(text: string): string | null {
  return /^(latest|\d+)$/.test(text) ? text : null;
}

export function toBlockTag(block: number): string {
  return `0x${block.toString(16)}`;
}

/** Rewrites the "latest" ethers puts into a read so that it names the pinned block instead. */
export function pinBlockTag(method: string, parameters: unknown, blockTag: string): unknown {
  const position = BLOCK_TAG_POSITION[method];
  if (position === undefined || !Array.isArray(parameters) || parameters.length < position) return parameters;
  if (parameters.length > position && parameters[position] !== "latest") return parameters;
  const pinned = parameters.slice(0, position);
  pinned.push(blockTag, ...parameters.slice(position + 1));
  return pinned;
}

/**
 * Resolves --block for one section and pins the provider to it. Every read of the section then
 * comes from one block, so that a list and its length cannot disagree because of an allocation
 * that landed between two calls.
 */
export async function pinSectionBlock(provider: RetryingJsonRpcProvider): Promise<number | undefined> {
  if (context.block === undefined) return undefined;
  const block = context.block === "latest" ? await provider.getBlockNumber() : Number(context.block);
  if (context.block !== "latest" && (await provider.getBlock(block)) === null) {
    logErrorAndExit(`Block ${block} is not on the chain the RPC serves`);
  }
  provider.pinnedBlock = block;
  log(`Reads pinned to block ${block}`);
  return block;
}
