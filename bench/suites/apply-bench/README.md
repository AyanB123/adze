# apply-bench

**Apply success rate per model per tier.** No other open-source coding tool
publishes this, which is most of the reason it exists.

```bash
pnpm bench:list      # list the cases
pnpm bench:apply     # run them and write a report
```

## What this suite measures, and what it does not

It measures `@adze/apply` against **hand-written** edits. It measures nothing
about any model. Every generated `report.md` says so in its limitations section,
which is emitted before any number — see
[the benchmark policy](../../../docs/benchmarks/strategy.md) and
[ADR-0011](../../../docs/architecture/adr/0011-benchmark-harness.md).

A pass rate of 100% means every case anyone has written down passes. It does not
mean the applier is correct. Coverage here is exactly what somebody thought to
encode, and the suite grows one real failure at a time.

The run is deterministic — no model calls, no network, no container — so it is a
Tier-1 gate eval: it runs on every pull request in under a second. There is no
confidence interval, and the report explains why rather than printing a
zero-variance one.

## Adding a case

**This is the highest-leverage contribution in the repository**, and it needs no
AI expertise. A case is an input file, an edit, and an expectation. If a model
produced an edit that broke a file, or a valid edit was refused, that is a bug
report *and* a permanent regression test for every model Adze ever supports.

Either open an issue with
[the apply-failure template](../../../.github/ISSUE_TEMPLATE/apply_failure.yml)
and let us encode it, or add it here directly.

Cases live in `cases/*.json`, grouped by theme:

| File | Theme |
| --- | --- |
| `matching.json` | The four match strategies, and the boundaries between them |
| `refusals.json` | Ambiguity, not-found, no-op — edits that must not be applied |
| `validation.json` | Parse validation: what it catches, and what it must not false-positive on |
| `tiers-and-languages.json` | Tier escalation, whole-file rewrites, per-language detection |

Append to whichever fits, or add a new file. Every file is
`{ "cases": [ ... ] }`.

```json
{
  "cases": [
    {
      "id": "unique-kebab-case-id",
      "description": "What this tests and why it matters.",
      "path": "src/example.ts",
      "original": ["function f() {", "  return 1;", "}", ""],
      "edits": [{ "search": "  return 1;", "replace": "  return 2;" }],
      "expect": {
        "kind": "output",
        "content": ["function f() {", "  return 2;", "}", ""],
        "strategy": "exact"
      },
      "tags": ["matching"],
      "source": "optional: issue URL, or the model that produced the failure"
    }
  ]
}
```

### The fields that make a case worth more than a smoke test

**`original` and `expect.content` may be a string or an array of lines.** An array
is joined with `\n` and **nothing is added**, so a file ending in a newline needs a
final `""` element. That is more typing, and it is deliberate: whether a file ends
with a newline changes what the applier matches, so a format that silently inserted
one would make some real failures unreproducible.

**`expect.strategy` pins which of the four match strategies was used.** Without it,
a case written to exercise indentation tolerance silently stops testing that the
moment matching changes — it will still pass on the output alone. The same goes for
`expect.tier` and `expect.validator`.

**`expect.validator` asserts evidence, not success.** `structural` means the
delimiter-and-indentation check ran; `none` means the language was unknown and
nothing was checked at all. A case asserting `none` is asserting that we declined
to guess.

### To assert a refusal instead of an output

```json
{
  "expect": { "kind": "refusal", "reason": "ambiguous", "tier": "search-replace" }
}
```

Valid reasons: `not-found`, `ambiguous`, `parse-broken`, `file-too-large`,
`tier-unavailable`, `no-op`. **A refusal is a legitimate expected outcome and
several cases here assert exactly that** — the alternative to refusing an
ambiguous edit is corrupting a file. `tier` is optional and worth setting: on a
refusal the result *is* the diagnosis, so the tier credited with it is what lands
in the per-tier breakdown.

### `options`, for cases that need a non-default configuration

```json
{ "options": { "tiers": ["whole-file"], "maxWholeFileBytes": 16 } }
```

## Output

`pnpm bench:apply` writes to `bench/.runs/<stamp>-apply-bench/`, which is
gitignored — a run on every pull request is an artifact, not a commit. Pass
`--out bench/reports/<date>-apply-bench` for a report meant to be published and
reviewed.

```
report.md       human-readable, limitations first
result.json     machine-readable, schema in bench/harness/src/report-schema.ts
config.json     harness version, invocation, environment
trajectories/   one file per case, inputs and outputs, failures included
```

Trajectories are written for **every** case, passing or failing. Publishing
failures is the strongest available credibility signal, and a report that contains
only passes is not checkable.

## Reading the report

Read the **severe failures** section first. A case written to be refused that
instead applied means the applier wrote a file it was supposed to decline, which is
the failure users actually feel. It is reported separately from the ordinary pass
rate and above the breakdowns, so it cannot average away.
