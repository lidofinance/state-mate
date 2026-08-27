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
| `ozNonEnumerableAcl`   | Declared memberships across the roles and holders listed in the config                  |
| `implementation`       | The implementation address reported by the chain                                        |
| `proxyAdmin`           | The contract held in the EIP-1967 admin slot                                            |
| `proxyAdminOwner`      | The owner of the `ProxyAdmin` in the EIP-1967 admin slot                                |

Every `view` and `pure` function in the selected ABI must appear in `checks`. A `null` result marks a function as deliberately skipped and reports it in the totals.

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
