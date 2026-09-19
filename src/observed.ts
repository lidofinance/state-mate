import fs from "node:fs";
import path from "node:path";

import { Result } from "ethers";
import * as YAML from "yaml";

import { type ErrorDetail, redactSecrets } from "./context";
import { log } from "./logger";

// What the chain answered, keyed the way the config asks. The config declares, this file
// observes, and the report is the difference; see docs/observed.md

export type Plain = boolean | null | number | Plain[] | string | { [key: string]: Plain };

export interface ObservedCall {
  args?: Plain[];
  reverted?: string;
  value?: Plain;
}

interface ObservedContract {
  address: string;
  [checksType: string]: Record<string, ObservedCall[]> | Record<string, string> | string;
}

interface ObservedSection {
  block: number | null;
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

export function beginObservedSection(title: string, chainId: string, block: number | null, pinned: boolean): void {
  sections[title] = { chainId, block, pinned, contracts: {} };
}

/** bigint to its decimal text, an ethers Result to an object when its fields are named, else to an array. */
export function toPlain(value: unknown): Plain {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Result) {
    try {
      return Object.fromEntries(Object.entries(value.toObject()).map(([key, item]) => [key, toPlain(item)]));
    } catch {
      return value.toArray().map((item) => toPlain(item));
    }
  }
  if (Array.isArray(value)) return value.map((item) => toPlain(item));
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
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
  outcome: { reverted: string } | { value: unknown },
): void {
  const contract = contractOf(position);
  const checksType = position.checksType ?? "checks";
  contract[checksType] ??= {};
  const calls = contract[checksType] as Record<string, ObservedCall[]>;
  const call: ObservedCall = {};
  if (args && args.length > 0) call.args = args.map((item) => toPlain(item));
  if ("value" in outcome) call.value = toPlain(outcome.value);
  else call.reverted = redactSecrets(outcome.reverted);
  calls[method] ??= [];
  calls[method].push(call);
}

export function recordObservedStorage(position: Partial<ErrorDetail>, slot: string, value: string): void {
  const contract = contractOf(position);
  contract.storage ??= {};
  (contract.storage as Record<string, string>)[slot] = value;
}

export function buildObservedDocument(configPath: string): ObservedDocument {
  return { config: configPath, generated_at: new Date().toISOString(), sections };
}

export function writeObservedFile(filePath: string, configPath: string): void {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, YAML.stringify(buildObservedDocument(configPath)));
  log(`Observed values written to ${filePath}`);
}
