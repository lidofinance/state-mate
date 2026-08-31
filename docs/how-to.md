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

Filtering to a check type skips automatic implementation verification. A declared `proxyAdminOwner` check still runs.

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

An explorer behind anti-bot protection may reject the default User-Agent; the run fails with an error naming `STATE_MATE_USER_AGENT`. Set that variable in `.env` to another string and re-run — every explorer and RPC request carries it.

## Download ABIs from a Blockscout host

ABI downloads on Blockscout hosts use the native v2 API (`/api/v2/smart-contracts/<address>`). The chain-id probe still goes through the etherscan-compatible v1 routes, and some instances no longer serve those — the probe then warns `could not verify chainId`, and a run with missing ABIs exits. Pass the flag to proceed:

```sh
yarn start path/to/config.yaml --update-abi --allow-unverified-explorer
```

The flag skips only the explorer probe. The RPC's chain is still asserted, the stored contract name must match the config's `name:`, and every check diffs on-chain values through that verified RPC — an ABI taken from the wrong chain fails loudly instead of passing.

## Keep CI output concise

```sh
yarn start path/to/configs --quiet
```

Quiet mode keeps contract headers, per-contract totals, warnings, and errors.
