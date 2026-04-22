# state-mate

state-mate validates smart contract states against YAML-based descriptions. It calls view functions on EVM contracts and compares outputs to expected values.

## Key Commands

```bash
yarn start configs/path/to/config.yaml                    # Full verification
yarn start configs/path/to/config.yaml -o l1/contractName  # Single contract
yarn start configs/path/to/config.yaml --update-abi-missing # Download missing ABIs
yarn start configs/path/to/config.seed.yaml --generate      # Generate from seed
```

## Project Structure

```
configs/meta/ethereum/   # Ethereum mainnet configs
configs/meta/base/       # Base L2 configs
configs/lido/            # Lido configs
src/                     # TypeScript source
.claude/skills/          # Skills and references
```

## Skills

For detailed state-mate config patterns (contracts, proxies, Safe multisigs, access control, discovery, troubleshooting), see `.claude/skills/state-mate/skill.md`.
