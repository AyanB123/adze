---
'@adze/cli': minor
---

Persist `adze chat` sessions to `.adze/sessions/<id>.jsonl` and resume them across invocations.

`adze chat` kept one session per process, so history died with the process and the frozen
cache prefix was never reused across invocations. Every turn is now appended to
`.adze/sessions/<id>.jsonl` (line 0 a header with the settings in force, then one
linear-history message per line), and `adze chat --resume <id>` (or `--resume last` /
`--last`) continues a session with the same prefix. `adze sessions list` shows what
exists; deleting a file forgets the session. `/clear` starts a new persisted session,
`/compact` summarizes history through the existing `Session.compact` seam while recording
the named `compaction` epoch-roll reason, and `/fork [turn]` branches a turn prefix into
a new persisted session — all CLI-side composition over the same protocol methods, no new
engine path.

Chat slash commands grow to `/usage`, `/model`, `/clear`, `/compact`, `/fork`, `/init`
(scaffolds `.adze/config.jsonc` and `AGENTS.md` when missing, never overwrites),
`/review-diff` (read-only git summary, no writes), `/plugins`, `/doctor`, `/help`,
`/exit`; an unknown slash prints help. There is still no `/config`: a mid-session setting
the prompt does not reflect would be a security display disagreeing with reality.

`adze run` writes its full event trajectory to `.adze/sessions/<id>.trajectory.jsonl`
by default (`--no-trajectory` opts out), with the path in the summary and the
dropped-event count beside it.
