# Observed values

[Back to README](../README.md)

A config declares what the chain should say. A run reads the chain and reports where the two
differ. `--observed <file>` keeps the reading side: the values the chain answered, so that the
values behind a verdict can be kept, diffed and re-read. It requires a single config file and
pairs with [`--block`](cli.md#pin-reads-to-one-block), which makes every value come from one
block.

```sh
yarn start configs/vault.yaml --block latest --observed out/vault.observed.yaml
```

## The file

The values the chain answered, written when the run ends as YAML, keyed the way the config asks:

```yaml
config: configs/vault.yaml
generated_at: 2026-09-19T10:00:00.000Z
sections:
  robinhood:
    chainId: "4663"
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
strings, structs with named fields are maps, other tuples and arrays are lists. `block` is the
pinned block, or the head when the section started with `pinned: false`; a section pinned by
hash also carries `blockHash`. `storage` maps each slot the config checks to the word the chain
holds.

A run that ends early still writes what it read: a failed check that exits, a fatal error, Ctrl+C
and SIGTERM all pass through the same single write. Without `--observed` nothing is kept.

The file is not a config: it says what the chain answered, not what the reviewer accepted.
Diffing two observed files taken at two blocks shows what moved; diffing the config against the
observed file shows what the config is silent about.

## Checks the config declines to assert

`checks: { _totalAssets: null }` declares the function so the coverage rule passes and tells the
run not to assert its value. With `--observed` the value is still read once and written to the
observed file, marked no differently from any other answer; the check statistics still count it
as skipped, because nothing was asserted. Without `--observed` such a check is not read at all.

Two kinds of `null` are not read:

- a function that takes arguments, such as `balanceOf: null`: the config names no argument to
  call it with;
- the placeholders `implementationChecks` supplies for every view of the implementation ABI the
  config does not list: the config never declared them.

## `--expand-enumerations`

A `<name>Length` or `<name>Count` check next to a `<name>(uint256)` view is an enumeration.
For every one the config declares, the run reads the count from the chain, then reads every index
the config does not list as a `<name>(i)` entry. A length declared `null` counts as declared: the
checks skip it, and the expansion reads it, because `null` declines to assert a value, not to
look. The placeholders `implementationChecks` supplies for an undeclared view are not expanded.
Each such value goes into the report as a warning, and into the observed file with the count it
was read against:

```text
⚠ .marketIds(4): not in the config; the chain says 0x127353ba...
```

Warnings do not change the exit code: the config is incomplete, not wrong. A reviewer that wants
completeness enforced reads the warnings from the [JSON report](json-output.md). A count that
cannot be read is a warning too, so an enumeration is never taken for fully expanded when it was
not read. Enumerations of more than 1000 entries are reported and not read.
