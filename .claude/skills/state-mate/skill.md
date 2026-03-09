---
name: state-mate
description: Configure and verify state-mate YAML for EVM smart contract state checks, including contracts, proxies, access control, ABI updates, and troubleshooting.
---

# State-Mate Skill

Configure state-mate YAML files to verify smart contract states on EVM chains. state-mate calls view functions and compares outputs to expected values.

## YAML File Structure

```yaml
deployed:
  l1: # Section name — "l1" is conventional, not hardcoded
    - &contractAddress "0x..."
    - &proxyAdminAddress "0x..."
    - &implementationAddress "0x..."

misc:
  - &ZERO_ADDRESS "0x0000000000000000000000000000000000000000"
  - &ZERO_BYTES32 "0x0000000000000000000000000000000000000000000000000000000000000000"
  - &EIP1967_ADMIN_SLOT "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
  - &EIP1967_IMPLEMENTATION_SLOT "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"

roles:
  - &DEFAULT_ADMIN_ROLE "0x0000000000000000000000000000000000000000000000000000000000000000"
  - &SOME_ROLE "0x..."

l1:
  rpcUrl: L1_MAINNET_RPC_URL  # env variable name (not the URL itself)
  explorerHostname: api.etherscan.io/v2/api
  explorerTokenEnv: ETHERSCAN_TOKEN
  chainId: 1
  contracts:
    contractName:
      # ... contract config
```

## Contract Configuration Patterns

### 1. Simple Contract (No Proxy)

```yaml
contractName:
  name: ContractName  # Must match ABI filename
  address: *contractAddress
  checks:
    functionName: expectedValue
    anotherFunction: *someVariable
```

### 2. Transparent Upgradeable Proxy

```yaml
contractName:
  name: ContractName
  address: *contractAddress
  proxyName: TransparentUpgradeableProxy
  implementation: *implementationAddress
  proxyChecks: {}  # Usually empty for transparent proxies
  storage:
    - slot: *EIP1967_ADMIN_SLOT
      expected: *proxyAdminAddress
      label: admin
    - slot: *EIP1967_IMPLEMENTATION_SLOT
      expected: *implementationAddress
      label: implementation
  checks:
    # Checks run against the proxy (with implementation logic)
    someFunction: expectedValue
  implementationChecks:
    # Checks run directly against implementation (uninitialized state)
    someFunction: *ZERO_ADDRESS
```

### 3. ProxyAdmin Contract

```yaml
proxyAdminName:
  name: ProxyAdmin
  address: *proxyAdminAddress
  checks:
    UPGRADE_INTERFACE_VERSION: "5.0.0"
    owner: *ownerAddress
```

### 4. Gnosis Safe Multisig

Safe contracts use storage slot 0 for the singleton (implementation), not EIP-1967 slots.

```yaml
multisig_name:
  name: GnosisSafe
  address: *multisigAddress
  checks:
    VERSION: "1.4.1"
    getThreshold: *THRESHOLD_VALUE
    getOwners:
      - *signer1
      - *signer2
      - *signer3
    isOwner:
      - args: [*signer1]
        result: true
```

Detect if an address is a Safe:
```bash
cast call $ADDRESS "VERSION()(string)" --rpc-url $RPC_URL
# Safe → returns "1.4.1"; EOA → reverts
```

### 5. Contract with Indexed Collections

For contracts that manage enumerable items (queues, assets, vaults, etc.):

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
      mustRevert: true  # Out of bounds
```

Some contracts use multi-arg indexed getters (e.g., `itemAt(type, index)`):

```yaml
checks:
  itemAt:
    - args: [true, 0]
      result: *depositItem
    - args: [false, 0]
      result: *withdrawItem
```

## Function Check Patterns

### Simple Value Check

```yaml
checks:
  functionName: expectedValue
  decimals: 18
  name: "Token Name"
```

### Skipped Functions (Require Arguments or Complex)

```yaml
checks:
  functionWithArgs:  # Empty value = skipped
  anotherComplexFunction:
```

### Function with Arguments

```yaml
checks:
  balanceOf:
    - args: [*userAddress]
      result: "1000000000000000000"
  hasRole:
    - args: [*SOME_ROLE, *holderAddress]
      result: true
```

### Function That Must Revert

```yaml
checks:
  itemAt:
    - args: [0]
      result: *firstItem
    - args: [1]
      mustRevert: true  # Index out of bounds
```

### Tuple/Array Return Values

For functions returning tuples, add inline comments documenting field names:

```yaml
checks:
  # params: [fieldA, fieldB, fieldC]
  params: [1000, 86400, 3600]

  simpleParams: [200, 86400]  # [penaltyRate, maxAge(seconds)]

  flags: [false, false, false, 0]
```

Look up field names in the contract's interface/ABI. Use comments above for long tuples, inline `#` for short ones.

## Access Control Patterns

### OpenZeppelin AccessControlEnumerable (ozAcl)

Use when contract has `getRoleMemberCount`:

```yaml
checks:
  # ... other checks
ozAcl:
  *DEFAULT_ADMIN_ROLE : [*adminAddress]
  *SOME_ROLE : [*holder1, *holder2]
  *UNUSED_ROLE : []  # Verify role has 0 members
```

### Standard AccessControl (hasRole checks)

When `getRoleMemberCount` reverts:

```yaml
checks:
  hasRole:
    - args: [*DEFAULT_ADMIN_ROLE, *adminAddress]
      result: true
    - args: [*SOME_ROLE, *holderAddress]
      result: true
```

### Detection

```bash
# If this succeeds → use ozAcl
cast call $CONTRACT "getRoleMemberCount(bytes32)(uint256)" $ROLE --rpc-url $RPC_URL

# If it reverts → use hasRole checks
```

## Discovery Processes

### 1. REPLACEME Technique (Function Return Values)

```yaml
checks:
  unknownValue: "REPLACEME"
```

Run state-mate — error output shows actual value:
```
✗ .unknownValue: expected REPLACEME, got 0xb13b0c93...
```

**Never** use REPLACEME in `deployed` — causes "invalid address" errors. Use storage slot reads for addresses.

### 2. Discover Proxy Admin / Implementation

```bash
cast admin $PROXY --rpc-url $RPC_URL
cast implementation $PROXY --rpc-url $RPC_URL
```

### 3. Check Role Assignments

```bash
# AccessControlEnumerable
cast call $CONTRACT "getRoleMemberCount(bytes32)(uint256)" $ROLE --rpc-url $RPC_URL
cast call $CONTRACT "getRoleMember(bytes32,uint256)(address)" $ROLE 0 --rpc-url $RPC_URL

# Standard AccessControl
cast call $CONTRACT "hasRole(bytes32,address)(bool)" $ROLE $ADDRESS --rpc-url $RPC_URL
```

### 4. Safe vs EOA Detection

```bash
cast call $ADDRESS "VERSION()(string)" --rpc-url $RPC_URL
# Safe → returns version string; EOA → reverts

cast call $ADDRESS "getOwners()(address[])" --rpc-url $RPC_URL
cast call $ADDRESS "getThreshold()(uint256)" --rpc-url $RPC_URL
```

## Workflow: Adding a New Contract

1. **Discover addresses** — read EIP-1967 storage slots for proxy admin and implementation
2. **Add to config** — addresses in `deployed` with YAML anchors, then contract section with checks
3. **Download ABIs** — `yarn start config.yml --update-abi-missing` (prefer over `--update-abi` which overwrites all)
4. **Discover values** — set unknowns to `"REPLACEME"`, run state-mate, read actuals from errors
5. **Configure access control** — test `getRoleMemberCount` to choose ozAcl vs hasRole
6. **Verify** — `yarn start config.yml` or `-o l1/contractName` for individual contracts

**ABI resolution order:** `ContractName-{proxyAddress}.json` → `ContractName.json` → `ContractName-{implAddress}.json`

## Running Checks

```bash
yarn start config.yml                                    # Full config
yarn start config.yml -o l1                              # Specific section
yarn start config.yml -o l1/contractName                 # Specific contract
yarn start config.yml -o l1/contractName/checks/funcName # Specific function
yarn start config.yml --update-abi-missing               # Download missing ABIs
yarn start config.yml --update-abi                       # Re-download all ABIs
```

## Implementation Checks Guidelines

For `implementationChecks`, use uninitialized/default values since the implementation stores no state:

| Type | Default |
|------|---------|
| Address | `*ZERO_ADDRESS` |
| Bytes32 | `*ZERO_BYTES32` |
| Number | `0` |
| String | `""` |
| Boolean | `false` |
| Tuple | All zeros: `[0, 0, 0, ...]` |

## Best Practices

- **Named anchors** — always define anchors in `deployed`/`misc` for addresses. Never inline raw `0x...` in check values.
- **Verify deployer renounced roles** — ensure deployer address is NOT in any ozAcl holder list, or add `hasRole` checks with `result: false`.
- **Verify unused roles are empty** — list ALL role constants from the contract, add `[]` for ungranted roles.
- **Tuple comments** — add field name comments for non-obvious array/tuple returns. Look up names in the contract interface or ABI.
- **Rate-limited RPCs** — run individual contracts with `-o l1/contractName` to reduce concurrent requests.

## Troubleshooting

### "ABI not found"

- Run `--update-abi-missing` to download
- Check `name` field matches ABI filename
- Resolution order: `Name-{proxyAddr}.json` → `Name.json` → `Name-{implAddr}.json`

### "getRoleMemberCount reverted" or "no matching function"

- Contract uses standard AccessControl, not Enumerable — switch to `hasRole` checks
- Some contracts don't expose role management at all — skip role checks

### "missing revert data" with `data=null`

- Usually RPC rate limiting, NOT an actual revert
- Run individual contracts with `-o l1/contractName`
- Switch to a less rate-limited RPC endpoint

### "Invalid address" in deployed section

- Don't use REPLACEME in `deployed` — discover addresses via `cast storage` first

### Ambiguous function overloads

Use the full signature with cast:
```bash
cast call $CONTRACT "itemAt(bool,uint256)(address)" true 0 --rpc-url $RPC_URL
```
