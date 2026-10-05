# ABI and Proxy Concepts

[Back to README](../README.md)

## ABI lifecycle

state-mate keeps one compressed `abis.json.gz` beside each group of configs. Entries use the EVM chain ID and lowercase address as their key:

```json
{
  "12345:0x0000000000000000000000000000000000000001": {
    "name": "Vault",
    "abi": []
  }
}
```

The chain ID prevents collisions when different networks deploy contracts at the same address. The YAML `name` must match the contract or implementation ABI. When `proxyChecks` run, `proxyName` must match the proxy ABI.

Etherscan V2 receives the configured chain ID with each request. Before a download from a fixed-chain explorer, state-mate verifies that the explorer serves the configured network. If the probe cannot answer, downloads require the explicit [unverified-explorer override](how-to.md#download-abis-when-the-explorer-cannot-confirm-its-chain). A reported chain mismatch is always rejected. A caller that already knows the host's chain passes `--trusted-explorer <host>=<chainId>`: that host is not probed, and a config naming another chain for it stops the run.

Blockscout instances are detected with one shared API probe per host, including concurrent downloads. Their ABIs come from `/api/v2/smart-contracts/<address>`; other explorers keep the Etherscan-compatible route. A missing or malformed ABI skips that address.

A complete ABI store avoids explorer requests for ABI downloads. Exhaustive ACL checks can still query their log source.

During `--update-abi`, an explorer that no longer serves a stored contract does not erase the existing ABI. A section without `explorerHostname` also keeps its stored entries.

## Proxy and implementation safety

Proxy calls execute at the proxy address but use the implementation interface. state-mate resolves `checks` with the ABI at `implementation` and resolves `proxyChecks` with the ABI at `address`.

For each declared `implementation`, state-mate reads the EIP-1967 implementation slot, then falls back to `implementation()` and `proxy__getImplementation()`. Safe proxies use slot `0` because they do not expose those getters. Aragon proxies and Safes must be declared explicitly because they store their implementation outside EIP-1967.

An entry without `implementation` must have an empty EIP-1967 implementation slot. This prevents a proxy from being described as a regular contract and checked with the wrong ABI. An unreadable implementation fails the check; `--skip-implementation-check` is the explicit bypass.

## ProxyAdmin verification

The `proxyAdmin` and `proxyAdminOwner` checks are independent of the implementation bypass and share one read of the EIP-1967 admin slot. `proxyAdmin` pins the contract the slot holds; `proxyAdminOwner` calls `owner()` on that contract and compares the answer. They answer different questions — an unexpected ProxyAdmin owned by the expected owner passes `proxyAdminOwner` alone — so pin both when the admin contract itself matters.

Neither field needs an ABI entry. An admin that does not implement `owner()`, such as a Safe, fails `proxyAdminOwner` and should be pinned with `proxyAdmin` instead.

Each explorer host has one request queue, spaced at three requests per second. Blockscout keeps a separate quota for each route family (`/api/v2`, `/api/eth-rpc` and the rest of `/api`), so there each family gets its own queue. A 429, or any error response with `Retry-After` such as a 503, pauses the queue for the cooldown the server names: `Retry-After` in integer seconds or as an HTTP date in UTC, or, on a Blockscout 429 identified by `bypass-429-option`, `x-ratelimit-reset` in milliseconds. A bare rate-limit count names no window and is ignored. Without a usable header the queue pauses for six seconds, and the spacing does not grow.

Each ABI download has a 300-second wait budget for its queue waits and its single retry. The Blockscout route probe runs once per host and waits outside this budget. A longer cooldown fails at once instead of retrying early: the ABI stays unresolved, and an ACL scan fails as a rate limit. The budget bounds waiting, not network time. A failed wait does not block later requests in the queue.
