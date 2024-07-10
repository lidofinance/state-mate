# StateMate

StateMate is a simple automation tool that verifies protocol state against an input configuration. The checks may include deploy parameters, addresses, access control, and any view functions with an expected result.

## Getting Started

Install dependencies

```sh
yarn install
```

Specify RPC endpoints for your target networks, e.g.

```sh
export L1_MAINNET_RPC_URL=%YOUR_RPC_URL%
export L2_RPC_URL=%YOUR_L2_RPC_URL%
```

Start the program

```sh
yarn start path/to/config.yml
```

## Configuration

Config is a yaml file that contains all the required addresses, parameters, view functions with their expected results for verification.

## ABIs
