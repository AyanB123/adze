# 0005 — Three-tier edit applier with parse validation

**Status:** Accepted
**Date:** 2026-08-29
**Deciders:** @AyanB123

## Context

The failure users actually feel is not a wrong answer. It is a mangled file. An
agent that is right 90% of the time and corrupts a file the other 10% is worse
than useless, because it destroys trust in a way a wrong suggestion does not.

**The landscape of edit formats**, with what each was invented to fix:

| Format | Mechanism | Why it exists |
| --- | --- | --- |
| Whole-file | Model returns the entire file | Most reliable, most expensive |
| Search/replace | Conflict-marker blocks matched by string | Token-cheap, deterministic; brittle if the model mis-quotes |
| Unified diff | Simplified `udiff` | Introduced specifically to stop models emitting `# ... original code here ...` elisions |
| `diff-fenced` | Path inside the fence | A pure prompt-conformance workaround for one model family |
| Fast-apply model | A small model merges a lazy diff into the full file | Reliable *and* fast; needs a second model |
| Bash `sed`/heredoc | Model writes shell | Eliminates the apply-failure class entirely — and any safety net with it |

**The numbers that matter.** The best model on a public edit benchmark reaches
88.0% pass with **91.6% of cases well-formed** — meaning roughly **8.4% of
attempts produce a malformed edit** from the best available model. Commercial
fast-apply services claim 10,000+ tokens/second and around 98% success, and exist
precisely because "deterministic approaches like search-and-replace or udiff were
brittle, model-specific, and required extensive prompt engineering."

**And there is no open-weights fast-apply model with meaningful adoption.** The
credible options are proprietary APIs.

**Two more things worth knowing.** First, one round of test feedback moved pass
rate from 52.0% to 88.0% on that same benchmark — retry is worth more than format
choice. Second, there is a credible argument that fast-apply is a transitional
technology, because frontier labs optimize against diff-editing benchmarks and
base models keep getting more precise at structured edits.

**The gap we can fill:** nobody in open source publishes apply reliability as a
metric. It is cheap to measure, it predicts whether users trust the tool, and it
is invisible in every current comparison.

## Decision

**A three-tier applier that validates before writing, and publishes its own
success rate.**

### Tier 1 — bounded-fuzzy search/replace

Escalating match strategies, first unique match wins:

1. **Exact** — byte-identical.
2. **Whitespace-normalized** — collapse runs of intra-line whitespace.
3. **Indentation-tolerant** — match content, allow a uniform indent shift, and
   re-indent the replacement to the found indentation.
4. **Anchored** — match on a unique first and last line and splice the interior.

Then **parse-validate**. Fail ⇒ reject the edit and fall through to Tier 2.

Non-negotiable constraints:

- **Ambiguity is an error, never a guess.** Multiple matches at the same strategy
  level ⇒ reject with the match locations reported. Silently picking the first is
  how files get corrupted in a way nobody can reproduce.
- **Never relax past indentation tolerance.** No Levenshtein-style "closest
  match". A near-miss on code is a different program.

### Tier 2 — whole-file rewrite

For files under a configurable size threshold when Tier 1 finds no unique safe
match. Also parse-validated.

### Tier 3 — pluggable fast-apply provider

Optional, configured, **never a hard dependency**. Adze must work fully with it
absent. Its output is parse-validated like everything else — a fast-apply model is
a model, so it is untrusted.

### Parse validation, degrading honestly

- **With tree-sitter grammars present:** a real parse. Reject on error nodes.
- **Without:** a structural balance check — delimiter balance tracked through
  string and comment states, plus indentation coherence.

The fallback catches the large majority of real corruption and needs no WASM
download, so the safety property holds on a fresh clone rather than after setup.

### Measurement is part of the feature

Every attempt records: tier, match strategy, parse-validation result, retry count,
tokens, latency. Aggregated, this produces **apply success rate per model per
tier**, published in `bench/reports`. `bench/suites/apply-bench` is the regression
suite, and a contributed failing case is the most valuable bug report in the repo.

### Per-model format selection

Format preference is a per-model table, not a global constant, because model
families measurably differ. The table is data, so contributors can extend it
without touching the engine.

## Alternatives considered

**Search/replace only** — rejected. Simplest and cheapest, but ~8.4% malformed
from the best model with no recovery path is not an acceptable floor.

**Whole-file always** — rejected. Most reliable and unaffordable: a 2,000-line
file rewritten for a three-line change, every time. Kept as Tier 2 where the
trade-off is worth it.

**Fast-apply as the primary path** — rejected. It is the most reliable option and
it would make us depend on a proprietary API for core correctness, break
local-first, and bet on a technology with a credible argument that it is
transitional. Supported as Tier 3, never required.

**Bash `sed`/heredoc only (the minimal-harness approach)** — rejected. It does
genuinely eliminate the apply-failure class by construction, which is elegant.
But it also eliminates our ability to *refuse* a corrupting edit, and refusal is
the property we are trying to sell. It remains available through the `bash` tool
for models that prefer it.

**Skip parse validation** — rejected. It is the cheapest possible correctness
check and the difference between "the agent made a mistake" and "the agent broke
my build."

## Consequences

**Good.** Corruption becomes a refused edit instead of a broken file. A metric
nobody else publishes, which is both a differentiator and an accountability
mechanism. Contributors can improve reliability without touching the engine.
Tier 1 handles most edits at zero extra model cost.

**Bad.** Three code paths to maintain and test. Parse validation costs a few
milliseconds per edit. Strict ambiguity rejection will sometimes refuse an edit a
human would have accepted.

**Costs we accept.** A **higher refusal rate than competitors** — and we will
report it, because a refusal is a good outcome and hiding it would defeat the
point. Also the maintenance of a per-model format table that needs updating as
models ship.

## Revisit when

- An open-weights fast-apply model reaches real adoption — that would make Tier 3
  viable as a default without breaking local-first.
- `apply-bench` shows Tier 1 above ~99% across all supported models, at which
  point Tier 2 may become dead code worth removing.
- Base models stop producing malformed edits, which would make this whole ADR a
  historical artifact. That is the outcome we would most like.
