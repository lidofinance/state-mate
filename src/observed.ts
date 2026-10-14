import fs from "node:fs";
import path from "node:path";

import { Result } from "ethers";
import * as YAML from "yaml";

import { context, type ErrorDetail, redactSecrets } from "./context";
import { log } from "./logger";

// What the chain answered, keyed the way the config asks. The config declares, this file
// observes, and the report is the difference; see docs/observed.md

export type Plain = boolean | null | Plain[] | string | { [key: string]: Plain };

export interface ObservedCall {
  args?: Plain[];
  error?: string;
  reverted?: string;
  value?: Plain;
}

interface ObservedContract {
  address: string;
  [checksType: string]: Record<string, ObservedCall[]> | Record<string, string> | string;
}

interface ObservedSection {
  block: number | null;
  // present when --block named a hash
  blockHash?: string;
  chainId: string;
  contracts: Record<string, ObservedContract>;
  pinned: boolean;
}

export interface ObservedDocument {
  config: string;
  generated_at: string;
  sections: Record<string, ObservedSection>;
}

let sections: Record<string, ObservedSection> = {};

export function resetObserved(): void {
  sections = {};
}

export function beginObservedSection(
  title: string,
  chainId: string,
  block: number | null,
  pinned: boolean,
  blockHash?: string,
): void {
  if (!context.observedPath) return;
  sections[title] = { chainId, block, ...(blockHash ? { blockHash } : {}), pinned, contracts: {} };
}

/** bigint to its decimal text, an ethers Result to an object when its fields are named, else to an array. */
export function toPlain(value: unknown): Plain {
  // a config index arrives as a bigint and an expanded one as a number: both are decimal text
  if (typeof value === "bigint" || typeof value === "number") return value.toString();
  if (value instanceof Result) {
    // ethers names the elements of an unnamed array `_`, so a map is right only for real names
    if (value.length === 0) return [];
    try {
      const entries = Object.entries(value.toObject());
      if (entries.length === value.length && entries.every(([key]) => key !== "_")) {
        return Object.fromEntries(entries.map(([key, item]) => [key, toPlain(item)]));
      }
    } catch {
      // unnamed: the array form below
    }
    return value.toArray().map((item) => toPlain(item));
  }
  if (Array.isArray(value)) return value.map((item) => toPlain(item));
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}

function contractOf(position: Partial<ErrorDetail>): ObservedContract {
  const title = position.section ?? "unknown";
  sections[title] ??= { chainId: "", block: null, pinned: false, contracts: {} };
  const contracts = sections[title].contracts;
  const alias = position.contract ?? "unknown";
  contracts[alias] ??= { address: position.contractAddress ?? "unknown" };
  return contracts[alias];
}

export function recordObservedCall(
  position: Partial<ErrorDetail>,
  method: string,
  args: readonly unknown[] | undefined,
  outcome: { error: string } | { reverted: string } | { value: unknown },
): void {
  // without --observed nothing is kept: a run must not hold every answer it asserted
  if (!context.observedPath) return;
  const contract = contractOf(position);
  const checksType = position.checksType ?? "checks";
  contract[checksType] ??= {};
  const calls = contract[checksType] as Record<string, ObservedCall[]>;
  const call: ObservedCall = {};
  if (args && args.length > 0) call.args = args.map((item) => toPlain(item));
  if ("value" in outcome) call.value = toPlain(outcome.value);
  else if ("reverted" in outcome) call.reverted = redactSecrets(outcome.reverted);
  else call.error = redactSecrets(outcome.error);
  calls[method] ??= [];
  calls[method].push(call);
}

export function recordObservedStorage(position: Partial<ErrorDetail>, slot: string, value: string): void {
  if (!context.observedPath) return;
  const contract = contractOf(position);
  contract.storage ??= {};
  (contract.storage as Record<string, string>)[slot] = value;
}

export function buildObservedDocument(configPath: string): ObservedDocument {
  return { config: configPath, generated_at: new Date().toISOString(), sections };
}

/** A run that stopped before its first section read nothing, and leaves the file of an earlier run as it was. */
export function writeObservedFile(filePath: string, configPath: string): void {
  if (Object.keys(sections).length === 0) {
    log(`No section was read; ${filePath} is left as it was`);
    return;
  }
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  // temp + rename: a write that dies short leaves the earlier file whole
  fs.writeFileSync(`${filePath}.tmp`, YAML.stringify(buildObservedDocument(configPath)));
  fs.renameSync(`${filePath}.tmp`, filePath);
  log(`Observed values written to ${filePath}`);
}
