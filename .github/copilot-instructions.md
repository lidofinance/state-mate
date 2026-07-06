# state-mate — Copilot cloud agent onboarding

## Repository purpose
- Validates EVM smart-contract state against YAML configs by calling view methods and diffing against expected values.
- Entry point: `src/state-mate.ts`.
- Main working areas:
  - `configs/**` — protocol/network verification configs
  - `src/**` — CLI, schema, ABI/explorer providers, validators
  - `schemas/**` — generated JSON schemas from `src/typebox.ts`

## Environment and setup (do this first)
1. Use Node.js **22** and Yarn **4** (`packageManager: yarn@4.17.0`).
2. Enable Corepack before using Yarn:
   - `corepack enable`
3. Install dependencies:
   - `HUSKY=0 yarn install --immutable`
4. For local config execution, copy `.env.sample` to `.env` and fill RPC/token values.

## Commands you will use most
- Run checker: `yarn start <config-path>`
- Scope checks for speed/debugging:
  - `-o l1`
  - `-o l1/<contractAlias>`
  - `-o l1/<contractAlias>/checks/<method>`
- ABI download:
  - Preferred: `yarn start <config> --update-abi-missing`
  - Overwrite all ABIs: `yarn start <config> --update-abi`
- Seed config generation: `yarn start <config.seed.yaml> --generate --update-abi-missing`
- Lint: `yarn lint`
- Format check: `yarn format`
- Tests: `yarn test`
- Regenerate schemas after `src/typebox.ts` changes: `yarn schemas`

## CI expectations
- `.github/workflows/ci.yaml` runs:
  - matrix `yarn start <config>` on selected configs
  - `yarn lint`
  - `yarn format`
  - `yarn schemas` and checks that `schemas/` has no diff
- Keep schema files in sync whenever types change.

## State-mate conventions that prevent rework
- `rpcUrl` in YAML is often an **env var name** (for example `HOODI_REMOTE_RPC_URL`), not a literal URL; both are supported.
- `deployed` and network sections use fixed keys (`l1` required, `l2` optional).
- Seed files are `*.seed.yaml`; `--generate` writes sibling `*.seed.generated.yaml`.
- `--generate` does not fetch ABIs unless combined with `--update-abi` or `--update-abi-missing`.
- ABI lookup differs by storage mode:
  - consolidated `abis.json(.gz)`: tries `Name-{address}`, then `Name`
  - individual `abi/*.json`: tries `Name.json`, then `Name.sol/Name.json`, then `Name-{address}.json`
- Prefer `--update-abi-missing` to avoid clobbering curated ABI files.

## Common failures and fast workarounds
- `ABI not found` / missing ABI:
  - run `yarn start <config> --update-abi-missing`
  - verify contract `name:` matches ABI naming
- `missing revert data` with `data=null`:
  - often RPC/provider issue, not contract logic
  - re-run with narrower scope (`-o l1/<contractAlias>`) or switch RPC
- `getRoleMemberCount` revert/no matching function:
  - contract is likely non-enumerable AccessControl
  - use `ozNonEnumerableAcl` or explicit `hasRole` checks instead of `ozAcl`
- `Invalid address` in `deployed`:
  - do not use placeholders like `REPLACEME` in `deployed`
  - resolve real addresses first (for proxies use storage/admin/implementation reads)

## Errors encountered during this onboarding task
- Documentation inconsistency found:
  - Some docs mention Node >=20 / Yarn 4.3.1
  - Current project truth is Node 22 and Yarn 4.17.0 (from `package.json` and CI setup action)
- Workaround applied:
  - Follow `package.json` + `.github/actions/setup/action.yml` as the source of truth for runtime/tooling versions.
