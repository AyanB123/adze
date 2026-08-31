---
'@adze/core': patch
---

Canonicalize permission-gate roots as well as the candidate path. A workspace root
spelled with an alias the OS resolves away — an 8.3 short path such as
`C:\Users\NAME~1\...` on Windows, or `/tmp` and `/var` on macOS — was never
comparable to the canonicalized candidate, so every path inside the workspace was
reported as outside it. The gate failed closed, denying legitimate access rather
than permitting forbidden access, but it made an agent run against any temp
directory impossible.
