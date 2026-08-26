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

Etherscan V2 receives the configured chain ID with each request. Before a download from a fixed-chain explorer, state-mate verifies that the explorer serves the configured network. A run with a complete ABI store does not contact the explorer.

During `--update-abi`, an explorer that no longer serves a stored contract does not erase the existing ABI. A section without `explorerHostname` also keeps its stored entries.

## Proxy and implementation safety

Proxy calls execute at the proxy address but use the implementation interface. state-mate resolves `checks` with the ABI at `implementation` and resolves `proxyChecks` with the ABI at `address`.

For each declared `implementation`, state-mate reads the EIP-1967 implementation slot, then falls back to `implementation()` and `proxy__getImplementation()`. Safe proxies use slot `0` because they do not expose those getters. Aragon proxies and Safes must be declared explicitly because they store their implementation outside EIP-1967.

An entry without `implementation` must have an empty EIP-1967 implementation slot. This prevents a proxy from being described as a regular contract and checked with the wrong ABI. An unreadable implementation fails the check; `--skip-implementation-check` is the explicit bypass.

## ProxyAdmin ownership

A declared `proxyAdminOwner` check is independent of the implementation bypass. state-mate reads the EIP-1967 admin slot, calls `owner()` on that address, and compares the result with the config.

The ProxyAdmin address needs no ABI entry. Use a `storage` check when the config must also pin the admin address itself. An admin that does not implement `owner()`, such as a Safe, fails this check and should be asserted through `storage` instead.
