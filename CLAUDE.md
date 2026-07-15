# state-mate

Validates EVM smart-contract state against YAML configs. Calls view functions on deployed contracts and diffs returns against expected values.

## Conventions (non-obvious)

- RPC URLs in configs are given as **env-var names** (e.g. `rpcUrl: ETH_HOODI_RPC_URL`); inline URLs are accepted by the schema but no config uses them. Free public defaults live in `.env.sample` — copy it to `.env` locally (gitignored); CI does the same and overrides via repository secrets.
- Seed configs use a `.seed.yaml` suffix and are consumed by `--generate`, which writes a sibling `*.seed.generated.yaml`. `--generate` only downloads ABIs when combined with `--update-abi`.
- ABIs live in `abis.json.gz` next to the config, keyed by EVM chain ID and lowercase address: `{ "1:0x…": { name, abi } }`. The YAML `name:`/`proxyName:` must equal the stored contract name; `checks` resolve the ABI at `implementation:` (or `address:` for non-proxies), `proxyChecks` at `address:`. `--update-abi` downloads only missing ABIs; to refresh a stale one, delete its `chainId:address` entry and rerun.
- `-o` drills in: `-o l1`, `-o l1/contractName`, `-o l1/contractName/checks/funcName`.

## Layout

`configs/<project>/<mainnet|testnet>/` per deployment — projects: `lido` (core + easy track + safeharbor; testnet = hoodi), `lido-multichain` (wstETH/stETH/a.DI on L2s), `lido-earn`, `mellow` (strategy + DVV), `defiwrapper`. Filenames carry the product and network when a directory spans several (`lido-multichain/mainnet/wsteth-optimism.yaml`, `lido-earn/mainnet/earnusd-vaults-base.yaml`); ABI stores are chainId-scoped so one `abis.json.gz` per directory covers all chains. `src/` is TypeScript; entry is `src/state-mate.ts`. Requires Node ≥20, yarn 4.3.1.

## Scripts (package.json)

- `yarn start <config|directory>` — run a config, or every config in a directory (add `-o …` for scope, `--update-abi` for ABIs, `--generate` for seed; `-o` and `--generate` are file-only).
- `yarn schemas` — regenerate JSON schemas after touching `src/typebox.ts`.
- `yarn lint` / `yarn format` — CI-gated; lint is `--max-warnings=0`.
- `yarn test` — unit tests on `node:test` (`tests/**/*.test.ts`); `yarn test:coverage` adds the coverage report.

## Deeper guidance

Config patterns (proxies, Safe detection, access control, indexed collections, REPLACEME discovery, troubleshooting): `.claude/skills/state-mate/skill.md`.
