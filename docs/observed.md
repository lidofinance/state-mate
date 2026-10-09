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
holds. `ozAcl` records its `getRoleMemberCount` and `hasRole` calls; `ozNonEnumerableAcl`,
`aragonAcl` and the automatic proxy checks record nothing.
[`--expand-enumerations`](cli.md#expand-enumerations) adds the entries it reads and their count.

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

Three kinds of `null` are not read:

- a function that takes arguments, such as `balanceOf: null`: the config names no argument to
  call it with;
- a bare name that matches several overloads: the config names no signature to call;
- the placeholders `implementationChecks` supplies for every view of the implementation ABI the
  config does not list: the config never declared them.
