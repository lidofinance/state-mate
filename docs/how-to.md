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

## Get past an explorer's anti-bot challenge

Explorer requests carry a browser-like User-Agent and a same-origin Referer. The Referer contains only the origin, without query parameters or API keys. If the explorer still returns a challenge, try setting `STATE_MATE_USER_AGENT` in `.env` and re-run. The override applies to explorer and RPC requests.

## Download ABIs when the explorer cannot confirm its chain

Before downloading missing ABIs from a fixed-chain explorer, the run probes the host for its chain id. If the host cannot answer, a run with missing ABIs exits with `could not verify chainId`. Check that the configured explorer serves the intended network before using the override:

```sh
yarn start path/to/config.yaml --update-abi --allow-unverified-explorer
```

The flag permits downloads when the explorer cannot confirm its chain. It still rejects a reported chain mismatch. RPC chain verification, ABI validation, contract-name checks, and state checks remain enabled. These checks do not prove that an ABI came from the intended chain: contracts on different networks can share the same name and interface.

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
