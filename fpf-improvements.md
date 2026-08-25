# FPF review — `feat/separate-deployed` (sibling-delegation engine)

A First Principles Framework (FPF) review of the sibling-delegation feature
(`src/sibling-delegation.ts` + `src/inputs.ts`, `src/deployed-addresses.ts`,
and the wiring in `src/state-mate.ts`). Each finding names its governing FPF
pattern and the conformance-checklist item it rests on.

## Framing

The branch publishes a **boundary/composition mechanism**: a wiring-only main
config plus sibling files that supply anchor _values_, plus an overlay that
_redefines_ them. Four conceptual constructs, four governing patterns:

| Construct in the code                                                                         | Governing FPF pattern                                       |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| The value / its `&label` / the YAML anchor node                                               | **A.7** Strict Distinction (Object ≠ Description ≠ Carrier) |
| `SiblingSpec` vs `OverlaySpec` (file _roles_) and their `collect`/`collectLabels` (_methods_) | **A.15** Role–Method–Work Alignment                         |
| The four invariants + overlay rules (boundary statements)                                     | **A.6.B** Boundary Norm Square (L/A/D/E)                    |
| `config` vs `externals` split "by authorship"                                                 | **C.2.P** Epistemic Precision Restoration                   |

The engine is already at good altitude — it generalizes a shared spec rather
than special-casing `.deployed`, and gets two hard A.7 calls right (below). FPF
sharpens four things, ranked by leverage.

## What FPF affirms (good altitude calls — keep as-is)

- **A.7 Object ≠ Carrier — the no-op check (`sibling-delegation.ts:427`).**
  Comparing `node.toJS(...)` _values_ (Objects), not YAML text (Carriers), is
  the correct distinction: `560048 ≡ "560048"`, array reorders are meaningful.
  A carrier-level (string) diff would have been the category error.
- **A.6.B "no gate smuggling" (CC-A.6.B.6).** The address check lives in the
  engine spec, _not_ the JSON schema, because "the schema's own format is
  permissive" (`sibling-delegation.ts:9-13`). That is the correct **L vs A**
  split: the schema states the _type law_ (L), the sibling spec states the
  compose-time _admissibility gate_ (A).

---

## Improvement 1 — [C.2.P] Declare the `externals` sub-kind; stop shape-sniffing `chainId`

_Leverage: highest. Touches the `.inputs` authoring contract — discuss before implementing._

`collectInputsEntries` (`inputs.ts:59-67`) decides whether an `externals` entry
must be a valid address by **guessing the kind from the value's shape**
(`isChainIdLikeInteger`: a non-negative bigint with `format == null`, or a
`/^\d+$/` string).

**C.2.P §4.1.2 — "recovered _by value_, not by guessing."** The word
`externals` is load-bearing and hides _two sub-kinds with different
admissibility_: a third-party **address** (a claim-bearing external fact) and a
numeric **chainId**. Because the sub-kind is inferred, the classification is
fragile at exactly the boundaries the check exists to catch:

- a third-party address mistakenly written as a bare integer → sniffed as
  "chainId-like" → **address check silently skipped**;
- the exemption is a moving target as other numeric externals appear (block
  numbers, timestamps) — each widens the shape-heuristic.

**Suggestion:** let the author _declare_ the sub-kind instead of the engine
sniffing it — e.g. a dedicated numeric grouping or a `chainId:`/`numbers:`
sub-key — so the admissibility predicate dispatches on a **declared kind**
rather than a value shape. Deletes `isChainIdLikeInteger` and its comment block.

## Improvement 2 — [A.15] Unify the collection _Method_ to one `{labels, values, sections}` contract

_Leverage: high. Safe refactor, zero behavior change._ — **✅ Implemented.** `SiblingSpec.collectLabels`
replaced by `collect(document, fileLabel) → CollectedEntries`; `collectInputsLabels` wrapper removed;
the overlay loop reuses `base.entries` instead of re-collecting the base document. Typecheck, lint,
prettier, and all 28 unit tests pass.

`SiblingSpec.collectLabels` returns _only_ labels; `OverlaySpec.collect`
returns labels **+ values + sections** (`sibling-delegation.ts:33` vs `:59-62`).
They are two Methods for what is conceptually **one Role** — "read a delegation
file's labeled entries."

**A.15 CC-A15-1 (Entity Distinction).** The narrow `collectLabels` contract
forces the base `.inputs` document to be **collected twice with two different
methods**: once label-only in the siblings loop (`:331`), then fully as
`baseEntries` in the overlay loop (`:401`) — the redundant traversal. Both are
symptoms of the same under-generalized Role.

**Suggestion:** give `SiblingSpec` a single
`collect(document) → {labels, values, sections}` method; derive `collectLabels`
as `.labels` at the call site. The overlay loop then reuses the `base.collect`
result instead of re-running it. One Method per Role → the asymmetry _and_ the
double-traversal both dissolve. (`deployed-addresses.ts`'s collector returns
empty or full `values`/`sections` — cheap either way.)

## Improvement 3 — [A.6.B] Give each invariant a stable ID; cite it in errors, docs, and tests

_Leverage: medium. Safe, mostly mechanical._

The invariant set is stated **three times in three paraphrases**: as prose
throws (`composeWithSiblings`, `collectInputsEntries`, `collectDeployedLabels`),
as a prose sentence in `CLAUDE.md` ("Four invariants are enforced…"), and as
`node:test` names in `inputs.test.ts` / `overrides.test.ts`.

**A.6.B CC-A.6.B.1 (atomicity) + CC-A.6.B.4 (reference by ID, not paraphrase);
AP-6 "paraphrase drift."** Three prose copies of one atomic claim set is the
canonical drift hazard — a fifth invariant or a reworded rule can update one
copy and not the others.

**Suggestion:** assign stable IDs to the atomic claims (all quadrant **A**,
compose-time admissibility):

| ID      | Claim                                                      |
| ------- | ---------------------------------------------------------- |
| `SD-A1` | every delegated value carries an `&label`                  |
| `SD-A2` | every label is referenced by a `*alias` in the main config |
| `SD-A3` | the main config holds none of the delegated sections       |
| `SD-A4` | no duplicate label / collision with a main-config anchor   |
| `SD-A5` | (overlay) introduces no new label                          |
| `SD-A6` | (overlay) keeps each label's section                       |
| `SD-A7` | (overlay) changes every value (no no-op)                   |

Emit the ID in each thrown message and cite it from `CLAUDE.md` and the test
names. One authority, N references.

## Improvement 4 — [A.7] Treat delegated sections as anchor-_books_ (Carriers), not Objects

_Leverage: medium. Touches the returned document shape — discuss before implementing._

After composition, the delegated `config:` / `externals:` / `deployed:` sections
**remain in the returned JS document** as their _base_ values, while the wiring
aliases resolve to the _override_ values. So with `--overrides`, the composed
object holds **two values for the "same" label**: `document.config[0]` =
`"Liquid staked Ether 2.0"` but `document.l1…name` (its alias) = `"stETH"`.

**A.7 §5.5 (Episteme vs Symbol Carrier) / CC-A7.13 (EntityOfConcern recoverable,
not conflated with carrier).** The `EntityOfConcern` is the _wired_ config
(`l1`/`l2`/…); the delegated sections are **carrier books** whose only job is to
source anchors. Retaining them — now that `typebox.ts` added `config`/`externals`
as `Optional`, which _invites_ reading them — is an Object/Carrier conflation.
Latent today (nothing reads them for checks) but a future consumer iterating
`document.externals` would silently get pre-override values.

**Suggestion:** in the sibling-composed path, strip `deployed`/`config`/
`externals` from the composed JS object after alias resolution — exactly as the
code already strips `__state_mate_overrides__` (`sibling-delegation.ts:462-466`).
That makes "these are carrier books, not data" a _mechanically enforced_
invariant instead of a convention. Safe: `deployed` is only consumed by the
generator, which bypasses siblings.

## Minor — [A.7 / A.6.B] Make the reserved-key guard unconditional

`__state_mate_overrides__` collision is checked only when
`overlayDocuments.length > 0` (`sibling-delegation.ts:444`). The key is
_reserved regardless_ of whether this run has an overlay; guarding it only
sometimes is a small altitude gap. Cheap to check unconditionally.

---

## Suggested sequencing

1. **Improvements 2 + 3** first — pure cleanup, zero behavior change, backed by
   the 28 passing unit tests.
2. **Improvement 4** next — small behavior change (returned document shape),
   discuss whether any consumer relies on the delegated sections.
3. **Improvement 1** last — changes the `.inputs` authoring shape; needs a
   design decision on how sub-kinds are declared.

## Pattern references

- **A.7** Strict Distinction (Clarity Lattice) — Object ≠ Description ≠ Carrier;
  Episteme vs Symbol Carrier (§5.5); CC-A7.13.
- **A.15** Role–Method–Work Alignment — CC-A15-1 (Entity Distinction).
- **A.6.B** Boundary Norm Square — L/A/D/E routing; CC-A.6.B.1, CC-A.6.B.4,
  CC-A.6.B.6; AP-6 (paraphrase drift).
- **C.2.P** Epistemic Precision Restoration — §4.1.2 (recovered by value, not by
  guessing).
