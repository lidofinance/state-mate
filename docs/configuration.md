# Configuration Reference

[Back to README](../README.md)

The generated schema is at [`schemas/main-schema.json`](../schemas/main-schema.json). Working configs are under [`configs/`](../configs/).

A config declares reusable values, addresses to include in the ABI store, and one or two network sections:

```yaml
parameters:
  - &vault "0x0000000000000000000000000000000000000001"
  - &vaultImplementation "0x0000000000000000000000000000000000000002"
  - &admin "0x0000000000000000000000000000000000000003"
  - &vaultProxyAdmin "0x0000000000000000000000000000000000000004"

roles:
  - &DEFAULT_ADMIN_ROLE "0x0000000000000000000000000000000000000000000000000000000000000000"

deployed:
  l1:
    - *vault
    - *vaultImplementation

l1:
  rpcUrl: CHAIN_RPC_URL
  chainId: 12345
  explorerHostname: explorer.example.org
  explorerTokenEnv: EXPLORER_TOKEN
  contracts:
    vault:
      name: Vault
      address: *vault
      proxyName: TransparentUpgradeableProxy
      implementation: *vaultImplementation
      proxyAdmin: *vaultProxyAdmin
      proxyAdminOwner: *admin
      checks:
        owner: *admin
        fee: 100
        balanceOf:
          args: [*admin]
          result: 0
      ozAcl:
        *DEFAULT_ADMIN_ROLE : [*admin]
```

The addresses under `deployed` determine which ABIs state-mate stores. Include implementation addresses used by `checks`.

## Network fields

| Field              | Description                                                         |
| ------------------ | ------------------------------------------------------------------- |
| `rpcUrl`           | An RPC URL or the name of an environment variable that contains one |
| `chainId`          | The positive decimal EVM chain ID expected from the RPC             |
| `explorerHostname` | Optional explorer host used to download missing ABIs                |
| `explorerTokenEnv` | Optional environment variable that contains the explorer API token  |
| `contracts`        | Contract entries keyed by local alias                               |

## Contract fields

| Field                  | Verification                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `checks`               | View-function results at the contract address, using the implementation ABI for proxies |
| `implementationChecks` | View-function results called directly on the implementation address                     |
| `proxyChecks`          | View-function results defined by the proxy ABI                                          |
| `storage`              | Raw storage slot values                                                                 |
| `ozAcl`                | Exact role counts and members for enumerable OpenZeppelin access control                |
| `ozNonEnumerableAcl`   | Declared memberships, plus an event-based enumeration of all actual holders (below)     |
| `implementation`       | The implementation address reported by the chain                                        |
| `proxyAdmin`           | The contract held in the EIP-1967 admin slot                                            |
| `proxyAdminOwner`      | The owner of the `ProxyAdmin` in the EIP-1967 admin slot                                |

Every `view` and `pure` function in the selected ABI must appear in `checks`. A `null` result marks a function as deliberately skipped and reports it in the totals.

## Exhaustive non-enumerable ACL

A holder nobody wrote down is invisible to checks that only ask about the config's own list. So
for every contract carrying `ozNonEnumerableAcl`, state-mate also enumerates the actual holders by
replaying `RoleGranted`/`RoleRevoked` events from the contract's deployment, and reports any live
holder the config does not declare. There is nothing to configure and no way to opt out; a
contract whose access control cannot be checked this way should express its expectations as
`hasRole` entries under `checks` instead.

Every holder the scan finds is re-asked on chain before being reported, and every pair the check
forms an opinion about — declared as well as discovered — is read from the raw membership slot
too. `hasRole` is dispatched through the proxy to whatever is deployed, using an ABI an explorer
served; the slot is derived from the storage layout and touches neither, so it is the one
independent witness. Explorers cap a logs response at a thousand records without saying so, so a
full response is treated as possibly truncated and the block range is halved until every window
comes back short.

The scan refuses to report less than it claims. An explorer that will not answer, a response that
cannot be narrowed, or a contract whose storage matches no known AccessControl layout are errors,
not a quiet fall back to the declared-only checks. A chain with no log source at all is different
and counts as **skipped** — a structural limit, printed in the run's totals, never counted as
passed. The chain-to-source registry lives in `src/acl/log-source.ts`; etherscan-served chains
need `ETHERSCAN_TOKEN`, blockscout-served ones need no key.

Two assumptions carry the result, and the scan checks neither directly. Every membership change
must have emitted a standard event: the storage calibration is the evidence for that, since a
contract keeping roles where AccessControl keeps them is one whose grants emit. And the explorer
must not omit records — truncation is detected, but a source that silently drops one is believed.
A holder an explorer invents is harmless, since nothing is reported without an on-chain
confirmation.

## Check values

Use a direct value for a function without arguments. Use the expanded form for arguments, overloaded signatures, or expected reverts:

```yaml
checks:
  totalSupply: 1000000
  balanceOf:
    args: [*admin]
    result: 100
  overloadedMethod:
    signature: "overloadedMethod(address)"
    args: [*admin]
    result: true
  guardedMethod:
    args: [*admin]
    mustRevert: true
```

Expected values may be scalars, arrays, nested arrays, or flat objects.
