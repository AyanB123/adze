# m1-openrouter — audit

Required beside every report by `docs/benchmarks/strategy.md`: the broken-task audit and the leakage assertion output. Refs plan P2.6.

## Broken-task audit — not applicable (no borrowed task set)

The policy requires our own broken-task audit of the benchmark being reported on because roughly a third of the hardest tasks in circulation are broken rather than hard. That rule is about **borrowed** task sets: an upstream dataset whose tests do not check what its task description claims.

This report borrows nothing:

- Run 01's fixture (`parse.mjs` + `parse.test.mjs`) is hand-written for this report and committed under `trajectories/fixture/` with its before/after/diff. It was verified broken-before (1 pass / 1 fail) and passing-after (2/2) by running `node --test` outside the agent.
- Runs 02a/02b use operator-written prompts against this repository, with no hidden tests and no gold patch.

There is no upstream author to disagree with and no gold patch to verify, so there is no third-party task set to audit. A fixture that asserted the wrong thing would be a bug here, fixed by editing the fixture, not a dataset defect to measure.

## Leakage assertions — none applicable (no dataset, payload, or prepared repository)

Six assertions are named in `docs/benchmarks/strategy.md`. These were live manual runs, not benchmark-suite runs, so none of them has an input to check — and the table states the reason per row rather than leaving the file empty:

| Assertion | This report | Why |
| --- | --- | --- |
| Gold-patch fields never reach the prompt | Not applicable — no such input | No dataset record exists; prompts are the operator-written strings in `result.json`, quoted in full |
| Test patch absent from the agent payload | Not applicable — no such input | Run 01's test file predates the run and lives in the scratch repo the agent was asked to fix — that is the task, not a leak; runs 02a/02b have no tests |
| Future git history unreachable in the agent repository | Not applicable — no such input | Scratch repo has one commit (the broken fixture); the own-repo runs sat at the operator's checkout with no prepared base commit and no fix commit to find |
| Network egress blocked | Not applicable — unimplemented | No container is started; the agent legitimately calls the model endpoint over the network |
| Grading only on the committed diff, in a fresh container | Not applicable — unimplemented | No container is started; grading is the operator running `node --test` and reviewing `git diff` by hand, stated in `report.md` |
| Report names every task-defining test | Satisfied by construction | The only task-defining test file (`trajectories/fixture/parse.test.mjs`) is committed beside the report |

**The three implemented checks.** `checkPromptLeakage` and `checkHistoryIsolation` in `bench/harness/src/leakage.ts` cover the first three rows and are exercised by unit tests over fixtures. No live run passes its data through them — the runner has no dataset record, payload, or prepared repository to pass, and calling them on absent data would return clean every time, which would read as enforcement while checking nothing. They begin to apply with the first Harbor adapter that prepares a task from a dataset. **The other three** are unimplemented properties of a container that does not exist yet.

## Secret handling — verified

The OpenRouter key was passed ONLY via inline `$env:ADZE_COMPATIBLE_API_KEY='...'` in the invoking PowerShell commands and removed with `Remove-Item Env:ADZE_COMPATIBLE_API_KEY` in the same commands. It was never written to a file, never printed, and never committed:

- `Select-String` for the key prefix over every staged trajectory, fixture, `config.json`, `result.json`, `report.md`, and this file: **0 matches** (checked before commit; re-check with `git diff` / `git status`, which show only the files listed in the report commit).
- `config.json` records the invocations verbatim except the key value, replaced with `<redacted>` and labelled as such.

## What this report does establish

| Field | Value |
| --- | --- |
| Runs finished / infra errors / timeouts | 3 / 0 / 0 |
| Malformed edits | 0 |
| Edit refusals exercised | 0 (no evidence either way) |
| Tool denials (`bash`, gate, `approval never`) | 2, both in run 01 |
| Validator levels that actually ran | `structural` (run 01 edit), `none` (run 02b, Markdown — honestly reported) |
| `tree-sitter` observed | No — this report is not evidence about it either way |
| Cost | unknown (unpriced free-tier model), not $0.00 |
