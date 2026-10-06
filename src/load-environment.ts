import { config } from "dotenv";

// Load `.env` before the modules that read process.env. dotenv 18 prints an "injected env" line to
// stderr unless told to be quiet, and stderr must carry only state-mate's own diagnostics.
config({ quiet: true });
