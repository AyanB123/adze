# Benchmark policy

This document is written **before Adze has produced a single benchmark number.**
That is deliberate. A policy written after results exist is a rationalization; a
policy written before them is a constraint.

The reasoning and evidence behind these rules is in
[ADR-0011](../architecture/adr/0011-benchmark-harness.md). This is the operational
version.

---

## The two rules that cost us headlines

**1. No win claimed inside 3 percentage points.**

Published research on infrastructure noise in agent evaluation found that the gap
between most- and least-resourced container configurations was **6 percentage
points (p < 0.01)** — larger than the gap between top leaderboard models. Naive
binomial confidence intervals already span 1–2 points, and infrastructure
confounders stack on top of that rather than within it. The authors' own
recommendation is that differences below 3 points deserve skepticism until the
evaluation configuration is documented and matched.

So a 2-point lead is not a win, and we will say so even when the 2 points are ours.

**2. No aggregator citations, ever.**

During research for this project, a cluster of SEO-driven leaderboard aggregators
was found publishing mutually contradictory scores with fabricated precision —
three of them simultaneously claiming 96%, 96.4%, and 97.0% on the same benchmark
for the same model, while the official leaderboard topped out at **79.20%**. A
~17-point gap between primary and secondary sources.

Acceptable sources: **first-party harnesses and leaderboards**, and **named
independent evaluators with published methodology**. Nothing else. One citation to
a polluted aggregator discredits an otherwise sound report.

---

## What we target, and why not SWE-bench Verified

SWE-bench Verified is reported by us **only with its caveat attached**, because
refusing to report it looks evasive while reporting it uncritically looks naive.

The caveat: OpenAI stopped reporting it on 2026-02-23 after finding that at least
59.4% of hard instances have broken tests and that every frontier model tested
could reproduce the gold patch verbatim. Anthropic's most recent flagship launch
reports zero SWE-bench numbers. Cursor has never published one.

### Primary targets

| Board | Why | Bar |
| --- | --- | --- |
| **SWE-rebench** | Time-windowed and freshly mined, so contamination-controlled by construction. **The only public leaderboard where Cursor is a listed agent.** | Cursor 51.7% at $0.41/problem; Claude Code 60.4%; Junie 61.8% |
| **Terminal-Bench** | Trajectory-verified, reward-hacking-judged, semantically versioned, funded by multiple frontier labs | **No Cursor, OpenHands, SWE-agent, Devin, or Amp entry.** An open agent placing here is a real result. |
| **DeepSWE** | Independent, cost-transparent, best isolation design in the field | Open-weight models are at near-parity with frontier at a fraction of the cost |
| **Harbor-Index** | 82 tasks distilled from 6,627 across 54 benchmarks | No agent clears 30% |

### The framing that matters

Cursor sits behind Claude Code, Codex, and Junie on capability while costing a
fraction as much. **It is competing on cost, not capability.** So the honest
target is the joint accuracy-and-cost curve, and `solves per million completion
tokens` is a headline metric rather than a footnote.

---

## Tiers

### Tier 1 — every pull request · <10 min · <$5

| Eval | Size | Purpose |
| --- | --- | --- |
| `apply-bench` | 54 hand-written edits (`pnpm bench:list` prints the count) | Highest-frequency regression class. Deterministic, near-free. |
| Aider Polyglot subset | 40 of 225 | Cheapest edit-format signal. Reports `% well formed` **and** pass rate. |
| SWE-bench smoke slice | fixed 25 | **Wiring check. This number is never published.** |
| **Leakage assertions** | — | See below. Build failures, not warnings. |

Runs on a cheap model so the gate stays affordable.

### Tier 2 — nightly · <4 h · <$300

SWE-rebench current window (~111), DeepSWE (113), Harbor-Index (82),
Terminal-Bench stratified subset (~20), repository-QA for retrieval quality.

≥3 attempts per task. **The SWE-rebench window rotates monthly and we plot our
score across windows — a flat line across windows is our contamination proof.**

### Tier 3 — pre-release · days · $5k–20k

Full Terminal-Bench with official submission; full SWE-rebench and DeepSWE at 5
seeds; Code Arena for human preference; our own novel suites; SWE-bench Verified
with caveat.

---

## Leakage assertions

Each one blocks a specific documented way that agent benchmarks get gamed,
including accidentally. They run in CI as **build failures** — not as warnings, and
not as a checklist item someone remembers.

Three of them are asserted today, as ordinary tests in `bench/harness`, which means
they run on every pull request across all three operating systems. The other three
are properties of a container and are unimplemented, because there is no container
code anywhere in `bench/`. The table says which is which, so a reader does not have
to infer it.

Three assertions, two functions — which is where the earlier miscount came from.
`checkPromptLeakage` covers both prompt rows, and `checkHistoryIsolation` covers the
history row.

| Assertion | Status | Blocks |
| --- | --- | --- |
| Gold-patch fields never reach the prompt | **Asserted** | Pre-solved localization, worth 10–20 points |
| Test patch absent from the agent payload | **Asserted** | Agent reading the tests it must pass |
| Future git history unreachable in the agent repository | **Asserted** | `git log` finding the upstream fix |
| Network egress blocked | Not implemented | Fetching the solution — a documented real incident |
| Grading only on the committed diff, in a fresh container | Not implemented | Monkey-patching the test framework, dropping tests, forcing early exit |
| Report names every task-defining test | Not implemented | Dropped tests appearing as passes |

The three asserted rows are covered by `checkPromptLeakage` and
`checkHistoryIsolation` in `bench/harness/src/leakage.ts`. The field guard is
**default-deny**: only `instance_id`, `repo`, `base_commit` and `problem_statement`
may reach an agent, so a dataset that adds a solution-bearing column is refused
rather than silently passed. Alongside it a content detector looks for verbatim gold
or test-patch lines inside the prompt text, which is a weaker check by construction —
it names the fields it knows to carry solutions and only finds verbatim overlap, so a
clean result is not proof of no leakage.

The history assertion requires that nothing outside the base commit's history be
reachable from any ref, rather than checking commit dates, because a leftover tag or
sibling branch carrying the fix is exactly as reachable as a descendant. A pass
proves the fix cannot be found by walking refs; it does not prove the object database
holds no unreachable future objects.

**What "Asserted" means here, and what it does not.** Both functions are asserted by
unit tests over fixtures: a SWE-bench-shaped record for the two payload rows, and
real git repositories built per test — both leaking and correctly prepared — for the
history row. A regression in either fails the build on all three operating systems.
What no benchmark run does is pass its own data through them. `runner.ts` does not
import `leakage.ts`, because the only committed suite has no dataset record, no
assembled payload and no prepared repository to pass, and calling them on absent data
would return clean on every run — enforcement in appearance and nothing in substance.
So these three rows are a guarantee about the checks and not yet a guarantee about a
run, and no report may imply otherwise. Every generated `audit.md` restates it per
run, so the gap is visible in the artifact rather than only here.

**It is blocked on input rather than on effort.** `checkPromptLeakage` begins to
apply with the first adapter that loads a task record and assembles a payload from it;
`checkHistoryIsolation` begins to apply with the first prepared agent repository.
Both arrive with Harbor and a dataset — M5.

The two-container design is what will make most of the remaining rows structural
rather than policed: the agent commits, and **only the diff crosses** into a clean
verifier. That design belongs to Harbor — [ADR-0011](../architecture/adr/0011-benchmark-harness.md)
rejects building our own harness — and it is not wired up yet. See M5 in
[the roadmap](../roadmap.md). The Tier-1 suite that does run, `apply-bench`, makes no
model calls, opens no network connection and starts no container, so the container
rows do not apply to it.

---

## What every published claim must include

Non-negotiable. This list is the difference between a claim and an advertisement.

1. **Full trajectories for every trial, passes and failures.** Publishing failures
   is the strongest available credibility signal.
2. **Container digests** (`sha256:…`) for agent, verifier, and task images.
3. **Resource floor *and* ceiling** per task, with the calibration multiplier and
   evidence that both fall within noise. Almost nobody does this.
4. **Pinned dated model snapshots**, effort/reasoning level, temperature (or an
   explicit statement that it is unset), max output tokens.
5. **Harness version tag and the exact invocation**, as SWE-rebench publishes for
   its listed agents.
6. **Seeds and attempt count**, reported as **mean ± SEM over ≥3 attempts.**
   Never max-over-N.
7. **Cost and tokens** split input / cached-input / output, **with cache hit
   rate** — cache economics move effective cost by more than 10×.
8. **Multiple run dates**, because pass rates measurably vary with time of day.
9. **A negative-results section**: regressions, infra error rate, timeout rate,
   malformed-edit rate.
10. **A leakage audit**, published, with the assertion tests.
11. **Our own broken-task audit** of the benchmark we are reporting on. Roughly a
    third of the "hardest" tasks in circulation are broken rather than hard.

---

## Our own benchmarks

The agent layer is well measured. The IDE layer is not measured at all.

| Suite | Measures | Status |
| --- | --- | --- |
| `apply-bench` | Apply success rate per model per tier | **Novel** |
| `nep-bench` | Next-edit prediction from real commit sequences | **Novel — no public NEP benchmark exists** |
| `index-bench` | Cold index, incremental latency, precision@k | **Novel** |
| `latency-bench` | Cold start, TTFT, idle RSS | Internal |

Published as standalone, independently runnable, permissively licensed
benchmarks — usable by competitors. Owning the evaluation for a layer is a
stronger position than a placement on someone else's board.

`nep-bench` is the sharpest of the three: it targets next-edit prediction, which
is the feature Cursor is most known for and has no public number on.

---

## Reporting format

Reports live in `bench/reports/<date>-<suite>/` with:

```
report.md            human-readable, caveats first
result.json          machine-readable, schema in bench/harness/src/report-schema.ts
config.json          harness version, invocation, model pins, resource band
trajectories/        every trial, pass and fail
audit.md             broken-task audit and leakage assertion output
```

`report.md` leads with limitations, not with the headline number. If the number is
bad, it gets published anyway — a benchmark policy that only produces favorable
results is a marketing document, and we would rather have the credibility.

That ordering is a property of the generator rather than of the author: the
limitations section is index 0 in `renderReportMarkdown`, and a test compares its
position against the first percentage in the output.

All five files are written on every run, `audit.md` included. For a suite whose cases
are hand-written and which starts no container, most of what an audit asks for does
not apply, so `audit.md` says which parts and why — an absent audit and one recording
a genuine exemption read identically unless the exemption is stated. It also carries
the part that is real: the case count, the refusal reasons the run exercised, which
validator levels actually ran and which did not, and the severe-failure count.
Applicability is derived from the report's own `inputSource`, so a report that is not
synthetic gets the two sections as obligations rather than inheriting a hand-written
suite's exemption.

### The gate a generated report passes through

`checkReportPolicy` runs inside `renderReportMarkdown`, so a report cannot be
rendered without it. It refuses a report whose headline disagrees with the case
results, one whose severe-failure list hides a case that applied when a refusal was
required, one marked non-deterministic while reporting fewer than three attempts,
one claiming model-derived inputs with no pinned model, and one that cannot cite its
own run because the harness version or invocation is missing. `adze-bench` exits 3
when any of those fire.

A violating run is still written out in full. Trajectories for every trial are
themselves required by this document, and destroying that evidence to hide a policy
failure would be the worse outcome — so the violation is printed into `report.md`
above every number instead, and the figure cannot be quoted from the artifact
without it.

Two rules here are **not** yet enforced by that gate: the three-point comparison
rule needs a published baseline to compare against, and the max-over-N detector
needs more than one attempt. A Tier-1 report has neither. Both are implemented and
tested, and calling them on absent data would look like enforcement while being
none.

The gate carries no leakage rule either, and that was a decision rather than an
omission. Requiring leakage-audit evidence whenever `inputSource` is not `synthetic`
would need a new field on a report shape that a Tier-2 report will not share, and
every other rule in the gate compares two things present in the same artifact — a
leakage field would carry a claim with nothing beside it to check the claim against,
which is the review-checklist the gate exists to replace. The reasoning is recorded in
`report-policy.ts`; the assertions' own status is in `leakage.ts` and in each
generated `audit.md`.
