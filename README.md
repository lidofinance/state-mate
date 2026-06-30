<div>
    <img alt="state-mate" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Flidofinance%2Fstate-mate%2Fmain%2Fpackage.json&query=%24.version&label=state-mate&labelColor=white&color=green"/>
    <img alt="Node.js" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Flidofinance%2Fstate-mate%2Fmain%2Fpackage.json&query=%24.engines.node&style=flat&label=node.js&labelColor=rgb(62%2C%20109%2C%2026)&color=white"/>
    <img alt="GitHub license" src="https://img.shields.io/github/license/lidofinance/state-mate?labelColor=orange&color=white"/>
</div>

# state-mate

<div>
    <img alt="state-mate banner" src="assets/banner.jpeg" width=300 />
</div>

state-mate is a simple tool that validates contracts' states against a concise YAML-based description. Run state-mate to verify deploy outcome, current state, access control and more.

state-mate accepts a yaml file that includes contract addresses, view functions and their expected results. It calls each function and compares the output to the expected result.

## ✨ Features

- state (non-mutable functions result) verification,
- automatically validates that all functions covered,
- supports any EVM network,
- easily configurable checks,
- CI-friendly,
- uses yaml config (env variables, variables, comments).

## ⚡ Getting started

### Requirements

- git
- Node.js >=20,
- yarn

### Usage

1. Enable modern yarn support

```sh
corepack enable
```

2. Install dependencies

```sh
yarn install
```

3. Configure RPC endpoints and explorer tokens

Copy the sample env file and fill in the values:

```sh
cp .env.sample .env
```

```sh
# .env

L1_MAINNET_RPC_URL=%YOUR_RPC_URL%
L2_MAINNET_RPC_URL=%YOUR_RPC_URL%
ETHERSCAN_TOKEN=%YOUR_TOKEN%
```

Configs reference these by their **env-var name** (e.g. `rpcUrl: L1_MAINNET_RPC_URL`). `.env` is gitignored.

4. Prepare a seed config

```yaml
---
deployed:
  l1:
    - &l1TokenBridge "0xD0DeA0a3bd8E4D55170943129c025d3fe0493F2A"
  l2:
    - &l2TokenBridge "0xb8161F28a5a38cE58f155D9A96bDAc0104985FAc"
    - &l2Wsteth "0x98f96A4B34D03a2E6f225B28b8f8Cb1279562d81"
    - &l2GovExecutor "0x2aCeC6D8ABA90685927b61968D84CfFf6192B32C"

l1:
  rpcUrl: L1_MAINNET_RPC_URL
  explorerHostname: api.etherscan.io
  explorerTokenEnv: ETHERSCAN_TOKEN
  chainId: 1 # required for etherscan.io explorers (v2 API)

l2:
  rpcUrl: L2_MAINNET_RPC_URL
  explorerHostname: explorer.mode.network
  # explorerTokenEnv: ETHERSCAN_MODE_TOKEN
```

5. Start the program to generate a populated config from the seed one

```sh
yarn start path/to/config.seed.yaml --generate
```

`--generate` downloads missing ABIs and skips ones already present. Add `--update-abi` to re-download and overwrite existing ABIs.

6. Edit the generated config manually

### Configuration

Config is a yaml file that contains all the required addresses, parameters, view functions with their expected results for verification. The outline of the config is given below,

```yaml
# Sample config

parameters:
  # List of parameters
  - &MY_PARAMETER 42

misc:
  # Misc variables
  - &FOO "foo"

deployed:
  # Contract addresses
  - &myContract "0x0000000000000000000000000000000000000001"
  - &adminMultisig "0x0000000000000000000000000000000000000002"

roles:
  # ACL checks
  - &DEFAULT_ADMIN_ROLE "0x0000000000000000000000000000000000000000000000000000000000000000"

l1:
  rpcUrl: L1_MAINNET_RPC_URL # env variable
  explorerHostname: api.etherscan.io
  explorerTokenEnv: ETHERSCAN_TOKEN
  chainId: 1 # required for etherscan.io explorers (v2 API)
  contracts:
    myContract:
      name: "myContract"
      address: *myContract
      implementation: "%implementation address%"
      proxyChecks:
        proxy__getAdmin: *adminMultisig
      checks:
        # list of view functions and expected results
        getMyParameter: *MY_PARAMETER
        getFoo: *FOO
      ozAcl:
        *DEFAULT_ADMIN_ROLE : [*adminMultisig]
```

### ABIs

ABIs live in an `abi/` folder next to the config, or in a consolidated file (see below). `--generate` fetches missing ABIs for you. A plain check run does not; pass `--update-abi-missing` (or `--update-abi`) to fetch them. See [configs](/configs/).

state-mate supports two ABI storage formats:

1. **Individual files** (default): Each contract ABI is stored as a separate JSON file in the `abi/` directory
2. **Consolidated file**: All ABIs are stored in a single `abis.json` or `abis.json.gz` file alongside the config

#### Consolidating ABIs

For large projects with many contracts, you can consolidate all individual ABI files into a single compressed file to reduce repository size and improve performance:

```sh
yarn consolidate-abi path/to/config/abi
```

This command:

- Reads all `.json` files from the specified ABI directory
- Validates each ABI format
- Consolidates them into a single compressed `abis.json.gz` file alongside your config
- Provides compression statistics

Compression is the default. For an uncompressed `abis.json`, pass `--no-compress`:

```sh
yarn consolidate-abi path/to/config/abi --no-compress
```

**Note**: You cannot use both consolidated and individual ABI files simultaneously. state-mate will automatically detect which format you're using.

#### Updating ABIs

Use the `--update-abi` option to download all ABIs, overwriting existing files:

```sh
yarn start path/to/config.yaml --update-abi
```

To download only missing ABIs (without updating existing ones):

```sh
yarn start path/to/config.yaml --update-abi-missing
```

### Scoping checks

Use `-o` to run only part of a config. The path drills in from network section to contract to a single function:

```sh
yarn start path/to/config.yaml -o l1                          # one network section
yarn start path/to/config.yaml -o l1/myContract               # one contract
yarn start path/to/config.yaml -o l1/myContract/checks/getFoo # one check
```

## 🔧 Contributing

Any contributions to this project are welcome. Please fork the repository and submit pull requests with detailed descriptions of your changes. Or you can submit an issue, bug report or feature request.

## 📃 License

This project is licensed under the MIT License. See the [LICENSE](/LICENSE) file for details.
