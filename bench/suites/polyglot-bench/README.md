# polyglot-bench

**Deterministic edit-format signal sampled from Aider Polyglot's shape.** 40 cases
covering 10 languages, run with no model, no network, and no container.

```bash
pnpm bench:polyglot    # run the 40-case subset and write a report
node bench/harness/bin/adze-bench.mjs apply --suite polyglot-bench
```

## What this suite measures, and what it does not

It measures **edit format handling**: whether hand-written edits in the shape of
the Aider Polyglot tasks — one input file, one search/replace instruction, one
expectation — are well formed and whether `@adze/apply` applies or correctly
refuses them.

**These numbers measure edit format, not model behavior.** Every case here is
hand-written (`inputSource: synthetic`). Nothing here is evidence about how any
model formats an edit, and the per-tier and per-strategy tables must not be
described as "per model" — there is only one synthetic source of inputs. The
report states this in its limitations section, emitted before any number.

Two rates are reported:

| Rate | Meaning |
| --- | --- |
| `% well formed` | Cases whose edit blocks parsed as valid `EditBlock`s (a string `search` and `replace`, positive `occurrence` when present). A malformed case is a harness error, never a pass. |
| `pass rate` | Cases whose applier outcome matched the expectation, over all cases. |

For the committed 40 both are 100%: the inputs are well formed by construction,
and the applier meets every expectation. A regression in either fails the build.

## Why 40 of 225

Aider Polyglot is 225 tasks across many languages. Running all of them needs
model keys, a container, and minutes — none of which fits a pull-request gate.
This subset samples the language distribution and the edit-format failure modes
(trailing-whitespace drift, wrong-level indentation, elided interiors, ambiguity,
unparseable results) at a size that runs in under a second.

| File | Language | Cases |
| --- | --- | --- |
| `python.json` | Python | 8 |
| `typescript.json` | TypeScript | 8 |
| `javascript.json` | JavaScript | 6 |
| `go.json` | Go | 5 |
| `rust.json` | Rust | 4 |
| `java-shell.json` | Java (3), Shell (2) | 5 |
| `c-json-markdown.json` | C (2), JSON (1), Markdown (1) | 4 |
| **Total** | **10 languages** | **40** |

The sampling is documented, not proportional: the point is to cover each
language's validation path and each match strategy at least once, not to
replicate Polyglot's exact task mix. A case that pins `expect.strategy`,
`expect.tier`, or `expect.validator` is stronger evidence than one asserting
output alone, for the same reason as in `apply-bench`.

## Adding a case

Same format as `apply-bench` (`{ "cases": [ ... ] }`), same rules: `original`
and `expect.content` as a string or an array of lines joined with `\n` and
nothing added, so a trailing `""` element is how a file ending in a newline is
written. Every case carries the `polyglot` tag plus its language, and a
`source` noting the sampling.

A refusal is a legitimate expectation — see `apply-bench/README.md` for the
reasons. If a model produced an edit that broke a file, or a valid edit was
refused, add it here **and** in `packages/apply/test/` plus
`bench/suites/apply-bench/cases/` per `CONTRIBUTING.md`.

## Output

Same five files as `apply-bench` (`report.md` limitations-first, `result.json`,
`config.json`, `trajectories/` for every case including failures, `audit.md`),
written to `bench/.runs/<stamp>-polyglot-bench/` (gitignored) by default, or to
`bench/reports/<date>-polyglot-bench/` with `--out` for a report meant to be
reviewed.
