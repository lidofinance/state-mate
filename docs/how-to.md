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

### Compose shared and per-network address files

When several deployments share one wiring config and some addresses (say, one L1 workflow serving four L2 networks), split the addresses by what they are shared with and repeat `--deployed`:

```yaml
# common.deployed.yaml — shared by every network
deployed:
  l1:
    - &l1Workflow "0x1111111111111111111111111111111111111111"
```

```yaml
# optimism.deployed.yaml — this network only
deployed:
  l1:
    - &optimismRouter "0x3333333333333333333333333333333333333333"
  l2:
    - &l2Bridge "0x2222222222222222222222222222222222222222"
```

```sh
yarn start path/to/l2.yaml --deployed path/to/common.deployed.yaml --deployed path/to/optimism.deployed.yaml
```

The files load in argument order and their `deployed:` maps unite: `deployed.l1` becomes the common list followed by the network list, and `deployed.l2` comes from the network file alone. Labels stay unique across all files, every label must be referenced, and the same file cannot be selected twice. Diagnostics name the file they point at.

`--inputs` composes the same way: repeat it, and the `config:` and `externals:` lists of every selected file concatenate in argument order. A `config:` array may alias any deployed address or external fact, whichever file and flag position holds it; a `config:` entry it aliases must come from the same `--inputs` file or an earlier one. The [CLI reference](cli.md) states the full layout.

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
