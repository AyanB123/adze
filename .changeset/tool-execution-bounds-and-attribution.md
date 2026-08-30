---
'@adze/core': patch
---

Make a tool call answer to the turn's budget, and say which thing actually failed.

Three defects found by driving `adze run` against a real model for the first time. Each
was a capability that existed and was never connected to the path that needed it, which
is why unit tests passed throughout.

**`--max-time` did not bound a tool call.** `TurnBudget.maxWallClockMs` was consulted only
between steps, so a single long call ran to the unrelated per-tool ceiling and overshot the
turn budget by however long that took. Measured: `--max-time 15` against
`bash -lc "sleep 90"` produced a 94-second turn. `BudgetTracker.remainingWallClockMs()`
had been written for exactly this and was never called from anywhere. The tool timeout is
now the smaller of the configured per-tool ceiling and what the turn has left; a turn with
no wall-clock budget is untouched, so this cannot become a ceiling nobody asked for.

**A killed command did not end the call.** `exec` settled on the child's `close` event,
which does not fire until every stdio pipe has drained — and descendants inherit those
pipes. A descendant outliving the kill therefore held the call open: a killed
`bash -lc "sleep 12"` fires `exit` at 1.5 s and `close` at 12.5 s. So the timeout bounded
nothing for any command that spawns a child, which is every `bash -lc` running a real
program. A killed process now settles on `exit`, reporting whatever output arrived before
the kill, and its inherited pipes are released so libuv does not keep the event loop — and
therefore the process — alive until the descendant finishes. A command that ends on its own
still settles on `close`, which is what guarantees the last bytes were collected.

Descendants are still **not** killed with their parent, on any platform, and the class
comment now says so rather than letting "the command was killed" imply otherwise. Killing a
tree needs a process group on POSIX and a `taskkill /T` equivalent on Windows;
`@adze/sandbox` already implements that, and reaching it is a matter of wiring a contained
broker into the surfaces rather than adding an untested platform branch to core.

**A missing working directory was reported as a missing program.** Node reports both as
`ENOENT` with `error.path` set to the *program*, so the message read
`could not run 'bash': spawn bash ENOENT` for a bash that was installed and on `PATH`.
Observed cost: the model believed the shell was unavailable and spent a dozen steps
avoiding a shell that worked. These messages are written for a model to retry against, so
the directory is now checked before the blame is assigned; a genuinely missing executable
still names the executable.
