# state-mate

Validates EVM smart-contract state against YAML configs. Calls view functions on deployed contracts and diffs returns against expected values.

## Conventions (non-obvious)

- RPC URLs in configs are typically given as **env-var names**, not URLs (e.g. `rpcUrl: HOODI_REMOTE_RPC_URL`). A few configs inline URLs directly — both forms are accepted. Copy `.env.sample` → `.env` and fill values in locally; `.env` is gitignored.
- Seed configs use a `.seed.yaml` suffix and are consumed by `--generate`, which writes a sibling `*.seed.generated.yaml`. `--generate` only downloads ABIs when combined with `--update-abi-missing` / `--update-abi`.
- **Separate deployed addresses (full delegation)**: a config can keep its _wiring_ (the `*label` aliases) in the main file and put the _addresses_ in a sibling `<name>.deployed.<ext>` file. When a `.deployed` file is in play, the main config must hold **no `deployed:` section**; the `.deployed` file holds only `deployed:` (one `&label` per address) and is the sole source of those anchors. The two are concatenated (addresses first) and parsed as one YAML stream so aliases resolve natively. Four invariants are enforced (else hard error): every address has an `&label`, every label is referenced by a `*alias` in main, main has no `deployed:`, and no label is duplicated or collides with a main-config anchor. The `.deployed` file must be a **single YAML document** holding only `deployed:`, and every value must be a valid `0x` address/hash (checked early — the schema's own format is permissive). The sibling is auto-loaded when present; `--deployed <path>` selects a variant (e.g. `lido.hoodi.deployed.yaml`). Ignored with `--generate`. Configs with an inline `deployed:` and no sibling are unaffected. Complementary to seed/`--generate`: seed _bootstraps_ a full config from an address book; `.deployed` _swaps_ the addresses of an existing config. Implemented in `src/deployed-addresses.ts` as a thin spec over the shared engine `src/sibling-delegation.ts`.
- **Separate inputs (full delegation)**: the dual of `.deployed`. `.deployed` externalizes a deployment's _outputs_ (its own deployed addresses); a sibling `<name>.inputs.<ext>` externalizes its _inputs_, split into two groups **by authorship**: `config:` — project-chosen, configurable values/knobs (any anchored scalar **or array**, e.g. `&oracleReportLimits [..]`, `&lidoName "stETH"`; **no** address check), and `externals:` — fixed third-party/external facts (3rd-party contract addresses **plus `chainId`**). Each entry carries one `&label`. Same full-delegation model and four invariants as `.deployed` (main holds **no `config:`/`externals:` section**; every label referenced by a `*alias`; no duplicate/collision). `externals` **string** values must be a valid `0x` address/hash (catches REPLACEME/env-names/typos); **numeric** values (`&chainId 560048`) are exempt. `chainId` stays consumed positionally as `l1.chainId: *chainId` — only its value is delegated. Auto-loaded when present; `--inputs <path>` selects a variant; ignored with `--generate`. **Additive/opt-in** — the legacy top-level `parameters:` section (used in some configs for external addresses) is untouched, and a `.deployed` and a `.inputs` sibling may be in play at once (all concatenated, anchors first). Implemented in `src/inputs.ts` over `src/sibling-delegation.ts`.
- ABI lookup differs by mode. Consolidated (`abis.json.gz`): tries `Name-{addr}` key first, then `Name`. Individual (`abi/*.json`): tries `Name.json`, then `Name.sol/Name.json`, then `Name-{addr}.json`. Prefer `--update-abi-missing` over `--update-abi` (the latter overwrites existing ABIs).
- `-o` drills in: `-o l1`, `-o l1/contractName`, `-o l1/contractName/checks/funcName`.

## Layout

`configs/<protocol>/` per deployment — e.g. `lido/mainnet`, `lido/hoodi`, `meta/ethereum`, `meta/base`, plus many L2s. `src/` is TypeScript; entry is `src/state-mate.ts`. Requires Node ≥20, yarn 4.3.1.

## Scripts (package.json)

- `yarn start <config>` — run a config (add `-o …` for scope, `--update-abi-missing` for ABIs, `--generate` for seed).
- `yarn schemas` — regenerate JSON schemas after touching `src/typebox.ts`.
- `yarn consolidate-abi <abi-dir>` — pack a `<dir>/abi/*.json` tree into `<dir>/abis.json.gz`.
- `yarn lint` / `yarn format` — CI-gated; lint is `--max-warnings=0`.
- `yarn test` — cross-repo comparison harness (`src/test-util/app.ts`); `yarn test:unit` — fast standalone unit tests (`src/test-util/*.test.ts`: `deployed-addresses.test.ts`, `inputs.test.ts`).

## Deeper guidance

Config patterns (proxies, Safe detection, access control, indexed collections, REPLACEME discovery, troubleshooting): `.claude/skills/state-mate/skill.md`.
