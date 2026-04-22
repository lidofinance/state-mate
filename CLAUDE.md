# state-mate

Validates EVM smart-contract state against YAML configs. Calls view functions on deployed contracts and diffs returns against expected values.

## Conventions (non-obvious)

- RPC URLs in configs are typically given as **env-var names**, not URLs (e.g. `rpcUrl: HOODI_REMOTE_RPC_URL`). Values live in `.env`; see `.env.sample` for canonical names. A few configs inline URLs directly — both forms are accepted.
- Do not edit `.env` — a cached fork runs on `localhost:8545`.
- Seed configs use a `.seed.yml` suffix and are consumed by `--generate`, which writes a sibling `*.seed.generated.yml`.
- ABI resolution order: `Name-{proxyAddr}.json` → `Name.json` → `Name-{implAddr}.json`. Prefer `--update-abi-missing` over `--update-abi` (the latter overwrites existing ABIs).
- `-o` drills in: `-o l1`, `-o l1/contractName`, `-o l1/contractName/checks/funcName`.

## Layout

`configs/<protocol>/` per deployment — e.g. `lidov3/mainnet`, `lidov3/hoodi`, `meta/ethereum`, `meta/base`, plus many L2s. `src/` is TypeScript; entry is `src/state-mate.ts`. Requires Node ≥20, yarn 4.3.1.

## Scripts (package.json)

- `yarn start <config>` — run a config (add `-o …` for scope, `--update-abi-missing` for ABIs, `--generate` for seed).
- `yarn schemas` — regenerate JSON schemas after touching `src/types.ts`.
- `yarn consolidate-abi <abi-dir>` — pack a `<dir>/abi/*.json` tree into `<dir>/abis.json.gz`.
- `yarn lint` / `yarn format` — CI-gated; lint is `--max-warnings=0`.
- `yarn test` — unit tests (`src/test-util/app.ts`).

## Deeper guidance

Config patterns (proxies, Safe detection, access control, indexed collections, REPLACEME discovery, troubleshooting): `.claude/skills/state-mate/skill.md`.
