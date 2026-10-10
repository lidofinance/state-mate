# How-To Guides

[Back to README](../README.md)

## Check every config in a directory

Pass a directory to discover `.yaml` and `.yml` files recursively:

```sh
yarn start path/to/configs
```

Files whose names contain `.seed.` or end in `.deployed.yaml`, `.inputs.yaml` (or `.yml`) are ignored.

## Separate deployed addresses

Move the entire `deployed:` section into a separate file to reuse the main config with another deployment:

```yaml
# app.deployed.yaml
deployed:
  l1:
    - &vault "0x1111111111111111111111111111111111111111"
```

Keep references such as `address: *vault` in the main config, with no `deployed:` section:

```sh
yarn start path/to/app.yaml --deployed path/to/app.deployed.yaml
```

The address file may contain only `deployed:`. Each entry must have a unique `&label` and a valid quoted `0x` address or 32-byte hash. Reference every label with a `*alias` in the main config; labels cannot collide across files. RPC and explorer settings stay in the main config.

## Separate input values

Put configurable values in `config:` and external addresses or decimal IDs in `externals:`:

```yaml
# app.inputs.yaml
config:
  - &vaultName "My Vault"
  - &limits [3600, 1800]
externals:
  - &owner "0x2222222222222222222222222222222222222222"
  - &chainId 1
```

Reference these labels in the main config, for example `chainId: *chainId` or `owner: *owner` in a contract's checks. `config:` accepts scalars and arrays; `externals:` accepts addresses, 32-byte hashes, and nonnegative decimal IDs. The same label rules apply. Top-level `config:` and `externals:` sections are allowed only in the inputs file.

```sh
yarn start path/to/app.yaml --inputs path/to/app.inputs.yaml
yarn start path/to/app.yaml --deployed path/to/app.deployed.yaml --inputs path/to/app.inputs.yaml
```

Both options require a single config file. Paths are relative to the working directory, and files are not loaded automatically by default. For directory runs, use [`--auto-load-deployed-and-inputs`](cli.md) to load matching siblings. Keep each file to one YAML document. Existing configs with inline `deployed:` still work without `--deployed`.

For complete examples exercised by CI across Ethereum, Arbitrum, Base, Optimism, and Linea, see [Direct Staking](../configs/lido-direct-staking/README.md).

## Run a focused check

Use `--only` with a single config file. The filter can stop at the section, contract, or check type:

```sh
yarn start path/to/config.yaml --only l1
yarn start path/to/config.yaml --only l1/vault
yarn start path/to/config.yaml --only l1/vault/checks
yarn start path/to/config.yaml --only l1/vault/checks/owner
```

Filtering to a check type skips automatic implementation verification. A declared `proxyAdminOwner` check still runs, but does not count as a match: a filter that selects no check of its own is an error.

## Refresh stored ABIs

Missing ABIs download during a normal run. Use `--update-abi` to re-download every address included in the run:

```sh
yarn start path/to/config.yaml --update-abi
```

Run a directory to refresh its configs and remove ABI entries that no config references:

```sh
yarn start path/to/configs --update-abi
```

A single-file refresh leaves entries used by sibling configs untouched.

## Get past an explorer's anti-bot challenge

Explorer requests carry a browser-like User-Agent and a same-origin Referer. The Referer contains only the origin, without query parameters or API keys. If the explorer still returns a challenge, try setting `STATE_MATE_USER_AGENT` in `.env` and re-run. The override applies to explorer and RPC requests.

## Download ABIs when the explorer cannot confirm its chain

Before downloading missing ABIs from a fixed-chain explorer, the run probes the host for its chain id. If the host cannot answer, a run with missing ABIs exits with `could not verify chainId`. Check that the configured explorer serves the intended network before using the override:

```sh
yarn start path/to/config.yaml --update-abi --allow-unverified-explorer
```

The flag permits downloads when the explorer cannot confirm its chain. It still rejects a reported chain mismatch. RPC chain verification, ABI validation, contract-name checks, and state checks remain enabled. These checks do not prove that an ABI came from the intended chain: contracts on different networks can share the same name and interface.

When you already know which chain the host serves, say so instead, and the host is not probed at all:

```sh
yarn start path/to/config.yaml --trusted-explorer robinhoodchain.blockscout.com=4663
```

A config that names another chain for a trusted host stops the run, as a disagreeing probe does. The option is repeatable and takes comma-separated pairs.

## Configure credentials for ACL scans

Set `explorerTokenEnv` to the API-key variable for the section's `explorerHostname`. ACL scans select their explorer by chain and reuse that key only when the provider matches. For an independent ACL source, set `ETHERSCAN_TOKEN` for Etherscan or `BLOCKSCOUT_TOKEN` for Blockscout. Blockscout scans can also run without a key.

Each explorer host has its own request queue, and on Blockscout each route family has its own. A 429, or any error response with `Retry-After` such as a 503, pauses the queue for the cooldown the server names; a 429 without one pauses it for six seconds. A cooldown above 300 seconds fails the ABI download or the ACL scan as a rate limit. The rules are in [ProxyAdmin verification](abi-and-proxies.md#proxyadmin-verification).

## Keep CI output concise

```sh
yarn start path/to/configs --quiet
```

Quiet mode keeps contract headers, per-contract totals, warnings, and errors.

## Read the results from a script

```sh
yarn start path/to/config.yaml --json | jq -r .status
```

`--json` replaces the log with one JSON report on stdout: the verdict, per-config counters, and every failed check with its location. Contracts whose checks all passed are not listed. The format is documented in [json-output.md](json-output.md).
