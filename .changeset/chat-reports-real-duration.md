---
'@adze/cli': patch
---

Report the real session duration in `adze chat`.

The chat session summary passed `durationMs: 0` as a literal, so every session reported
`wall clock 0.0s` however long it had run. The number was never a measurement — it was a
placeholder that reads as one, which is the failure mode the engine's own budget comments
warn about: a reported quantity that nobody computed is worse than an absent one, because
it gets quoted.

The clock is now read either side of the session, threaded through the same test hook
`run` already uses, so the two commands measure the same thing and render it through the
same summary code. Verified against a live model: a session that previously printed
`0.0s` now prints `1.0s`.
