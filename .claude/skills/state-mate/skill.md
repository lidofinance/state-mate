---
name: state-mate
description: Configure and verify state-mate YAML for EVM smart-contract state checks — contracts, proxies (Transparent, Ossifiable, AppProxyUpgradeable), Safe multisigs, ozAcl and ozNonEnumerableAcl access control, ABI resolution and updates, EIP-1967 storage slots, seed configs and --generate, REPLACEME discovery, and common error triage.
---

# State-Mate Skill

Validate EVM smart-contract state against YAML configs. state-mate calls view functions and diffs returns against the expected values you declare.

## Pick a section

| Task                                                   | Go to                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| New config from scratch                                | [Top-level structure](#top-level-structure), [Workflow](#workflow) |
| Contract with a proxy                                  | [Proxy patterns](#proxy-patterns)                                  |
| Multisig checks                                        | [Gnosis Safe](#gnosis-safe)                                        |
| Role/ACL checks                                        | [Access control](#access-control)                                  |
| Unknown return values                                  | [REPLACEME discovery](#replaceme-discovery)                        |
| Overloaded function (two ABI fragments with same name) | [Function overloads](#function-overloads)                          |
| Seed config (`--generate`)                             | [Seed configs](#seed-configs)                                      |
| ABI not found / rate-limit / revert reading            | [Troubleshooting](#troubleshooting)                                |

## Top-level structure

```yaml
parameters: # optional — arbitrary constants used across the file
  - &someConstant "0x..."

deployed: # address book, grouped by chain
  l1:
    - &contractAddress "0x..."
    - &implAddress "0x..."
  l2: # for multi-chain configs (e.g. L1↔L2 bridges)
    - &l2ContractAddress "0x..."

misc: # numeric/bytes32 constants, EIP slots, zeros
  - &ZERO_ADDRESS "0x0000000000000000000000000000000000000000"
  - &ZERO_BYTES32 "0x0000000000000000000000000000000000000000000000000000000000000000"
  - &EIP1967_ADMIN_SLOT "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
  - &EIP1967_IMPLEMENTATION_SLOT "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"

roles: # bytes32 role hashes, often many (one per domain)
  - &DEFAULT_ADMIN_ROLE "0x00..."
  - &SOME_ROLE "0x..."

eoa: # named EOAs (deployer, signer addresses); useful for "deployer renounced" checks
  - &deployer "0x..."

l1: # per-chain section — key matches deployed.* key
  rpcUrl: L1_MAINNET_RPC_URL # env-var name, or inline URL
  explorerHostname: api.etherscan.io/v2/api
  explorerTokenEnv: ETHERSCAN_TOKEN
  chainId: 1
  contracts:
    contractName:
      # ...

l2: # present when deployed.l2 exists
  rpcUrl: L2_MAINNET_RPC_URL
  # ...
```

`parameters`, `deployed`, `misc`, `roles`, `eoa` are anchor-only sections — they define YAML anchors (`&name`) that later sections reference via `*name`. Only `<chain-key>` sections with `contracts:` produce on-chain calls.

## Contract patterns

### Simple (no proxy)

```yaml
contractName:
  name: ContractName                 # must match ABI filename
  address: *contractAddress
  checks:
    functionName: expectedValue
    anotherFunction: *someVariable
```

### Proxy patterns

**Transparent Upgradeable Proxy** (OpenZeppelin classic). `proxyChecks: {}` because the admin/impl live in EIP-1967 slots, which you verify via `storage:`:

```yaml
contractName:
  name: ContractName
  address: *contractAddress
  proxyName: TransparentUpgradeableProxy
  implementation: *implementationAddress
  proxyChecks: {}
  storage:
    - slot: *EIP1967_ADMIN_SLOT
      expected: *proxyAdminAddress
      label: admin
    - slot: *EIP1967_IMPLEMENTATION_SLOT
      expected: *implementationAddress
      label: implementation
  checks:
    # against the proxy (implementation logic, proxy state)
    someFunction: expectedValue
  implementationChecks:
    # against the impl directly (uninitialized state — zeros/empties)
    someFunction: *ZERO_ADDRESS
```

**OssifiableProxy** exposes `proxy__getAdmin` / `proxy__getImplementation`, so `proxyChecks` is usually non-empty and `storage:` isn't needed:

```yaml
contractName:
  name: ContractName
  address: *contractAddress
  proxyName: OssifiableProxy
  implementation: *implAddress
  proxyChecks:
    proxy__getAdmin: *aragonAgent
    proxy__getImplementation: *implAddress
    proxy__getIsOssified: false
  checks: { ... }
  implementationChecks: { ... }
```

**AppProxyUpgradeable** (Aragon apps) has its own shape:

```yaml
contractName:
  name: Lido
  address: *lido
  proxyName: AppProxyUpgradeable
  implementation: *lidoImplAddress
  proxyChecks:
    proxyType: *PROXY_TYPE_APP_PROXY_UPGRADEABLE
    isDepositable: false
    implementation: *lidoImplAddress
    appId: *LIDO_APP_ID
    kernel: *aragonKernel
```

### ProxyAdmin

```yaml
proxyAdminName:
  name: ProxyAdmin
  address: *proxyAdminAddress
  checks:
    UPGRADE_INTERFACE_VERSION: "5.0.0"
    owner: *ownerAddress
```

### Gnosis Safe

Safes use storage slot 0 for the singleton (not EIP-1967). Detect via `VERSION()(string)`:

```bash
cast call $ADDRESS "VERSION()(string)" --rpc-url $RPC
# Safe → returns "1.4.1"; EOA or non-Safe → reverts
```

```yaml
multisigName:
  name: GnosisSafe
  address: *multisigAddress
  checks:
    VERSION: "1.4.1"
    getThreshold: *THRESHOLD_VALUE
    getOwners:
      - *signer1
      - *signer2
    isOwner:
      - args: [*signer1]
        result: true
```

Transient values (Safe `nonce`, queue `canBeRemoved`, `getResumeSinceTimestamp` after a transient pause) drift over time — either leave the key `null` to skip, or accept that each state change needs a config update.

### Contract with indexed collections

```yaml
checks:
  getItemCount: 2
  hasItem:
    - args: [*item1]
      result: true
  itemAt:
    - args: [0]
      result: *item1
    - args: [1]
      result: *item2
    - args: [2]
      mustRevert: true        # out of bounds
```

Multi-arg indexed getter:

```yaml
checks:
  itemAt:
    - args: [true, 0]
      result: *depositItem
    - args: [false, 0]
      result: *withdrawItem
```

## Function check patterns

### Simple value

```yaml
checks:
  decimals: 18
  name: "Token Name"
```

### Skipped (requires args or too complex)

```yaml
checks:
  functionWithArgs: # null value → skipped
  anotherComplexFunction:
```

### With arguments

```yaml
checks:
  balanceOf:
    - args: [*userAddress]
      result: "1000000000000000000"
  hasRole:
    - args: [*SOME_ROLE, *holderAddress]
      result: true
```

### Must revert

```yaml
checks:
  itemAt:
    - args: [1]
      mustRevert: true
```

### Tuple / array returns

Document field names with comments — tuple positions aren't obvious from YAML alone:

```yaml
checks:
  # [fieldA, fieldB, fieldC]
  params: [1000, 86400, 3600]

  simpleParams: [200, 86400] # [penaltyRate, maxAge]

  flags: [false, false, false, 0]
```

### Function overloads

When the ABI has two fragments with the same name, state-mate needs disambiguation. Add `signature:` inside the arg entry:

```yaml
checks:
  domainSeparatorV4:
    - args: [*lido]
      signature: "domainSeparatorV4(address)"
      result: *LIDO_DOMAIN_SEPARATOR
```

## Access control

### OpenZeppelin AccessControlEnumerable → `ozAcl:`

Use when `getRoleMemberCount(bytes32)` succeeds:

```yaml
ozAcl:
  *DEFAULT_ADMIN_ROLE : [*adminAddress]
  *SOME_ROLE          : [*holder1, *holder2]
  *UNUSED_ROLE        : []             # explicit: 0 members
```

### Non-enumerable AccessControl → `ozNonEnumerableAcl:`

Same shape as `ozAcl`, but state-mate verifies via per-address `hasRole` instead of iterating role members. Use for AccessControl without the Enumerable extension:

```yaml
ozNonEnumerableAcl:
  *DEFAULT_ADMIN_ROLE      : [*agent]
  *DEPOSITS_ENABLER_ROLE   : [*agent]
  *WITHDRAWALS_DISABLER_ROLE : [*agent, *emergencyMultisig]
```

### Raw `hasRole` checks

When a contract doesn't expose role management in a standard way, or you only care about specific (role, address) pairs:

```yaml
checks:
  hasRole:
    - args: [*DEFAULT_ADMIN_ROLE, *adminAddress]
      result: true
    - args: [*SOME_ROLE, *holderAddress]
      result: true
```

### Picking between them

```bash
# Enumerable present?
cast call $CONTRACT "getRoleMemberCount(bytes32)(uint256)" $ROLE --rpc-url $RPC
# succeeds → ozAcl; reverts → ozNonEnumerableAcl or raw hasRole
```

## REPLACEME discovery

For unknown function return values:

```yaml
checks:
  unknownValue: "REPLACEME"
```

Run `yarn start config.yml` — the error surfaces the actual on-chain value:

```
✗ .unknownValue: expected REPLACEME, got 0xb13b0c93...
```

**Do not** use `REPLACEME` in `deployed:` — invalid-address errors block the whole file from loading. For unknown addresses, read EIP-1967 slots first:

```bash
cast admin $PROXY --rpc-url $RPC           # EIP-1967 admin
cast implementation $PROXY --rpc-url $RPC  # EIP-1967 implementation
cast storage $CONTRACT <slot> --rpc-url $RPC
```

## Role discovery

```bash
# Enumerable
cast call $CONTRACT "getRoleMemberCount(bytes32)(uint256)" $ROLE --rpc-url $RPC
cast call $CONTRACT "getRoleMember(bytes32,uint256)(address)" $ROLE 0 --rpc-url $RPC

# Non-enumerable
cast call $CONTRACT "hasRole(bytes32,address)(bool)" $ROLE $ADDRESS --rpc-url $RPC
```

## Seed configs

A seed config is a thin starter file named `*.seed.yml`. It contains only address-book and chain-explorer sections (`deployed:`, `l1:` / `l2:` with `rpcUrl` / `explorerHostname`, optional `eoa:` / `roles:` / `misc:`) — **no `contracts:` block**. `yarn start <seed> --generate` walks every anchor under `deployed:`, resolves the ABI for each address, and writes a sibling `*.seed.generated.yml` with a populated `contracts:` block where each function value is `REPLACEME` (and, for proxies, a commented-out `implementationChecks` stub).

`--generate` on its own does not fetch ABIs — it only uses ABIs already on disk. Combine with `--update-abi-missing` on first run.

```bash
yarn start configs/proto/mainnet.seed.yml --generate --update-abi-missing
# Review *.seed.generated.yml, replace REPLACEME with real expectations, then:
yarn start configs/proto/mainnet.seed.generated.yml
```

## Workflow

Adding a new contract to an existing config:

1. **Resolve addresses** — `cast admin` / `cast implementation` for proxies; EIP-1967 slots for anything non-standard.
2. **Define anchors** in `deployed:` (and `implementation:` addresses in the same section with a matching name).
3. **Write the contract stanza** — pick the proxy pattern, seed `checks:` with function names, leave unknowns as `REPLACEME`.
4. **Download ABIs** — `yarn start config.yml --update-abi-missing`. Resolution depends on mode: consolidated (`abis.json.gz`) tries the `Name-{address}` key first, then `Name`; individual-file mode (`abi/*.json`) tries `Name.json`, then `Name.sol/Name.json`, then `Name-{address}.json`.
5. **Run, read actuals, replace** — iterate `yarn start config.yml -o l1/contractName` until green.
6. **Access control** — probe with `cast call getRoleMemberCount`; choose `ozAcl` / `ozNonEnumerableAcl` / `hasRole`. List every role constant, including empty ones (`[]`).

## Implementation checks

For `implementationChecks`, use uninitialized defaults — implementations store no state:

| Type    | Default                                        |
| ------- | ---------------------------------------------- |
| Address | `*ZERO_ADDRESS`                                |
| Bytes32 | `*ZERO_BYTES32`                                |
| Number  | `0` (or `*MAX_UINT256` for pause-until values) |
| String  | `""`                                           |
| Boolean | `false`                                        |
| Tuple   | All zeros: `[0, 0, 0, …]`                      |

## Running checks

```bash
yarn start config.yml                                     # full config
yarn start config.yml -o l1                               # specific section
yarn start config.yml -o l1/contractName                  # specific contract (great for rate-limited RPC)
yarn start config.yml -o l1/contractName/checks/funcName  # single function
yarn start config.yml --update-abi-missing                # download only missing ABIs (preferred)
yarn start config.yml --update-abi                        # overwrite all ABIs (rarely needed)
yarn start config.seed.yml --generate                     # expand seed → *.seed.generated.yml
```

## Best practices

- **Named anchors for addresses** — define every address in `deployed:` / `eoa:`; don't hardcode `0x…` inside `checks:` values. Inline hex is fine for **data** (bytes32 constants, selectors).
- **Deployer renounced** — confirm `deployer` is not a role holder (not in any `ozAcl` list; `hasRole(…, deployer) = false`).
- **Empty roles are explicit** — list unused roles with `[]` so a future grant is caught.
- **Comment tuples** — field names aren't derivable from YAML; look up the ABI.
- **Rate-limited RPC?** — scope with `-o l1/contractName` to reduce concurrency.
- **Transient values** — Safe `nonce`, `getResumeSinceTimestamp`, queue operational flags etc. belong as `null` unless you intentionally want the check to fire on every state change.

## Troubleshooting

### `ABI not found` / `Cannot find ABI file`

- Run `yarn start <config> --update-abi-missing`.
- Verify `name:` matches the ABI filename (the `{proxyAddr}` / `{implAddr}` suffix is optional).
- Individual-file resolution order: `Name.json` → `Name.sol/Name.json` → `Name-{address}.json`. Consolidated (`abis.json.gz`) tries `Name-{address}` key first, then `Name`.

### `getRoleMemberCount` reverted / `no matching function`

- The contract is standard AccessControl, not Enumerable — switch to `ozNonEnumerableAcl:` or raw `hasRole` checks.
- Or the contract doesn't expose role management at all — skip the role block.

### `missing revert data` with `data=null`

- Almost always RPC rate limiting or a 502 from the provider, not an on-chain revert.
- Retry with `-o l1/contractName` scope; or switch RPC provider.
- `drpc.org` public endpoints are decent for ad-hoc queries.

### `Invalid address` in `deployed:`

- `REPLACEME` is invalid in `deployed:` — resolve the address via `cast storage` / `cast admin` first, then add a real anchor.

### Ambiguous function overload

Use `signature:` inside the arg entry (see [Function overloads](#function-overloads)). For `cast` queries, spell out the full signature:

```bash
cast call $CONTRACT "itemAt(bool,uint256)(address)" true 0 --rpc-url $RPC
```

### Unexpected tuple length / field order

The YAML array must match the on-chain struct's field order exactly. Look up the canonical layout in the contract's Solidity source or the ABI's `components` field — don't rely on field names in the contract UI.
