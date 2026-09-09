# M1 live run — committed trajectory (OpenRouter free endpoint)

Model `nex-agi/nex-n2.5-pro:free` via OpenRouter (`https://openrouter.ai/api/v1`), 2026-09-09. Refs plan P2.6.

## Limitations — read before quoting anything below

- **This is evidence the assembled path works, not a measurement of how often it works.** Three tasks, one model, one platform, one attempt each. No pass rate is claimed: the policy requires mean ± SEM over ≥3 attempts for a stochastic claim, and a single attempt per task cannot produce one. Do not cite 3/3 as a rate.
- **No comparison is made, so the 3-point rule has nothing to bite on.** There is no baseline and no rival number in this report.
- **Single date, host-run, unseeded.** One run date (the policy asks for multiple for published rates), no container digests (no container exists yet — roadmap M5), no resource floor or ceiling, and no seed (the CLI exposes no seed flag). Durations are orientation only.
- **Cost is reported as unknown, which is honest for an unpriced model.** The run used OpenRouter's free tier; the summary reports `cost: null`. That reads as free only if you ignore the field: an unpriced model reporting `$0.00` would be a false claim, and the CLI reports `unknown` for exactly that reason.
- **Temperature unset.** No `--temperature` was passed, so the provider default applies. Stated because the policy requires temperature (or an explicit unset statement) beside every model pin.
- **The read-only summary (run 02a) was not checked for factual accuracy.** Its trajectory is published so a reader can check it; this report asserts only that it completed without edits, not that every claim in it is correct.
- **The doc fix (run 02b) was operator-reviewed, not test-verified.** Markdown has no validator (`validator: 'none'`, honestly reported), and the agent could not run lint or tests itself: under `--approval never` on Windows without OS-level containment, `bash` is denied by the permission gate. The diff was reviewed by the operator before commit.

## Results

| Run | Task | Exit | Stop reason | Steps | Wall clock | Total tokens |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | Scratch: fix the failing test | 0 | `end-turn` | 5 | 48.8 s | 21,057 |
| 02a | Own repo, read-only: summarise `packages/retrieval` | 0 | `end-turn` | 5 | 285.2 s | 196,729 |
| 02b | Own repo: one small doc fix | 0 | `end-turn` | 4 | 89.5 s | 201,255 |

Usage split (input full-rate / cached-input / output, with hit rate) and cost:

| Run | Input | Cached input | Output (of which reasoning) | Cache hit rate | Cost |
| --- | --- | --- | --- | --- | --- |
| 01 | 11,606 | 7,744 | 1,707 (1,092) | 40.0% | unknown |
| 02a | 85,992 | 104,768 | 5,969 (3,974) | 54.9% | unknown |
| 02b | 99,737 | 98,944 | 2,574 (1,071) | 49.8% | unknown |
| **Total** | 197,335 | 211,456 | 10,250 (6,137) | — | unknown |

Two things worth recording, because they reproduce the original M1 run's first evidence outside a test:

- **The permission gate refused commands and the agent adapted.** Run 01 was denied `bash` twice (main turn and subagent) under `--approval never` with no OS-level containment on Windows, and completed using `glob`, `read` and `edit` instead. It then reported honestly that it could not run `npm test` rather than claiming a result; the operator verified 2/2 passing externally.
- **The applier applied first-try on both edits.** Run 01: tier `search-replace`, strategy `exact`, validator `structural`. Run 02b: same tier and strategy, validator `none` with the applier's own note that Markdown has no validator. One tier attempted in each case.

## Negative results

- Infra errors: 0. Timeouts: 0.
- Malformed edits: 0. Edit refusals (good or bad): 0 — neither run exercised a refusal path, so this report is not evidence about refusal behavior either way.
- Tool denials (the gate working, not failures): 2, both `bash` in run 01, both with the reason that `workspace-write` has no OS-level containment on this platform and `never` refuses rather than escalating.
- Severe failures (applied when a refusal was required): none observed, but with zero refusal-exercising cases that sentence carries no information and is stated here so it is not mistaken for a tested claim.

## Reproduction

Exact invocations are in `config.json` (key value redacted as `<redacted>`; the key itself never touched disk — see `audit.md`). Model pin: `openai-compatible/nex-agi/nex-n2.5-pro:free`, base URL `https://openrouter.ai/api/v1`, temperature unset, `--approval never`, `--max-steps 25 / 25 / 15`, sandbox `workspace-write / read-only / workspace-write`. Harness `adze-cli 0.0.1`, Node v25.5.0, win32 x64. Per-run prompts, usage, tool counts and trajectories (`trajectories/`, every trial) are in `result.json` and beside this file. The scratch fixture (before/after/test/diff) is under `trajectories/fixture/`.
