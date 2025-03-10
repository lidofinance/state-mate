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

3. Specify RPC endpoints for your target networks, e.g.

```sh
# config.seed.yaml

export L1_MAINNET_RPC_URL=%YOUR_RPC_URL%
export L2_MAINNET_RPC_URL=%YOUR_RPC_URL%
```

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

l2:
  rpcUrl: L2_MAINNET_RPC_URL
  explorerHostname: explorer.mode.network
  # explorerTokenEnv: ETHERSCAN_MODE_TOKEN
```

4. Start the program to generate a populated config from the seed one

```sh
yarn start path/to/config.seed.yaml --generate
```

5. Edit the generated config manually

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

All required ABIs are located in the same directory as the config and placed under `abi` folder being downloaded upon the first launch. See [configs](/configs/).

Use the --update-abi option to download all ABIs overwriting existing files 

### For developers

Use the --schemas option to generate new JSON schemas in the 'schemas' folder

## 🔧 Contributing

Any contributions to this project are welcome. Please fork the repository and submit pull requests with detailed descriptions of your changes. Or you can submit an issue, bug report or feature request.

## 📃 License

This project is licensed under the MIT License. See the [LICENSE](/LICENSE) file for details.
