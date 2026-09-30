# Declared, observed, and the block in between

[Back to README](../README.md)

A config declares what the chain should say. A run reads the chain and reports where the two
differ. Three options make the reading side explicit, so that the values behind a verdict can be
kept, diffed and re-read.

## `--block <number|latest>`

Every `eth_call`, `eth_getStorageAt`, `eth_getCode` and `eth_getBalance` of the run names this
block instead of `latest`, and the ACL log scans end at it. With `latest` the block is resolved
once per network section, when the section starts.

Without the option each read is served at whatever block is the head at that moment, so a list
and its length can come from different blocks. A vault that deallocates a market between the
`marketIdsLength()` read and the `marketIds(i)` reads passes both checks and still describes a
set that never existed.

A numbered block requires a single config file: a directory usually spans several chains.
A block the RPC does not serve fails the run before any check.

```sh
yarn start configs/vault.yaml --block 65439916
yarn start configs/vault.yaml --block latest --observed out/vault.observed.yaml
```

## `--observed <file>`

The values the chain answered, written after the run as YAML, keyed the way the config asks:

```yaml
config: configs/vault.yaml
generated_at: 2026-09-19T10:00:00.000Z
sections:
  robinhood:
    chainId: "46630"
    block: 65439916
    pinned: true
    contracts:
      vault:
        address: "0x..."
        checks:
          marketIdsLength:
            - value: "4"
          marketIds:
            - args: [0]
              value: "0x..."
          adapters:
            - args: [9]
              reverted: execution reverted
        storage:
          "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc": "0x..."
```

`checks`, `proxyChecks` and `implementationChecks` list one entry per call, in config order,
with `args` when the call took any and either `value` or `reverted`. Numbers are decimal
strings, structs with named fields are maps, other tuples are lists. `block` is the pinned block,
or the head when the section started with `pinned: false`. A run that aborts still writes what
it read.

The file is not a config: it says what the chain answered, not what the reviewer accepted.
Diffing two observed files taken at two blocks shows what moved; diffing the config against the
observed file shows what the config is silent about.

## Checks the config declines to assert

`checks: { _totalAssets: null }` declares the function so the coverage rule passes and tells the
run not to assert its value. With `--observed` the value is still read once at the block and
written to the observed file, marked no differently from any other answer; the check statistics
still count it as skipped, because nothing was asserted. Without `--observed` such a check is not
read at all.

## `--expand-enumerations`

A `<name>Length` or `<name>Count` check next to a `<name>(uint256)` view is an enumeration.
For every one the config declares, the run reads the count from the chain, then reads every index
the config does not list as a `<name>(i)` entry. A length declared `null` counts as declared: the
checks skip it, and the expansion reads it and records the count, because `null` declines to
assert a value, not to look. Each such value goes into the observed file and into
the report as a warning:

```text
⚠ .marketIds(4): not in the config; the chain says 0x127353ba...
```

Warnings do not change the exit code: the config is incomplete, not wrong. A reviewer that wants
completeness enforced reads the warnings from the [JSON report](json-output.md). Enumerations of
more than 1000 entries are reported and not read.
