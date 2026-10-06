# CLI Reference

[Back to README](../README.md)

```text
yarn start <config-path> [options]
```

`config-path` is one YAML file or a directory containing YAML files.

Directory runs discover `.yaml` and `.yml` files recursively, skipping names containing `.seed.` and files ending in `.deployed.yaml`, `.inputs.yaml` (or `.yml`).

| Option                            | Description                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `-o, --only <check-path>`         | Run one section, contract, check type, or method. Requires a single config file                 |
| `--deployed <path>`               | Load deployed address anchors from a separate YAML file. Requires a single config file          |
| `--inputs <path>`                 | Load config and external-value anchors from a separate YAML file. Requires a single config file |
| `--auto-load-deployed-and-inputs` | For directory runs, load matching `.deployed` and `.inputs` files beside each config            |
| `--update-abi`                    | Re-download every ABI included in the run; missing ABIs download without this flag              |
| `--skip-implementation-check`     | Skip automatic implementation-address verification                                              |
| `--allow-unverified-explorer`     | Download ABIs when a fixed-chain explorer cannot confirm the configured chain ID                |
| `-q, --quiet`                     | Print contract headers, per-contract totals, warnings, and errors                               |
| `-J, --json`                      | Write one JSON report to stdout instead of the log; format in [json-output.md](json-output.md)  |
| `--block <number\|hash\|latest>`  | Read every value at one block; see [Pin reads to one block](#pin-reads-to-one-block)            |

`--deployed` and `--inputs` can be used together. Paths are relative to the working directory; neither file is loaded automatically by default. Each option takes one file: a repeated option is a usage error, so keep all anchors of one kind in one file. See the [separate-file examples](how-to.md#separate-deployed-addresses).

For a directory containing split configs, opt into automatic loading:

```sh
yarn start configs/project --auto-load-deployed-and-inputs
```

For each `foo.yaml` or `foo.yml`, this loads `foo.deployed.yaml` / `.yml` and
`foo.inputs.yaml` / `.yml` from the same directory, including nested directories.
Both extensions are accepted independently of the main file's extension. If both
extensions exist for one sibling kind, the run fails instead of choosing one.
Missing siblings are not loaded; unresolved aliases still fail. Existing sibling
files must satisfy all normal composition rules, including section ownership.
Standalone configs without matching siblings run normally.

The flag requires a directory and cannot be combined with `--deployed` or `--inputs`.
Selected paths appear in JSON reports. Loading errors still stop the directory run;
configs are not silently skipped. CI and nightly invocations must explicitly include
this flag to enable the mode; it also works with `--update-abi`.

The filter format is `section/contract/check-type/method`. Each segment after `section` is optional:

```sh
yarn start path/to/config.yaml --only l1
yarn start path/to/config.yaml --only l1/vault
yarn start path/to/config.yaml --only l1/vault/checks
yarn start path/to/config.yaml --only l1/vault/checks/owner
```

## Pin reads to one block

`--block` sends every `eth_call`, `eth_getStorageAt`, `eth_getCode` and `eth_getBalance` to one block, and the ACL scans end at it. Without it, each read goes to the head of the moment, so a list and its length can come from different blocks.

The value is a block number, a block hash, or `latest`, which is resolved to a number once per network section. A number or a hash needs a single config file, since a directory usually spans several chains, and fails the run if the RPC does not know the block.

A number names whichever block holds that height, so a reorg mid-run can mix two states. A hash is sent as an EIP-1898 reference with `requireCanonical`: after a reorg the node refuses the reads, and the checks fail instead of passing on a mix. Log scans cannot name a hash, so each section ends by re-reading the hash at that height and fails the run if it changed.

Use an archive RPC that is not load-balanced. A pruned backend can answer an old block's storage with zero, and a check that expects zero then passes.

```sh
yarn start configs/vault.yaml --block 65439916
yarn start configs/vault.yaml --block <block-hash>
```
