// Mutable state shared across modules for the config run in progress.
// Lives in a leaf module so that consumers do not import the CLI entrypoint.

export interface CheckOnly {
  section: string;
  contract?: string;
  checksType?: string;
  method?: string;
}

export interface ErrorDetail {
  section: string;
  contract: string;
  contractAddress: string;
  checksType: string;
  method: string;
  message: string;
}

export const context = {
  configPath: "",
  checkOnly: null as CheckOnly | null,
  checkOnlyCmdArg: undefined as string | undefined,
  // --update-abi: rebuild the store from scratch instead of only downloading what is missing
  updateAbi: false,
  skipImplementationCheck: false,
  allowUnverifiedExplorer: false,
  quiet: false,
  // --json: one report on stdout instead of the log; see docs/json-output.md
  json: false,
};

// Values read from the environment that no report may echo back: RPC URLs carry keys, and
// ethers quotes the request URL in its error text. Value → the placeholder that replaces it
const secrets = new Map<string, string>();

export function registerSecret(value: string, placeholder: string): void {
  if (value) secrets.set(value, placeholder);
}

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const [value, placeholder] of secrets) redacted = redacted.split(value).join(placeholder);
  return redacted;
}

export const stats = {
  totalChecks: 0,
  // Methods the config left as null: counted apart from totalChecks, which must mean "verified"
  skipped: 0,
  errors: 0,
  errorDetails: [] as ErrorDetail[],
};

// Needed when running multiple configs in one process (directory mode)
export function resetStats(): void {
  stats.totalChecks = 0;
  stats.skipped = 0;
  stats.errors = 0;
  stats.errorDetails.length = 0;
}
