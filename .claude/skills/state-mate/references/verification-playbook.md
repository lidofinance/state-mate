# Deployment verification playbook

How to verify that a deployment is correct and honest: constants recompute from their claimed sources, implementations are neutered, temporary addresses hold no roles. Use it when reviewing a config for a fresh deployment (pre-vote state, upgrade audit), not for routine config edits.

A config passing against the chain only proves "config == chain". The steps below prove "chain == what was intended".

**Re-running the config is the primary instrument.** Anything provable as a config check must become one: a check re-runs on every change and in CI, while a one-off `cast` call proves nothing after the session ends. Read on-chain values with REPLACEME runs. The strongest single re-run: delete the ABI archive, re-fetch with `--update-abi-missing`, full run. That verifies the config against freshly verified source in one shot. Reserve `cast` for what a config run cannot express (section A).

## A. What a config run cannot express (once per review)

Don't trust a comment or a copy-pasted constant: recompute it.

- **Role hashes**: recompute every `bytes32` hash against its claimed source with `cast keccak "ROLE_NAME"`.
- **Addresses**: `cast to-checksum $ADDR` must return every address unchanged (EIP-55). Catches single-character tampering.
- **Namespaced storage slots**: for constants like `keccak256("project.Contract.varName")`, reconstruct the dotted string and recompute. Document the formula in a comment once verified.
- **Domain-bound constants** (hashes that embed chainId and/or the contract's own address, e.g. signed-message prefixes): reconstruct the derivation and recompute. This proves the value binds to the right network and the right contract instance.
- **ABI vs bytecode**: `cast selectors "$(cast code $ADDR --rpc-url $RPC)"`. Every selector in the dispatch table must match the ABI and vice versa. Catches hidden functions and incomplete ABIs.
- **Numeric parameters**: cross-check against the external deploy document, not just the chain. The config and the chain can both carry the same wrong value. Flag any value with no documented source.
- **Identify every role holder**: `cast code` (EOA vs contract), `VERSION()(string)` (Safe detection), then match against docs and sibling configs. Flag unidentified holders to the deploy team instead of legitimizing them by pinning.
- **`initialize()` on bare implementations**: simulate with `cast call` (plain eth_call, no transaction needed) and expect the init-guard revert (OZ 5.x: `InvalidInitialization`, selector `0xf92ee8a9`). state-mate cannot check this (the function is nonpayable). Note the result in a review comment, not a config comment.

## B. Checks to encode in the config

### Live contracts with AccessControl

- `ozAcl` with exhaustive per-role member lists, including empty roles as `[]`.
- `getRoleAdmin(role) == DEFAULT_ADMIN_ROLE` for every role. Catches a `_setRoleAdmin` backdoor: a custom admin role lets someone grant roles bypassing the real admin.

```yaml
checks:
  getRoleAdmin:
    - args: [*SOME_ROLE]
      result: *DEFAULT_ADMIN_ROLE
```

- Explicit `hasRole(DEFAULT_ADMIN_ROLE, <deploy tooling / temporary admin>) == false`: temporary admin renounced.
- Skip standalone `getRoleMemberCount` checks: `ozAcl` already verifies the count and each member.

### Gnosis Safe (committees)

- Model the stanza as a proxy: `name: Safe` (singleton ABI), `proxyName: SafeProxy`, `implementation:` the canonical singleton (see the Gnosis Safe pattern in SKILL.md).
- `VERSION`, `getThreshold`, and the full `getOwners` list. A composition change must break the run. Check every owner is what you expect (EOA vs contract) with `cast code`.
- Pin the module list to empty: a Safe module executes transactions bypassing owner signatures.
- Pin the takeover-surface storage slots via `storage:`: slot `0x0` == the canonical Safe singleton for that version; `keccak("fallback_manager.handler.address")` == the canonical CompatibilityFallbackHandler (a malicious handler runs code as the Safe); `keccak("guard_manager.guard.address")` == zero unless a guard is documented.

```yaml
checks:
  getModulesPaginated:
    - args: ["0x0000000000000000000000000000000000000001", 10]
      result: [[], "0x0000000000000000000000000000000000000001"]
```

### Implementations

Put these in `implementationChecks:` inside the proxy stanza, not in a separate contract stanza. It auto-covers unlisted view functions as skipped.

- **Petrification sentinel**, the one check that answers "can this impl be hijacked":
  - OZ Initializable: version getter == max value of its type (`MAX_UINT256` / `MAX_UINT64`).
  - Aragon apps: `isPetrified: true`, `getInitializationBlock` == `MAX_UINT256`, kernel == zero address.
  - No sentinel getter at all: only the eth_call simulation from section A proves it.
- **Immutables == production values.** Constructor-baked wiring (addresses, ids) proves deploy parameters were right. Harvest actuals with REPLACEME; they equal the proxy's values, since immutables live in bytecode.
- **Everything set by `initialize` == zeros/defaults.**
- `hasRole(DEFAULT_ADMIN_ROLE, <the proxy's admin>) == false`: the distinguishing zero check. The admin holds the role on the proxy but must not on the bare impl.
- Role-hash constant getters are bytecode, not state. They say nothing about neutering: any deploy of the same code returns the same value.

### Pre-state pins (before a vote / enactment)

Pin empty registries and unassigned pairs with explicit arg checks, so premature configuration breaks the run:

```yaml
checks:
  getAllowedTargets:
    - args: [1]
      result: []
  isPairAllowed:
    - args: [1, 1]
      result: false
```

## C. Config organization

- Sections by purpose: `parameters:` holds network system predeploys only; `deployed:` the contract address book; `misc:` numeric/bytes32 constants; `roles:` role hashes; `eoa:` EOAs.
- Name anchors by meaning, not by value (`&MIN_DEPOSIT`, not `&THIRTY_TWO_ETH_WEI`). Two anchors may share a value when semantics differ.
- Give predeploys a suffix (e.g. `_CONTRACT`) so the anchor doesn't shadow a same-named check key.
- Put a reproduction comment (`# cast keccak "..."`) above every verifiable hash.
- Hoist repeated values into anchors; single-use data literals may stay inline. Group stateless libraries at the bottom of `contracts:`.
