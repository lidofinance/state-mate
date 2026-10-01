# CLI Reference

[Back to README](../README.md)

```text
yarn start <config-path> [options]
```

`config-path` is one YAML file or a directory containing YAML files.

Directory runs discover `.yaml` and `.yml` files recursively, skipping names containing `.seed.` and files ending in `.deployed.yaml`, `.inputs.yaml` (or `.yml`).

| Option                            | Description                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `-o, --only <check-path>`         | Run one section, contract, check type, or method. Requires a single config file                             |
| `--deployed <path>`               | Load deployed address anchors from a separate YAML file; repeatable. Requires a single config file          |
| `--inputs <path>`                 | Load config and external-value anchors from a separate YAML file; repeatable. Requires a single config file |
| `--auto-load-deployed-and-inputs` | For directory runs, load matching `.deployed` and `.inputs` files beside each config                        |
| `--update-abi`                    | Re-download every ABI included in the run; missing ABIs download without this flag                          |
| `--skip-implementation-check`     | Skip automatic implementation-address verification                                                          |
| `--allow-unverified-explorer`     | Download ABIs when a fixed-chain explorer cannot confirm the configured chain ID                            |
| `-q, --quiet`                     | Print contract headers, per-contract totals, warnings, and errors                                           |
| `-J, --json`                      | Write one JSON report to stdout instead of the log; format in [json-output.md](json-output.md)              |

`--deployed` and `--inputs` can be used together. Paths are relative to the working directory; neither file is loaded automatically by default. See the [separate-file examples](how-to.md#separate-deployed-addresses).

Both options may be repeated to compose several files of one kind, for example a shared one and a per-network one:

```sh
yarn start configs/l2.yaml --deployed configs/common.deployed.yaml --deployed configs/optimism.deployed.yaml
yarn start configs/l2.yaml --inputs configs/common.inputs.yaml --inputs configs/optimism.inputs.yaml
```

The files of one kind load in argument order and their sections unite into one: `deployed:` lists under the same chain key (`l1`, `l2`) concatenate, earlier file first, and a chain key present in only one file is carried over; `config:` and `externals:` lists concatenate the same way. Every label must still be unique across all files and referenced by the main config. Selecting the same file twice, under any spelling, is an error.

The composed document has a fixed layout, whatever the argument order and whatever order a file writes its sections in: every `deployed:` entry, then every `externals:` entry, then every `config:` entry, then the main config. Argument order decides only the position of a file's entries inside one section. An alias resolves only to an anchor laid out before it. Since `deployed:` and `externals:` entries are scalars, only a `config:` array holds aliases, and such an array may alias any deployed address or external fact, from any selected file, but a `config:` entry only from the same `--inputs` file or an earlier one. Referencing a later file's `config:` entry is reported as an anchor set later.

For a directory containing split configs, opt into automatic loading:

```sh
yarn start configs/project --auto-load-deployed-and-inputs
```

For each `foo.yaml` or `foo.yml`, this loads `foo.deployed.yaml` / `.yml` and
`foo.inputs.yaml` / `.yml` from the same directory, including nested directories.
Both extensions are accepted independently of the main file's extension. If both
extensions exist for one sibling kind, the run fails instead of choosing one. Automatic mode
selects at most one file of each kind per config, the same-stem one; composing several files of
a kind needs the explicit options.
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
