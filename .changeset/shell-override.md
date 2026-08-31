---
'@adze/core': patch
'@adze/cli': patch
---

Add `ADZE_SHELL` and `ADZE_SHELL_FLAG` so the shell the `bash` tool uses can be
pointed somewhere other than whatever `bash` resolves to on `PATH`.

`adze doctor` already detected the common Windows failure — `bash` on `PATH` being
WSL's launcher, which exists whether or not a healthy distribution sits behind it and
fails every command when one does not — and recommended Git for Windows' bash. That
advice was unactionable, because nothing let you select a shell. `doctor` now probes
the shell the agent will actually use and says whether it came from the override or
from `PATH`, so the diagnostic blames the right thing.

`EngineOptions.bash` is exposed on `@adze/core` for surfaces that need to set the
prefix directly.
