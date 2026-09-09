# nep-bench (prototype — not a result)

**This suite does not measure next-edit prediction, and its number must never be
quoted as one.** It hands the ground-truth hunk to `@adze/apply` and checks the
hunk reconstructs byte-identically. No model proposes anything. A 100% pass rate
means thirty mined hunks reconstruct — a wiring signal that the mining loop and
the runner agree — not that prediction works, and not that the applier is correct.
See [the benchmark policy](../../../docs/benchmarks/strategy.md) and
[ADR-0011](../../../docs/architecture/adr/0011-benchmark-harness.md).

```bash
pnpm bench:nep                    # run the 30 mined cases and write a report
pnpm bench:list --suite nep-bench # list them without running
pnpm bench:nep -- --filter typescript  # filter works like every other suite
node bench/suites/nep-bench/scripts/mine.mjs --max 30  # regenerate the set
```

(`nep` is an alias for `apply --suite nep-bench`: one deterministic runner, one
code path to audit. List and filter behave identically to `apply-bench`.)

## Input distribution, stated plainly

- **One repo: Adze itself.** Not a dataset, not a sample of the ecosystem. The
  language mix is whatever Adze history holds: currently 15 TypeScript (2 from
  test files), 3 JavaScript, 10 JSON, 1 Markdown, 1 YAML.
- **Horizon is single-next-edit.** Each case is the *first* hunk of a file diff
  from the pre-image prefix; later hunks, if any, are future edits the prefix has
  not seen. The prefix is the full file, not a truncated window.
- **Provenance per case.** Every case `source` records `commit <SHA> file <path>
  language <lang>`, and every trajectory beside a report carries it, so any case
  can be re-derived from history by hand.

## Scoring

- **Exact match** is the pass: `pass` means byte-identical to the mined
  post-image, `wrong-output` is the miss. There is no near-miss score — a
  near-miss on source code is a different program (ADR-0005).
- **Parse validity** is the validator level that actually ran (`byValidator`):
  `tree-sitter` means a real parse, `structural` the delimiter check, `none`
  that nothing was checked. v0 does no AST normalization beyond that, stated as
  a limit rather than a second number.
- **Test pass is not measured in v0.** Cases touching test files carry the
  `test` tag — the future column's roster — but running them needs a container
  for honest isolation, and Tier 1 has no container by design.
- **Severe failures** (applied when a refusal was required) are reported first,
  as in every suite. The v0 set is output-only by construction, so the class is
  unexercised rather than covered; the report says so instead of claiming a clean
  sheet.

## Miner filters and exclusions

`scripts/mine.mjs` keeps only first-hunk intermediates that reproduce exactly by
string replacement with a unique search block, from files under size caps, capped
at 20–40 cases with a TypeScript-heavy quota. Two multi-hunk test intermediates
whose first hunk alone does not parse are excluded by id (`EXCLUDED_IDS` in the
script, with the reason): the applier rightly refuses them as `parse-broken`,
and a wiring set that is red by construction would stop running. Re-mining
reproduces an equivalent set up to cutoff boundary effects — review the diff.

## What a model loop needs (not built here)

Wiring prediction for real takes, in order: a task adapter that withholds the
true hunk and presents only the prefix (that adapter is where `checkPromptLeakage`
and `checkHistoryIsolation` first get an input to check); pinned dated model
snapshots with `inputSource` flipped to `model`/`mixed`; ≥3 attempts per case
reported as mean ± SEM, never max-over-N; cost split input/cached/output with hit
rate; the two-container Harbor design for the test-pass column; and a broken-task
audit of whatever dataset replaces single-repo history. Until then, this stays a
Tier-1 prototype with no publishable number.
