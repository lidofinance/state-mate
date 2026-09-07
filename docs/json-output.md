# JSON Output Format

[Back to README](../README.md) · [CLI Reference](cli.md)

`yarn start <config> --json` (or `-J`) writes one JSON object to stdout and nothing else. The
human-readable log is not printed. The exit code is the same as without the flag.

```sh
yarn start path/to/config.yaml --json
yarn start path/to/configs --json
```

The report carries the verdict, the counters of every config, and the checks that need
attention: failed checks with their message, and checks that could not run. A contract
whose checks all passed is not listed.

A run that aborts, on a missing config, an unset env var, an ABI the store lacks, or an
`--only` filter that selects nothing, still produces a report with `status: "error"`. So does
Ctrl+C: the report carries what ran before it, `error` reads `interrupted by SIGINT`, the exit
code is 130. Only an unexpected exception adds its stack to stderr.

## Rules for parsers

- Keys whose value would be empty are omitted: a clean config has no `contracts`, a completed
  run has no `error`. `summary` and `configs` are present in every report.
- Read `status` before the exit code. A single-config run exits with the number of failed
  checks, a directory run with 1.
- Addresses appear as written in the config, checksummed or not. Compare them
  case-insensitively.
- RPC URLs and explorer keys read from the environment are replaced by the variable name,
  `$ETH_RPC_URL` for instance, wherever a message quotes them.
- Later versions may add keys. Ignore unknown keys.

## Top level

| Key                | Type                              | Meaning                                                                                                                     |
| ------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `status`           | `"passed"`, `"failed"`, `"error"` | `passed`: every check agreed with the chain. `failed`: at least one check did not. `error`: the run aborted before the end. |
| `exit_code`        | int                               | Process exit code, the same as without `--json`.                                                                            |
| `duration_seconds` | float                             | Wall time of the run.                                                                                                       |
| `filter`           | string                            | The `--only` argument, when one was given.                                                                                  |
| `error`            | string                            | Present when the run aborted: the message the log would have printed.                                                       |
| `summary`          | object                            | Counters over every config, described below.                                                                                |
| `configs`          | array                             | One entry per config file, in run order, described below.                                                                   |

### `summary`

```json
"summary": { "configs": 2, "checks": 310, "errors": 1, "skipped": 12, "warnings": 1 }
```

`checks` counts checks that reached a verdict, `errors` those whose verdict was a mismatch.
`skipped` counts checks that did not run: methods the config pins to `null`, and scans the
chain offers no log source for. `warnings` counts the `warnings` entries below.

## `configs[]`

| Key                           | Present when                          | Meaning                                                                     |
| ----------------------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| `config`                      | always                                | Path of the config file, as resolved from the command line.                 |
| `status`                      | always                                | `passed`, `failed`, or `error` when the run aborted inside this config.     |
| `checks`, `errors`, `skipped` | always                                | The counters of this config; see `summary`.                                 |
| `error`                       | `status` is `error`                   | The abort message. The contracts checked before the abort are still listed. |
| `warnings`                    | a warning fell outside every contract | Same shape as a contract's `warnings`.                                      |
| `contracts`                   | a contract has something to report    | One entry per contract with a failure or a warning, in config order.        |

## `contracts[]`

| Key        | Present when          | Meaning                                                                                |
| ---------- | --------------------- | -------------------------------------------------------------------------------------- |
| `path`     | always                | `<section>/<alias>`, the same path `--only` accepts.                                   |
| `name`     | always                | `name:` from the config.                                                               |
| `address`  | always                | `address:` from the config.                                                            |
| `failures` | a check failed        | `{ type, check, message }` per failed check.                                           |
| `warnings` | a check could not run | `{ check, message }` per check, for example an ACL scan on a chain with no log source. |

`type` names the check type: `checks`, `storage`, `proxyChecks`, `implementationChecks`,
`ozAcl`, `ozNonEnumerableAcl`, `aragonAcl`, or one of the automatic checks `implementation`,
`proxyAdmin`, `proxyAdminOwner`. `check` is the method with its arguments, the storage slot,
or the role and holder, as the log would print it. `message` is the log's failure text with
the colours stripped; on a value mismatch it quotes both the expected and the actual value.

## Example

```json
{
  "status": "failed",
  "exit_code": 1,
  "duration_seconds": 2.4,
  "summary": { "configs": 1, "checks": 8, "errors": 1, "skipped": 1, "warnings": 0 },
  "configs": [
    {
      "config": "configs/example/mainnet/strategy.yaml",
      "status": "failed",
      "checks": 8,
      "errors": 1,
      "skipped": 1,
      "contracts": [
        {
          "path": "l1/callForwarder",
          "name": "CallForwarder",
          "address": "0x7305bB45aF91893B7BCaF0Ad8Eae37cb16820Bb8",
          "failures": [
            {
              "check": "owner",
              "message": "Expected \"0x000000000000000000000000000000000000dEaD\" to equal actual \"0x0000000000000000000000000000000000000000\"",
              "type": "checks"
            }
          ]
        }
      ]
    }
  ]
}
```

`jq` examples:

```sh
# Overall verdict
yarn start cfg.yaml --json | jq -r .status

# Every failed check with its location
yarn start cfg.yaml --json | jq '.configs[].contracts[]? | select(.failures) | {path, failures}'

# Configs that did not pass, in a directory run
yarn start configs/ --json | jq '.configs[] | select(.status != "passed") | {config, status, errors}'
```
