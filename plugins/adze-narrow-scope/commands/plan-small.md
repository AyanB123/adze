---
name: plan-small
description: Break the task I describe into narrow phases with one concern per commit
tools: [read, grep, glob]
model: { prefer: reasoning }
---

Break the task I describe into narrow phases, before any code is written. Do not write
code in this command: the output is a plan whose phases become commits.

First, read only far enough to know where the work belongs. Do not read the
implementation in full: reading it first biases the plan toward the code that exists,
and a plan shaped like the current code tends to preserve the bug it was meant to fix.

Then write the phases as a numbered list, each one small enough to review in one
sitting and narrow enough to revert on its own:

1. **What changes**, in one sentence, with the paths it touches.
2. **What it does not change**, explicitly. A phase that does not name its boundary
   will absorb the neighbour's work.
3. **How it is verified** — the narrowest test or check that answers whether this
   phase is sound. Name the exact command, scoped to the package, never a
   repository-wide target.
4. **What the commit message will be**, as a Conventional Commit subject in the
   imperative, lowercase, no trailing period.

Rules:

- One concern per phase. A behaviour change and a refactor are two phases, never one:
  bundled, neither can be reviewed, and if the result is wrong nobody can tell which
  half did it.
- Prefer several narrowly scoped commits over one large one. If a phase cannot be
  described in one sentence, split it.
- If a phase reverses an earlier architecture decision, say so: a reversal needs its
  own ADR superseding the old one, and the old one is kept.
- End with what is deliberately left out, and why. A plan that claims everything is a
  plan that hides the tradeoff.
