# 0011 — Adopt Harbor; isolate evaluation in two containers

**Status:** Accepted
**Date:** 2026-08-29
**Deciders:** @AyanB123

## Context

Our stated goal is to beat Cursor on benchmarks. Researching what that actually
means produced two findings that change the target entirely.

### SWE-bench Verified is no longer a serious target

OpenAI stopped reporting it on **2026-02-23**, publishing an audit finding that of
138 hard instances, **at least 59.4% have broken tests** — 35.5% enforcing
unspecified implementation details, 18.8% checking unspecified functionality — and
that **every frontier model tested could reproduce the gold patch verbatim.** Then
on 2026-07-08 they retracted their own replacement recommendation after finding
~30% of SWE-bench Pro's public split broken.

Anthropic's Claude Opus 5 launch (2026-07-24) reports **zero** SWE-bench numbers.
Cursor has never published one. The official leaderboard's newest entry is dated
2026-02-26 and tops out at **79.20%**.

Meanwhile a cluster of SEO aggregators reports 96–97% on the same benchmark, with
three of them simultaneously claiming 96%, 96.4%, and 97.0% for the same model.
**A ~17-point gap between the primary source and confident-sounding secondary
ones.** One citation to those and an otherwise-sound report is discredited.

### The boards that do matter, and where Cursor actually sits

| Board | Why it matters | Cursor |
| --- | --- | --- |
| **SWE-rebench** | Time-windowed, freshly mined, contamination-controlled by construction. The **only public leaderboard where Cursor is a listed agent.** | **51.7% ±0.84, $0.41/problem** — behind Claude Code (60.4%), Codex (58.0%), and JetBrains Junie (61.8%), at a fraction of the cost |
| **Terminal-Bench** | Trajectory-verified, reward-hacking-judged, semantically versioned | **No entry.** Nor OpenHands, SWE-agent, Devin, or Amp. |
| **DeepSWE** | Independent, cost-transparent, best-designed isolation | No entry |
| **Harbor-Index** | 82 tasks distilled from 6,627 across 54 benchmarks; no agent clears 30% | No entry |

Cursor is competing on **cost**, not capability. That reframes the goal: the
winnable claim is on the joint accuracy-and-cost curve, not on raw solve rate.

### Infrastructure noise is larger than the gaps people claim

A published study found the gap between most- and least-resourced container setups
was **6 percentage points (p < 0.01)** — larger than the gap between top
leaderboard models. Infra error rate ranged 5.8% at strict enforcement to 0.5%
uncapped. Pass rates fluctuate with **time of day**. The authors' recommendation:
*differences below 3 percentage points deserve skepticism until the eval
configuration is documented and matched.*

### And a third of "hard" tasks are broken rather than hard

Harbor's own audit of the hardest available tasks found roughly one third broken.
Auditing the benchmark you report on is now table stakes.

## Decision

**Adopt Harbor. Copy DeepSWE's two-container isolation. Target SWE-rebench and
Terminal-Bench. Publish reproducibility artifacts that make the claim checkable.**

### Do not build a harness

Harbor is Apache-2.0, from the Terminal-Bench authors, is the official harness for
Terminal-Bench, evaluates arbitrary agents, exposes SWE-Bench and Aider Polyglot
as datasets, and parallelizes across several sandbox providers. Building our own
would cost months *and* make our numbers unverifiable, because a private harness
is indistinguishable from a tuned one.

We build **adapters**, not a harness. `bench/harness` wraps Harbor and adds our
reporting.

### Two-container isolation, non-negotiable

Copied from DeepSWE v1.1:

1. **Agent container** — repository at the start commit with **future git history
   deleted**, so the agent cannot `git log` its way to the upstream fix. Agent
   commits to a branch.
2. **Only the committed diff crosses** to a **fresh verifier container**, which
   applies it and runs tests, emitting a report naming **every task-defining
   test**.

This structurally eliminates monkey-patching the test framework, dropping tests,
and forcing early exit. Enforced by assertion tests in CI: **test-patch absence,
gold-patch-field absence, future-history absence, and network isolation are
build failures, not warnings.**

### Tiered evaluation

| Tier | When | Budget | Contents |
| --- | --- | --- | --- |
| **1 — gate** | every PR | <10 min, <$5 | `apply-bench`, 40-case Polyglot subset, 25-instance smoke slice, **harness leakage assertions** |
| **2 — nightly** | nightly | <4 h, <$300 | SWE-rebench current window, DeepSWE, Harbor-Index, Terminal-Bench subset |
| **3 — release** | pre-release | days, $5k–20k | Full Terminal-Bench with official submission, full SWE-rebench and DeepSWE at 5 seeds, Code Arena |

The Tier-1 smoke slice is a **wiring check and its number is never published.**

### Our own benchmarks, because the IDE layer has none

| Suite | Measures | Status |
| --- | --- | --- |
| `apply-bench` | Apply success rate per model per tier | **Novel.** Nobody publishes this. |
| `nep-bench` | Next-edit prediction from real commit sequences | **Novel.** No public benchmark exists, and it targets the feature Cursor is best known for. |
| `index-bench` | Cold index time, incremental latency, retrieval precision@k | **Novel.** |
| `latency-bench` | Cold start, TTFT, idle RSS | Internal |

### Publication requirements

Every claim ships with: full trajectories for **every trial including failures**;
container digests; **resource floor *and* ceiling** per task with calibration
evidence; pinned dated model snapshots with effort level and temperature; harness
version tag and exact invocation; seeds and attempt count with **mean ± SEM over
≥3 attempts, never max-over-N**; cost and tokens split input/cached/output with
cache hit rate; multiple run dates; a negative-results section; a leakage audit;
and **our own broken-task audit of the benchmark itself.**

### Two rules that cost us headlines

1. **No win claimed inside 3 percentage points.** Below the documented noise floor.
2. **No aggregator citations, ever.** First-party harnesses and named independent
   evaluators with published methodology only.

Both are in this ADR rather than a style guide because they must be non-negotiable
by a maintainer who wants a launch.

## Alternatives considered

**Build our own harness** — rejected. Months of work and unverifiable results.

**Target SWE-bench Verified as the headline** — rejected. Contaminated,
abandoned by the labs, and claiming it signals being behind on evaluation. We
report it *with* the caveat, because refusing looks evasive and reporting it
uncritically looks naive.

**Report only our own benchmarks** — rejected. Self-designed benchmarks are
worthless as competitive evidence. Ours supplement public boards.

**Best-of-N for headline numbers** — rejected. Tolerated on leaderboards but
visibly labelled and discounted, and it multiplies the cost axis we intend to win.

**Skip evaluation until the product is mature** — rejected. Evaluation is how we
find out whether the architecture works. Tier 1 runs from the first PR.

## Consequences

**Good.** Credible, checkable claims. Harbor gives cross-provider parallelism for
free. Two-container isolation makes our numbers auditable by construction. Three
novel IDE-layer benchmarks are a genuine contribution regardless of how we score.

**Bad.** Tier 3 costs $5k–20k per release. Harbor is a dependency we do not
control. Publishing failures and refusal rates is worse marketing than not.

**Costs we accept.** **We will lose comparisons we could have won by citing looser
numbers.** And we commit to publishing results that make us look bad, because a
benchmark policy that only produces favorable results is a marketing document.

## Revisit when

- Harbor's stewardship changes or it stops being the official harness.
- SWE-rebench stops publishing Cursor, removing our best direct comparison.
- A genuinely contamination-resistant successor to SWE-bench gets real adoption.
