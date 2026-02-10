# Agent Context for state-mate

Canonical instructions live here for Codex. `CLAUDE.md` mirrors this file for Claude Code compatibility.
Skills live in `.skills/`.

## Project Overview

state-mate is a tool that validates smart contract states against YAML-based descriptions. It calls view functions on EVM contracts and compares outputs to expected values.

## Key Commands

```bash
# Run state verification
yarn start configs/path/to/config.yml

# Check specific section/contract
yarn start configs/path/to/config.yml -o l1/contractName

# Download/update ABIs
yarn start configs/path/to/config.yml --update-abi
yarn start configs/path/to/config.yml --update-abi-missing

# Generate config from seed
yarn start configs/path/to/config.seed.yml --generate
```

## Project Structure

```
configs/           # Network configs (see configs/*)
  meta/
    eth/           # Ethereum mainnet configs
    usd/           # USD-related configs
  lidov3/          # Lido v3 configs
src/               # TypeScript source code
```

## Agents

- **state-mate** (`.skills/state-mate/references/agent.md`): Agent guide for adding/configuring contracts in state-mate YAML files. Handles proxy discovery, access control setup, and verification.

## Skills & Reference

When working with state-mate configs, read `.skills/state-mate/SKILL.md` for:

- Contract configuration patterns (simple, proxy, AccessControl)
- Discovery processes (REPLACEME technique, proxy admins, implementations, role assignments)
- Access control patterns (ozAcl vs hasRole)
- Common patterns and troubleshooting

## Environment Setup

Required environment variables (typically in `.env`):

- `L1_MAINNET_RPC_URL`: Ethereum mainnet RPC endpoint
- `ETHERSCAN_TOKEN`: Etherscan API key for ABI downloads
- Network-specific RPC URLs as needed

## Common Tasks

### Adding a New Contract

1. Add address to `deployed` section
2. If proxy: discover proxy admin and implementation via storage slots
3. Add contract config with checks/implementationChecks
4. Run `--update-abi` to download ABI
5. Run verification to confirm all checks pass

### Verifying Access Control

- Use `ozAcl` for AccessControlEnumerable contracts
- Use `hasRole` checks for standard AccessControl contracts
- Empty arrays `[]` verify role has 0 members

### Storage Slot Verification

Use EIP-1967 slots for transparent proxy verification:

- Admin slot: `0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103`
- Implementation slot: `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`
