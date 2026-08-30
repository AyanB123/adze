---
'@adze/sandbox': patch
---

Handle the `child.stdin` stream error when running a contained command. A command
that exited before draining its input raised `EPIPE` as an uncaught exception,
terminating the host process instead of failing the single command. `head -1` and
similar tools do this by design, so the crash was reachable from ordinary tool use.
