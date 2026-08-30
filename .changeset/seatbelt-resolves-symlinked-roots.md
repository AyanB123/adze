---
'@adze/sandbox': patch
---

Resolve symlinked writable roots before building the Seatbelt profile, so
`workspace-write` no longer denies writes inside a declared writable root on macOS.
Because macOS ships `/var` and `/tmp` as symlinks into `/private`, and
`os.tmpdir()` returns a path under `/var/folders`, the generated rule named a path
the kernel never resolves to and the default deny applied instead.
