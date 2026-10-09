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

/** A hex block number, or an EIP-1898 hash that the node must still hold on its canonical chain. */
export type PinnedTag = string | { blockHash: string; requireCanonical: true };

const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;

/** "latest", a decimal block number or a block hash; null when the text is none of them. */
export function parseBlockOption(text: string): string | null {
  return /^(latest|\d+)$/.test(text) || BLOCK_HASH.test(text) ? text : null;
}

export function toBlockTag(block: number): string {
  return `0x${block.toString(16)}`;
}

/** Rewrites the "latest" ethers puts into a read so that it names the pinned block instead. */
export function pinBlockTag(method: string, parameters: unknown, blockTag: PinnedTag): unknown {
  const position = BLOCK_TAG_POSITION[method];
  if (position === undefined || !Array.isArray(parameters) || parameters.length < position) return parameters;
  if (parameters.length > position && parameters[position] !== "latest") return parameters;
  const pinned = parameters.slice(0, position);
  pinned.push(blockTag, ...parameters.slice(position + 1));
  return pinned;
}

/** A block number or hash belongs to one chain; on another chain the same height is another block. */
export function assertBlockOnOneChain(chainIds: readonly string[]): void {
  if (context.block === undefined || context.block === "latest" || context.checkOnly) return;
  const chains = new Set(chainIds).size;
  if (chains > 1) {
    logErrorAndExit(
      `A --block number or hash belongs to one chain, but the config spans ${chains} chains; select a section with -o`,
    );
  }
}

/**
 * Resolves --block for one section and pins the provider to it. Every read of the section then
 * comes from one block, so that a list and its length cannot disagree because of an allocation
 * that landed between two calls.
 */
export async function pinSectionBlock(provider: RetryingJsonRpcProvider): Promise<void> {
  if (context.block === undefined) return;
  if (context.block === "latest") {
    const number = await provider.getBlockNumber();
    provider.pinned = { number, tag: toBlockTag(number) };
    log(`Reads pinned to block ${number}`);
    return;
  }
  const byHash = BLOCK_HASH.test(context.block);
  const block = await provider.getBlock(byHash ? context.block : Number(context.block));
  if (block === null) logErrorAndExit(`Block ${context.block} is not on the chain the RPC serves`);
  // A hash pin survives a reorg only as a refusal: requireCanonical makes the node reject a
  // replaced block instead of serving its sibling
  const tag: PinnedTag = byHash
    ? { blockHash: context.block.toLowerCase(), requireCanonical: true }
    : toBlockTag(block.number);
  provider.pinned = { number: block.number, tag };
  log(`Reads pinned to block ${block.number}${byHash ? ` (${context.block})` : ""}`);
}

/**
 * requireCanonical guards the state reads only: log scans take a block range, which a hash
 * cannot name. Re-reading the hash at that height after the section proves the logs came from
 * the same chain as the state.
 */
export async function assertPinnedHashCanonical(provider: RetryingJsonRpcProvider): Promise<void> {
  const tag = provider.pinned?.tag;
  if (typeof tag !== "object" || tag === null) return;
  const current = await provider.getBlock(provider.pinned?.number ?? 0);
  if (current?.hash?.toLowerCase() !== tag.blockHash) {
    logErrorAndExit(`Block ${tag.blockHash} left the canonical chain during the run; re-run on a settled block`);
  }
}
