# Direct Staking

All five Direct Staking network configs separate deployment data and inputs from checks.
Each network has three matching files, illustrated by Base:

- [`mainnet/base.yaml`](mainnet/base.yaml) contains network settings and contract checks.
- [`mainnet/base.deployed.yaml`](mainnet/base.deployed.yaml) contains the eight contract addresses used by ABI verification and refresh.
- [`mainnet/base.inputs.yaml`](mainnet/base.inputs.yaml) contains configurable values and external references.

The split follows the [Direct Staking source configs](https://github.com/lidofinance/l2-direct-staking/tree/main/config/state).
Their shared and per-chain inputs are represented here by one inputs file per network, as this CLI accepts one file per option.
The split retains this repository's check coverage. Automation ownership, CRE report authors, and the workflow ID, name, and tag match the Direct Staking source configs.
The source's retired-contract checks are outside these configs, so their unused deployment labels are omitted.
Contracts listed as external inputs upstream remain in `deployed:` here when needed for the existing nightly ABI refresh.
Each config retains this repository's `l1` network key; its chain ID and RPC setting select the actual network.

| Network  | Main config                              | Chain ID | RPC environment variable |
| -------- | ---------------------------------------- | -------- | ------------------------ |
| Ethereum | [`ethereum.yaml`](mainnet/ethereum.yaml) | 1        | `ETH_RPC_URL`            |
| Arbitrum | [`arbitrum.yaml`](mainnet/arbitrum.yaml) | 42161    | `ARBITRUM_RPC_URL`       |
| Base     | [`base.yaml`](mainnet/base.yaml)         | 8453     | `BASE_RPC_URL`           |
| Optimism | [`optimism.yaml`](mainnet/optimism.yaml) | 10       | `OPTIMISM_RPC_URL`       |
| Linea    | [`linea.yaml`](mainnet/linea.yaml)       | 59144    | `LINEA_RPC_URL`          |

From the repository root, run Base with both explicit options:

```sh
yarn start configs/lido-direct-staking/mainnet/base.yaml \
  --deployed configs/lido-direct-staking/mainnet/base.deployed.yaml \
  --inputs configs/lido-direct-staking/mainnet/base.inputs.yaml
```

Set `BASE_RPC_URL` to a Base mainnet RPC endpoint. ABI refreshes also use `ETHERSCAN_TOKEN`.
Both sibling files are required: omitting either option leaves unresolved aliases.
For another network, replace `base` in all three paths with its filename stem from the table.

To run all Direct Staking configs, enable sibling discovery:

```sh
yarn start configs/lido-direct-staking/mainnet --auto-load-deployed-and-inputs
```

The existing CI matrix runs this directory with sibling discovery enabled, including nightly `--update-abi` runs.
It loads both matching siblings for each of the five configs.
Running the whole directory requires all five RPC settings from the table.
