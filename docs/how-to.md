# How-To Guides

[Back to README](../README.md)

## Check every config in a directory

Pass a directory to discover `.yaml` and `.yml` files recursively:

```sh
yarn start path/to/configs
```

Files whose names contain `.seed.` are ignored.

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
