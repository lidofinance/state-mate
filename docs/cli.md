# CLI Reference

[Back to README](../README.md)

```text
yarn start <config-path> [options]
```

`config-path` is one YAML file or a directory containing YAML files.

| Option                        | Description                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `-o, --only <check-path>`     | Run one section, contract, check type, or method. Requires a single config file                      |
| `--update-abi`                | Re-download every ABI included in the run; missing ABIs download without this flag                   |
| `--skip-implementation-check` | Skip automatic implementation-address verification                                                   |
| `--allow-unverified-explorer` | Download ABIs when a fixed-chain explorer cannot confirm the configured chain ID                     |
| `-q, --quiet`                 | Print contract headers, per-contract totals, warnings, and errors                                    |
| `-J, --json`                  | Write one JSON report to stdout instead of the log; format in [json-output.md](json-output.md)       |
| `--block <number\|latest>`    | Read every value at one block; `latest` is resolved once per section. See [observed.md](observed.md) |
| `--observed <file>`           | Write every value the chain answered, with its block, to a YAML file. Requires a single config file  |
| `--expand-enumerations`       | Read every element behind a pinned `<name>Length` and warn about the ones the config omits           |

The filter format is `section/contract/check-type/method`. Each segment after `section` is optional:

```sh
yarn start path/to/config.yaml --only l1
yarn start path/to/config.yaml --only l1/vault
yarn start path/to/config.yaml --only l1/vault/checks
yarn start path/to/config.yaml --only l1/vault/checks/owner
```
