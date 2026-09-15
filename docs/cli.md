# CLI Reference

[Back to README](../README.md)

```text
yarn start <config-path> [options]
```

`config-path` is one YAML file or a directory containing YAML files.

Directory runs discover `.yaml` and `.yml` files recursively, skipping names containing `.seed.` and files ending in `.deployed.yaml`, `.inputs.yaml` (or `.yml`).

| Option                        | Description                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `-o, --only <check-path>`     | Run one section, contract, check type, or method. Requires a single config file                 |
| `--deployed <path>`           | Load deployed address anchors from a separate YAML file. Requires a single config file          |
| `--inputs <path>`             | Load config and external-value anchors from a separate YAML file. Requires a single config file |
| `--update-abi`                | Re-download every ABI included in the run; missing ABIs download without this flag              |
| `--skip-implementation-check` | Skip automatic implementation-address verification                                              |
| `--allow-unverified-explorer` | Download ABIs when a fixed-chain explorer cannot confirm the configured chain ID                |
| `-q, --quiet`                 | Print contract headers, per-contract totals, warnings, and errors                               |
| `-J, --json`                  | Write one JSON report to stdout instead of the log; format in [json-output.md](json-output.md)  |

`--deployed` and `--inputs` can be used together. Paths are relative to the working directory; neither file is loaded automatically. See the [separate-file examples](how-to.md#separate-deployed-addresses).

The filter format is `section/contract/check-type/method`. Each segment after `section` is optional:

```sh
yarn start path/to/config.yaml --only l1
yarn start path/to/config.yaml --only l1/vault
yarn start path/to/config.yaml --only l1/vault/checks
yarn start path/to/config.yaml --only l1/vault/checks/owner
```
