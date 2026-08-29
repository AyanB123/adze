# 0003 — Minimal linear turn machine, not elaborate scaffolding

**Status:** Accepted
**Date:** 2026-08-29
**Deciders:** @AyanB123

## Context

There is a strong intuition that a cleverer agent loop — tree search over edit
trajectories, multi-stage localize/repair/validate pipelines, planner/executor
splits, reflection layers — is where an agent product wins. Between 2024 and 2026
that intuition was tested repeatedly, and the results went the other way.

**The evidence, in order of how much it should move you:**

*A controlled harness swap, model held constant.* Six open-weight models
evaluated on the same task set under two different harnesses produced aggregate
score differences that were **not statistically significant** (all p > 0.05).
What changed dramatically was *which* tasks were solved: solve-set overlap across
a harness swap fell to 42% for strong models and 7% for weak ones. Harness choice
redistributes outcomes far more than it improves them.

*Token efficiency differed by ~55% between those harnesses* for statistically
identical scores — 1.89 versus 1.22 solves per million completion tokens, with
one harness using roughly double the tool calls, wall-clock, and output tokens to
reach the same place.

*The minimal reference harness wins.* A roughly 100-line agent — bash-only,
strictly linear message history, one `subprocess.run` per action, no stateful
shell — scores above 74% on SWE-bench Verified and is now the neutral harness for
the official leaderboard, for independent evaluators, and for at least one
frontier lab's own launch benchmarks. Its maintainers identify the stateless
subprocess model as the single largest stability win.

*Scaffolding's real headroom.* Independent analysis puts scaffold choice at 11–15
points for recent top models — but measured against a *weak* baseline. Against a
good baseline the delta collapses. Meanwhile the highest-scoring open scaffold
gets there through runtime self-evolution, not through a hand-designed pipeline.

*The one measurement that does justify complexity:* a single round of test
feedback moved pass rate from 52.0% to 88.0% on a public edit-format benchmark.
**+36 points from letting the agent see its tests fail and try again.**

The conclusion is uncomfortable but clear: elaborate control flow is close to free
of benefit, while the *execute-observe-retry* loop is worth more than everything
else combined.

## Decision

**Keep the turn machine boring. Spend the complexity budget on reliability, cost,
and safety instead.**

The loop:

```
submit(prompt)
  → fire session.turnStart hooks
  → assemble context for the current cache epoch
  → loop until stop | budget exhausted | max steps:
      stream model response (native tool calling)
      for each tool call:
        fire tool.pre hooks       (may deny or rewrite args)
        authorize via permission gate
        execute in sandbox        (stateless: one subprocess per call)
        truncate + structure result
        fire tool.post hooks
      append to a strictly linear history
  → fire session.turnEnd hooks
  → report usage, cost, cache hit rate
```

Specific commitments:

1. **Strictly linear history.** The trajectory *is* the prompt. No hidden state,
   no side channels. This makes runs debuggable, replayable, and directly usable
   as fine-tuning or RL data.
2. **Stateless tool execution.** One subprocess per call. No persistent shell
   session to drift, hang, or leak state between calls.
3. **Test feedback is a first-class loop**, because it is the one intervention
   with a large measured effect. Failing output returns to the model structured,
   not as a wall of stdout.
4. **No tree search, no planner/executor split, no reflection layer** in the core
   loop. If someone wants them, they are a subagent or a plugin — not core.
5. **Budgets are explicit**: max steps, max tokens, max wall-clock, max spend.
   Every one is enforced and reported.
6. **`pass@1` is the metric.** Best-of-N is a separate, labelled mode, never the
   default and never a headline number.

## Alternatives considered

### CodeAct — actions as executable code — rejected for core

Elegant and expressive: instead of JSON tool calls, the model writes Python that
runs. But it requires a Python runtime inside the sandbox, and it makes the
permission gate much harder — authorizing arbitrary code is a different and worse
problem than authorizing a named call with typed arguments. Available as a plugin.

### Agentless — fixed localize → repair → validate pipeline — rejected

Proved that agentic freedom was not required for 2024-era scores, which was a
genuinely useful result. But it peaked around 50% and the ceiling is structural:
a fixed pipeline cannot recover from a localization miss. Its real contribution —
that localization is separable — we absorb as the `symbols` tool.

### Tree search over trajectories — rejected

Real gains at its peak, but multiplies cost by the branching factor and is
regarded on leaderboards as a different category from `pass@1`. Cost per task is
an axis we intend to *win*, so multiplying it to buy points is directly
counterproductive.

### Purpose-built agent-computer interface with many bespoke tools — rejected

The thesis was that models need carefully designed tools with linting, windowed
viewers, scoped search. Its own authors superseded it with the minimal bash-only
harness. That is about as strong a refutation as this field produces.

### Runtime self-evolution — deferred, watching closely

Currently the highest-scoring open scaffold. Genuinely interesting, and it may be
where this goes. But it is hard to make reproducible or safe, and both matter more
to us than a leaderboard position right now. Revisit after 1.0.

## Consequences

### Good

- Small, comprehensible core. A new contributor can read the loop in one sitting.
- Trajectories are replayable and diffable, which makes regressions provable.
- Works with any model that supports native tool calling, including cheap
  open-weight ones.
- Complexity budget goes to the applier, the gate, and the context assembler,
  which is where measured wins actually are.

### Bad

- We will lose to search-based scaffolds on raw `pass@1`, and should expect to.
- "Boring loop" is a harder marketing story than "novel agent architecture".
- Some hard tasks genuinely need backtracking that we will not do in core.

### Costs we accept

- **Leaderboard position on absolute solve rate.** We compete on the joint
  accuracy-and-cost curve and say so plainly.
- **Rejecting features that demo well.** A planner/executor split is impressive
  in a screenshot and does not survive controlled measurement.

## Revisit when

- A controlled experiment — same model, same tasks, harness varied — shows a
  scaffold change beating our baseline by more than 3 percentage points. That is
  the noise floor from [ADR-0011](0011-benchmark-harness.md), and 3 points is the
  bar for reopening this.
- Self-evolving scaffolds become reproducible and sandbox-safe.
