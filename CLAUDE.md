# state-mate

Validates EVM smart-contract state against YAML configs. Calls view functions on deployed contracts and diffs returns against expected values.

## Conventions (non-obvious)

- RPC URLs in configs are typically given as **env-var names**, not URLs (e.g. `rpcUrl: HOODI_REMOTE_RPC_URL`). A few configs inline URLs directly — both forms are accepted. Copy `.env.sample` → `.env` and fill values in locally; `.env` is gitignored.
- Seed configs use a `.seed.yaml` suffix and are consumed by `--generate`, which writes a sibling `*.seed.generated.yaml`. `--generate` only downloads ABIs when combined with `--update-abi-missing` / `--update-abi`.
- ABI lookup differs by mode. Consolidated (`abis.json.gz`): tries `Name-{addr}` key first, then `Name`. Individual (`abi/*.json`): tries `Name.json`, then `Name.sol/Name.json`, then `Name-{addr}.json`. Prefer `--update-abi-missing` over `--update-abi` (the latter overwrites existing ABIs).
- `-o` drills in: `-o l1`, `-o l1/contractName`, `-o l1/contractName/checks/funcName`.

## Layout

`configs/<protocol>/` per deployment — e.g. `lido/mainnet`, `lido/hoodi`, `meta/ethereum`, `meta/base`, plus many L2s. `src/` is TypeScript; entry is `src/state-mate.ts`. Requires Node ≥20, yarn 4.3.1.

## Scripts (package.json)

- `yarn start <config>` — run a config (add `-o …` for scope, `--update-abi-missing` for ABIs, `--generate` for seed).
- `yarn schemas` — regenerate JSON schemas after touching `src/typebox.ts`.
- `yarn consolidate-abi <abi-dir>` — pack a `<dir>/abi/*.json` tree into `<dir>/abis.json.gz`.
- `yarn lint` / `yarn format` — CI-gated; lint is `--max-warnings=0`.
- `yarn test` — unit tests (`src/test-util/app.ts`).

## Deeper guidance

Config patterns (proxies, Safe detection, access control, indexed collections, REPLACEME discovery, troubleshooting): `.claude/skills/state-mate/skill.md`.
