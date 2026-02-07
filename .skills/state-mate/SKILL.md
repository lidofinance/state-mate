---
name: state-mate
description: Configure and verify state-mate YAML for EVM smart contract state checks, including contracts, proxies, access control, ABI updates, and troubleshooting.
---

# State-Mate Skills
Name: state-mate

This document describes patterns and processes for configuring state-mate YAML files to verify smart contract states on EVM chains.

## Overview

state-mate validates contract states against a YAML-based description. It calls view functions and compares outputs to expected values.

## File Structure

```yaml
deployed:
  l1:  # or l2, etc.
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
  rpcUrl: L1_MAINNET_RPC_URL  # env variable name
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
    someFunction: *ZERO_ADDRESS  # Usually zero/empty values
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
    - args: [*OTHER_ROLE, *holderAddress]
      result: false
```

### Function That Must Revert
```yaml
checks:
  functionAt:
    - args: [0]
      result: *firstItem
    - args: [1]
      mustRevert: true  # Index out of bounds
```

### Tuple/Array Return Values
```yaml
checks:
  flags: [false, false, false, false, false, 0]
  getState:  # Complex tuple - skip if too complex
```

## Access Control Patterns

### OpenZeppelin AccessControlEnumerable (ozAcl)

Use `ozAcl` when the contract inherits from AccessControlEnumerable (has `getRoleMemberCount`):

```yaml
checks:
  # ... other checks
ozAcl:
  *DEFAULT_ADMIN_ROLE : [*adminAddress]
  *SOME_ROLE : [*holder1, *holder2]
  *UNUSED_ROLE : []  # Verify role has 0 members
```

### Standard AccessControl (hasRole checks)

When contract uses standard AccessControl (no enumeration), use `hasRole` checks:

```yaml
checks:
  hasRole:
    - args: [*DEFAULT_ADMIN_ROLE, *adminAddress]
      result: true
    - args: [*SOME_ROLE, *holderAddress]
      result: true
    - args: [*OTHER_ROLE, *nonHolderAddress]
      result: false
```

**How to detect which pattern to use:**
```bash
# If this succeeds, use ozAcl
cast call $CONTRACT "getRoleMemberCount(bytes32)(uint256)" $ROLE --rpc-url $RPC_URL

# If it reverts, use hasRole checks instead
```

## Discovery Processes

### 1. Discover Function Return Values (REPLACEME Technique)

Use placeholder values like `"REPLACEME"` to discover actual on-chain values:

```yaml
checks:
  merkleRoot: "REPLACEME"
```

Run state-mate - the error output shows expected vs actual:
```
✗ .merkleRoot: expected REPLACEME, got 0xb13b0c93...
```

**Note:** Don't use REPLACEME in `deployed` section - causes "invalid address" errors. For addresses, use storage slot reads first.

### 2. Discover Proxy Admin Address

Read the EIP-1967 admin storage slot:

```bash
EIP1967_ADMIN_SLOT="0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
cast storage $PROXY_ADDRESS $EIP1967_ADMIN_SLOT --rpc-url $RPC_URL
# Returns: 0x000000000000000000000000{proxyAdminAddress}
```

### 3. Discover Implementation Address

```bash
EIP1967_IMPLEMENTATION_SLOT="0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
cast storage $PROXY_ADDRESS $EIP1967_IMPLEMENTATION_SLOT --rpc-url $RPC_URL
```

### 4. Check Role Assignments

```bash
# For AccessControlEnumerable
cast call $CONTRACT "getRoleMemberCount(bytes32)(uint256)" $ROLE --rpc-url $RPC_URL
cast call $CONTRACT "getRoleMember(bytes32,uint256)(address)" $ROLE 0 --rpc-url $RPC_URL

# For standard AccessControl
cast call $CONTRACT "hasRole(bytes32,address)(bool)" $ROLE $ADDRESS --rpc-url $RPC_URL
```

## Common Patterns

### Adding a New Proxy Contract

1. Add addresses to `deployed` section:
```yaml
deployed:
  l1:
    - &newContract "0x..."
    - &newContractProxyAdmin "0x..."  # Discover via storage slot
    - &newContractImplementation "0x..."  # Discover via storage slot
```

2. Add ProxyAdmin contract:
```yaml
newContractProxyAdmin:
  name: ProxyAdmin
  address: *newContractProxyAdmin
  checks:
    UPGRADE_INTERFACE_VERSION: "5.0.0"
    owner: *proxyAdminOwner
```

3. Add main contract with proxy config:
```yaml
newContract:
  name: NewContract
  address: *newContract
  proxyName: TransparentUpgradeableProxy
  implementation: *newContractImplementation
  proxyChecks: {}
  storage:
    - slot: *EIP1967_ADMIN_SLOT
      expected: *newContractProxyAdmin
      label: admin
    - slot: *EIP1967_IMPLEMENTATION_SLOT
      expected: *newContractImplementation
      label: implementation
  checks:
    # Add all view functions from ABI
  implementationChecks:
    # Same functions but with uninitialized values
```

### Verifying All Roles Have Expected Members

For comprehensive role verification:

1. List all role constants in `roles` section
2. Add roles with members to ozAcl with their holders
3. Add roles without members as empty arrays `[]`
4. Add deployer address to verify no roles remain on it

```yaml
deployed:
  l1:
    - &deployer "0x..."  # Add deployer address for verification

ozAcl:
  # Roles with members
  *DEFAULT_ADMIN_ROLE : [*admin]
  *OPERATOR_ROLE : [*operator1, *operator2]
  # Roles not yet granted (verify 0 members)
  *FUTURE_ROLE : []
  *ANOTHER_UNUSED_ROLE : []
```

### Verifying Deployer Has No Roles

After deployment, verify the deployer address has renounced all roles. Add deployer to hasRole checks with `result: false`:

```yaml
deployed:
  l1:
    - &deployer "0x..."

# In contract checks:
checks:
  hasRole:
    - args: [*DEFAULT_ADMIN_ROLE, *deployer]
      result: false
    - args: [*OPERATOR_ROLE, *deployer]
      result: false
```

Or with ozAcl, just ensure deployer is NOT in any role's holder list.

## Running Checks

```bash
# Full config check
yarn start configs/path/to/config.yml

# Check specific section
yarn start configs/path/to/config.yml -o l1

# Check specific contract
yarn start configs/path/to/config.yml -o l1/contractName

# Check specific function type
yarn start configs/path/to/config.yml -o l1/contractName/checks/functionName

# Update ABIs (download all)
yarn start configs/path/to/config.yml --update-abi

# Update only missing ABIs
yarn start configs/path/to/config.yml --update-abi-missing
```

## Troubleshooting

### "ABI not found" Error
- Run with `--update-abi` to download ABIs
- Check that contract name matches ABI filename

### "getRoleMemberCount reverted" or "no matching function"
- Contract uses standard AccessControl, not AccessControlEnumerable
- Remove ozAcl section, use hasRole checks instead
- Some contracts (e.g., Oracle) may not expose role management functions at all - skip role checks for these

### Function check fails with wrong value
- Run check to see actual value in error output
- Update expected value in config

### "Invalid address" in deployed section
- Remove placeholder values like "REPLACEME"
- Discover actual addresses before adding to config

## Implementation Checks Guidelines

For `implementationChecks`, use uninitialized/default values:
- Addresses: `*ZERO_ADDRESS`
- Bytes32: `*ZERO_BYTES32`
- Numbers: `0`
- Strings: `""`
- Booleans: typically `false` or initial state
- Arrays: empty or skip

The implementation contract should be in an uninitialized state since all state is stored in the proxy.
