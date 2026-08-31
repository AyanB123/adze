---
'@adze/core': patch
---

Command-prefix rules now match the command the model asked to run rather than the
argv Adze executes. Because the `bash` tool wraps every command as
`bash -lc <command>`, rules were compared against a string beginning `bash -lc`:
`--forbid "rm "` could not refuse `rm -rf /`, and `--allow "npm test"` never fired.

This is a behaviour change. `--allow "bash -lc"` previously matched every shell
command and now matches nothing — it was never a permission anyone meant to grant,
only the accidental way to make matching work at all. See ADR-0013.
