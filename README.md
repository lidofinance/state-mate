<h1 align="center">
  <img src="assets/banner.webp" alt="State Mate" width="100%" />
</h1>

<p align="center">
  Declarative state checks for EVM smart contracts.
</p>

<p align="center">
  <a href="https://github.com/lidofinance/state-mate/actions/workflows/ci.yaml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/lidofinance/state-mate/ci.yaml?branch=main&style=flat-square&label=CI" /></a>
  <a href="package.json"><img alt="Node.js 24 or newer" src="https://img.shields.io/badge/Node.js-24%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white" /></a>
  <a href="package.json"><img alt="Yarn 4.17.0" src="https://img.shields.io/badge/Yarn-4.17.0-2C8EBB?style=flat-square&logo=yarn&logoColor=white" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/lidofinance/state-mate?style=flat-square" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="docs/how-to.md">How-To Guides</a> ·
  <a href="docs/configuration.md">Configuration Reference</a> ·
  <a href="docs/cli.md">CLI Reference</a> ·
  <a href="docs/environment.md">Environment Reference</a> ·
  <a href="docs/abi-and-proxies.md">ABI &amp; Proxies</a>
</p>

state-mate compares live EVM contract state with an expected state declared in YAML. It verifies function results, storage slots, access control, proxy implementations, and proxy admin ownership. Failed checks produce a non-zero exit code for local and CI use.

## Quick start

Requirements: Node.js 24 or newer, Corepack with Yarn 4, and an RPC endpoint for each target network.

```sh
corepack enable
yarn install
cp .env.sample .env
```

Set the [environment variables](docs/environment.md) required by your config, then run it:

```sh
yarn start path/to/config.yaml
```

## What it checks

- view-function results and expected reverts
- raw storage slots
- enumerable and non-enumerable OpenZeppelin access control; non-enumerable checks automatically
  discover candidate holders from `RoleGranted` events and let the chain decide who still holds
- the full Aragon DAO permission map — grants, parameterized grants, and permission managers —
  discovered from the ACL's event history and reconciled against its raw storage
- proxy implementations and ProxyAdmin ownership
- coverage of every `view` and `pure` function in the selected ABI

## Development

```sh
yarn test
yarn lint
yarn format
yarn typecheck
```

Pull requests, bug reports, and feature requests are welcome.

## License

[MIT](LICENSE)
