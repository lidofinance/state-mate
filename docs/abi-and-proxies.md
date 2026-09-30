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

Etherscan V2 receives the configured chain ID with each request. Before a download from a fixed-chain explorer, state-mate verifies that the explorer serves the configured network. If the probe cannot answer, downloads require the explicit [unverified-explorer override](how-to.md#download-abis-when-the-explorer-cannot-confirm-its-chain). A reported chain mismatch is always rejected.

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

Explorer requests share a cooldown per host, and on Blockscout per route family
(`/api/v2`, `/api/eth-rpc`, the rest of `/api`), since each family has its own
quota. Retry-After accepts integer seconds or an HTTP-date in UTC. Blockscout
reset headers are read as milliseconds only on a 429 when bypass-429-option
identifies the response; bare rate-limit counts do not establish a window. Cooldowns do not permanently increase request spacing.
The ABI download's existing single retry and its queued waits share a 300-second
wait budget; the Blockscout route probe, run once per host, waits outside it.
An excessive cooldown fails explicitly rather than retrying early; an
unsuccessful ABI download remains unresolved, and an ACL scan fails as a rate
limit. This bounds waiting, not network
request duration. A failed wait does not reject later requests in the host queue.
