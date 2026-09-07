import { stripVTControlCharacters } from "node:util";

import { context, redactSecrets, stats } from "./context";

// The --json report: the verdict, the counters and nothing that passed. Collected on every
// run and written only when the flag asks for it, so the validators never branch on the mode.

type Status = "error" | "failed" | "passed";

interface Failure {
  check: string;
  message: string;
  type: string;
}

interface Warning {
  check: string;
  message: string;
}

interface ContractReport {
  address: string;
  failures?: Failure[];
  name: string;
  path: string;
  warnings?: Warning[];
}

interface ConfigReport {
  checks: number;
  config: string;
  contracts?: ContractReport[];
  error?: string;
  errors: number;
  skipped: number;
  status: Status;
  warnings?: Warning[];
}

export interface Report {
  configs: ConfigReport[];
  duration_seconds: number;
  error?: string;
  exit_code: number;
  filter?: string;
  status: Status;
  summary: { checks: number; configs: number; errors: number; skipped: number; warnings: number };
}

const startedAt = Date.now();
let configs: ConfigReport[] = [];
let config: ConfigReport | undefined;
let contract: ContractReport | undefined;
// Failures are read back from stats.errorDetails, which every error path already feeds
let failuresBefore = 0;

let emitted = false;

const plain = (text: string) => redactSecrets(stripVTControlCharacters(text));

export function resetReport(): void {
  configs = [];
  config = undefined;
  contract = undefined;
  emitted = false;
}

export function beginConfig(configPath: string): void {
  config = { config: configPath, status: "passed", checks: 0, errors: 0, skipped: 0 };
  configs.push(config);
}

export function endConfig(): void {
  if (!config) return;
  config.checks = stats.totalChecks;
  config.errors = stats.errors;
  config.skipped = stats.skipped;
  config.status = stats.errors ? "failed" : "passed";
  config = undefined;
}

export function beginContract(path: string, name: string, address: string): void {
  contract = { path, name, address };
  failuresBefore = stats.errorDetails.length;
}

/** A contract enters the report only with something to say: a failed check or a check that did not run. */
export function endContract(): void {
  if (!contract) return;
  const failures = stats.errorDetails
    .slice(failuresBefore)
    .map(({ checksType, method, message }) => ({ check: method, message: plain(message), type: checksType }));
  if (failures.length > 0) contract.failures = failures;
  if (config && (contract.failures || contract.warnings)) {
    config.contracts ??= [];
    config.contracts.push(contract);
  }
  contract = undefined;
}

export function recordWarning(check: string, message: string): void {
  const target = contract ?? config;
  if (!target) return;
  target.warnings ??= [];
  target.warnings.push({ check: plain(check), message: plain(message) });
}

export function buildReport(exitCode: number, error?: string): Report {
  // A run that aborted leaves its config, and maybe a contract, open; what they reached is still worth reading
  if (config && error) {
    endContract();
    endConfig();
    const aborted = configs.at(-1)!;
    aborted.status = "error";
    aborted.error = plain(error);
  }
  const summary = { configs: configs.length, checks: 0, errors: 0, skipped: 0, warnings: 0 };
  for (const entry of configs) {
    summary.checks += entry.checks;
    summary.errors += entry.errors;
    summary.skipped += entry.skipped;
    summary.warnings += entry.warnings?.length ?? 0;
    for (const item of entry.contracts ?? []) summary.warnings += item.warnings?.length ?? 0;
  }
  const status: Status = error ? "error" : summary.errors ? "failed" : "passed";
  return {
    status,
    exit_code: exitCode,
    duration_seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    filter: context.checkOnlyCmdArg,
    error: error === undefined ? undefined : plain(error),
    summary,
    configs,
  };
}

/**
 * Writes the report once. Sets the exit code instead of exiting: a pipe takes a large report in
 * several writes, and process.exit would cut it after the first one; a caller that must exit
 * on the spot does so from onFlushed.
 */
export function emitReport(exitCode: number, error?: string, onFlushed?: () => void): void {
  if (!context.json || emitted) return;
  emitted = true;
  process.stdout.write(`${JSON.stringify(buildReport(exitCode, error), null, 2)}\n`, onFlushed);
  process.exitCode = exitCode;
}
