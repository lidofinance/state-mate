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
- Node.js >=22,
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

3. Specify RPC endpoints for your target networks: copy `.env.sample` to `.env` and adjust the URLs, or export the env vars a config names in its `rpcUrl:` fields, e.g.

```sh
export ETH_RPC_URL=%YOUR_RPC_URL%
export MODE_RPC_URL=%YOUR_RPC_URL%
```

4. Run a config, or every config in a directory

```sh
yarn start configs/lido/mainnet/lido.yaml
yarn start configs/lido/mainnet
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
  - &adminMultisig "0x0000000000000000000000000000000000000002"

roles:
  # ACL checks
  - &DEFAULT_ADMIN_ROLE "0x0000000000000000000000000000000000000000000000000000000000000000"

l1:
  rpcUrl: ETH_RPC_URL # env variable
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

state-mate keeps all ABIs for a config in a single compressed `abis.json.gz` file next to the config, keyed by EVM chain ID and lowercase contract address:

```json
{ "1:0x17144556fd3424edc8fc8a4c940b2d04936d17eb": { "name": "Lido", "abi": [...] } }
```

The chain ID distinguishes contracts deployed at the same address on different networks. The `name:` / `proxyName:` fields in YAML serve as a sanity check: state-mate compares them with the stored name and fails on mismatch. For proxies, `checks` resolve the ABI at `implementation:`, `proxyChecks` at `address:`. See [configs](/configs/).

#### Implementation check

`implementation:` decides which ABI the `checks` run against, so state-mate verifies it against the chain for every contract entry, with or without `proxyChecks`:

- an entry with `implementation:` must name the address the proxy delegates to. state-mate reads the EIP-1967 slot, falls back to `implementation()`, then to the first storage slot where Safe keeps its singleton;
- an entry without `implementation:` must have an empty EIP-1967 slot. A non-empty slot means a proxy is described as a regular contract, and every check runs against the proxy ABI instead of the implementation's.

Aragon proxies and Safes keep the implementation outside the EIP-1967 slot, so state-mate verifies them only when the config declares them as proxies; the Safe singleton slot is read only for `proxyName: SafeProxy` or `GnosisSafeProxy`, because anywhere else the first slot holds an ordinary variable. When no read returns an address, the check prints a warning and moves on. `--skip-implementation-check` turns the check off, and so does narrowing a run to one checks type (`-o l1/contractName/checks`); the `proxyAdminOwner:` check stays on either way, since it runs only where the config asks for it.

#### Proxy admin owner

An upgrade of a transparent proxy goes through the ProxyAdmin in its EIP-1967 admin slot, so what matters is who owns that ProxyAdmin. The optional `proxyAdminOwner:` field asserts it:

```yaml
someProxy:
  name: Vault
  address: *vault
  proxyName: TransparentUpgradeableProxy
  implementation: *vaultImplementation
  proxyAdminOwner: *agent
  proxyChecks: {}
```

state-mate reads the admin slot and calls `owner()` on whatever it finds, so the ProxyAdmin needs no anchor and no ABI in the store. Pin the admin address itself with a `storage:` check when you want both. An admin that answers no `owner()`, a Safe for instance, fails the check: assert such an admin through `storage:` instead.

#### Updating ABIs

Every run downloads the ABIs missing from `abis.json.gz`, so a config that gained an address needs no flag. Bytecode at an address never changes, so a stored ABI is never stale on its own.

`--update-abi` rebuilds the store instead: it re-downloads every address the run walks and drops the entries no config references any more. An address the explorer refuses to serve keeps the ABI already stored for it, so a rebuild cannot lose a contract that was verified once and is not any more. CI runs pass `--quiet` to keep only failures and totals in the log.

```sh
yarn start configs/lido/mainnet --update-abi
```

One store serves every config in its directory. A single-file run refreshes its own ABIs and leaves every other entry alone; unreferenced keys are pruned only when the whole directory runs, since only then has every config declared what it needs. A section with no `explorerHostname` cannot re-download, so the rebuild keeps its stored ABIs as they are.

## 🔧 Contributing

Any contributions to this project are welcome. Please fork the repository and submit pull requests with detailed descriptions of your changes. Or you can submit an issue, bug report or feature request.

## 📃 License

This project is licensed under the MIT License. See the [LICENSE](/LICENSE) file for details.
