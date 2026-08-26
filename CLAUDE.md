# state-mate

Validates EVM smart-contract state against YAML configs. Calls view functions on deployed contracts and diffs returns against expected values.

## Conventions (non-obvious)

- RPC URLs in configs are given as **env-var names** (e.g. `rpcUrl: <NETWORK>_RPC_URL`); inline URLs are accepted by the schema but no config uses them. Free public defaults live in `.env.sample` — copy it to `.env` locally (gitignored); CI does the same and overrides via repository secrets.
- Contracts that need ABIs (entries with `checks`, non-empty `proxyChecks`, or `implementationChecks`) keep their addresses — implementations included — in `deployed:`; that list is what the ABI download walks.
- ABIs live in `abis.json.gz` next to the config, keyed by EVM chain ID and lowercase address: `{ "1:0x…": { name, abi } }`. The YAML `name:`/`proxyName:` must equal the stored contract name; `checks` resolve the ABI at `implementation:` (or `address:` for non-proxies), `proxyChecks` at `address:`. Every run downloads the ABIs missing from the store; `--update-abi` rebuilds it, dropping entries no config references and keeping the stored ABI for any address the explorer refuses.
- `-o` drills in: `-o l1`, `-o l1/contractName`, `-o l1/contractName/checks/funcName`.

## Layout

`configs/<project>/<mainnet|testnet>/` per deployment, one project directory per product family — run `ls configs/` for the current set. Filenames carry the product and network when a directory spans several (`<product>-<network>.yaml`); ABI stores are chainId-scoped so one `abis.json.gz` per directory covers all chains. `src/` is TypeScript; entry is `src/state-mate.ts`. Requires Node ≥22, yarn 4.17.0.

## Scripts (package.json)

- `yarn start <config|directory>` — run a config, or every config in a directory (add `-o …` for scope, `--update-abi` to rebuild the ABI store; `-o` is file-only).
- `yarn schemas` — regenerate JSON schemas after touching `src/typebox.ts`.
- `yarn lint` (biome: TS/JSON lint, format and import order) / `yarn format` (prettier: YAML and Markdown only) / `yarn typecheck` (`tsc --noEmit`, since biome has no type-aware rules) — all three are CI-gated; `yarn lint:fix` and `yarn format:fix` write.
- `yarn test` — unit tests on `node:test` (`tests/**/*.test.ts`); `yarn test:coverage` adds the coverage report.

## Deeper guidance

Config patterns (proxies, Safe detection, access control, indexed collections, REPLACEME discovery, troubleshooting): `.claude/skills/state-mate/skill.md`.
