# state-mate

state-mate is a simple automation tool that validates the protocol state against an input configuration. Run state-mate to verify deploy parameters, current state, access control and more.

state-mate accepts a yaml file that includes contract addresses, view functions and their expected results. It calls each function and compares the output to the expected result.

## Features ✨

- state verification,
- supports any EVM network,
- easily configurable checks,
- CI-friendly,
- uses yaml config (env variables, variables, comments).

## Getting started ⚡

### Requirements

- git
- Node.js >=20,
- yarn

### Usage

1. Install dependencies

```sh
yarn install
```

2. Specify RPC endpoints for your target networks, e.g.

```sh
export L1_MAINNET_RPC_URL=%YOUR_RPC_URL%
```

3. Start the program

```sh
yarn start path/to/config.yaml
```

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

roles:
  # ACL checks
  - &DEFAULT_ADMIN_ROLE "0x0000000000000000000000000000000000000000000000000000000000000000"

l1:
  rpcUrl: L1_MAINNET_RPC_URL # env variable
  contracts:
    myContract:
      name: "myContract"
      address: *myContract
      checks:
        # list of view functions and expected results
        getMyParameter: *MY_PARAMETER
        getFoo: *FOO
```

### ABIs

All requried ABIs must be located in the same directory as the config and placed under `abi` folder. See [configs](/configs/).

## Contributing

Any contributions to this project are welcome. Please fork the repository and submit pull requests with detailed descriptions of your changes. Or you can submit an issue, bug report or feature request.

## License

This project is licensed under the MIT License. See the [LICENSE](/LICENSE) file for details.
