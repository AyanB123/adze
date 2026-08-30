---
name: regression-case
description: Turn an edit-application failure into a permanent test case in both places it belongs
tools: [read, grep, glob, symbols, edit, write]
model: { prefer: reasoning }
---

Turn the failure I describe into a permanent regression case.

`CONTRIBUTING.md` names this the highest-leverage contribution in the repository, and sets
the bar for adding one deliberately low. If a model produced an edit that broke a file or was
wrongly refused, that is a bug report *and* a test case, and the case is the half that keeps
paying.

## What I need from you first

If any of these is missing from what I gave you, ask for it rather than inventing it. A
regression case built on a reconstructed input tests a situation that never happened.

- The **exact** file content before the edit. Whitespace and indentation included — those are
  frequently the cause.
- The **exact** search and replace blocks the model produced.
- What happened: a corrupted file, a wrong refusal, an ambiguous match taken silently, a
  validation pass that should have failed.
- What should have happened.

## Then write it in both places

**1. `packages/apply/test/`** — the unit reproduction, in the style of the tests already
there. If this is a bug fix, the test must fail before the fix and you must run it and show
me that it does.

**2. `bench/suites/apply-bench/cases/`** — the same situation as a bench case, so it protects
every model this project ever supports rather than only the one that produced it.

## Assert on the telemetry, not only on `ok`

Check `tier`, `strategy`, and `validation` as well as the outcome. Those three fields are what
make "apply success rate per model per tier" a publishable number, and a test asserting only
`ok` keeps passing while the telemetry rots underneath it.

Be specific about what the correct outcome is, because the failure classes have different
correct answers:

- An **ambiguous** match must return `ambiguous` **with every match location**, not the first
  match. Taking the first one is the worst available behaviour: the corruption it produces is
  invisible and unreproducible.
- A **refusal** is a good outcome and is reported as one. If the case is a wrong refusal, say
  which tier should have applied it and why.
- `ValidationResult.validator` must name the level that actually ran — `tree-sitter` for a
  real parse, `structural` for the balance checker, `none` for an unknown language. Never
  widen `structural` to `tree-sitter`: the field is a claim about evidence and benchmark
  reports depend on it.
- An **indentation-tolerant** match must re-indent the replacement to the indentation
  actually found. Correct location at the wrong nesting level parses in a braces language and
  silently breaks Python, which is worse than a refusal.

## What not to do

Do not propose a new matching strategy to make the case pass. The ladder is exact →
whitespace-normalized → indentation-tolerant → anchored, and it stops there. No Levenshtein,
no trigram, no token similarity: a near-miss on source code is a different program. If the
case only passes with fuzzy matching, the correct behaviour is a refusal with a message that
tells the model what to change.
