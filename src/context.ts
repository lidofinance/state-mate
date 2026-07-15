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
  generate: false,
  updateAbi: false,
};

export const stats = {
  totalChecks: 0,
  errors: 0,
  errorDetails: [] as ErrorDetail[],
};

// Needed when running multiple configs in one process (directory mode)
export function resetStats(): void {
  stats.totalChecks = 0;
  stats.errors = 0;
  stats.errorDetails.length = 0;
}
