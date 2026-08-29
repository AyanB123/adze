---
'@adze/cli': minor
---

Wire `adze run`, `adze chat`, and `adze models`.

`adze run "<prompt>"` drives one task to completion non-interactively, streaming the
engine's event stream as plain text or as JSONL under `--json`, and printing the token
split, cost, and cache hit rate on completion. `adze chat` is the interactive form — one
session across every prompt, so the conversation accumulates and the cached prefix stays
reusable. `adze models` reports the configured providers and what the price table knows,
making no network call.

Both agent commands accept `--model`, `--effort`, `--temperature`,
`--max-output-tokens`, `--sandbox`, `--approval`, `--allow`, `--forbid`, `--max-steps`,
`--max-tokens`, `--max-time`, `--max-spend`, `--cwd`, `--instructions`, and `--quiet`.
Every flag refuses an invalid value rather than falling back to a default, because a typo
in `--sandbox` silently becoming `workspace-write` would grant more than was asked for.

`--approval never` refuses rather than escalating: an action needing approval is denied,
never prompted for. An unpriced model reports its cost as `unknown`, never as `$0.00`.
