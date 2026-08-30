---
'@adze/cli': minor
---

Wire retrieval into the agent loop, report model providers in `adze doctor`, and fix two
defects found by driving `adze run` against a real local model endpoint.

`glob`, `grep`, and `symbols` now work. `@adze/core` declares the retrieval seam and ships
no implementation, `@adze/retrieval` implements it, and nothing joined them — so all three
tools reported themselves unavailable and the agent's only way to find code was `bash grep`,
which costs an approval per search and returns raw stdout instead of ranked hits. The
adapter reports the **weakest** extractor that contributed to a result rather than the best,
so a heuristic answer is never widened into a claimed parse, and a missing ripgrep fails the
call rather than returning zero matches, because "ripgrep is missing" must not reach a model
looking like "the symbol does not exist".

`adze doctor` reports model providers, and whether the shell actually runs. Providers were
absent entirely, so a machine with no credential passed `doctor` cleanly and then failed on
its first `adze run`; they are reported as configured and never probed, because no outbound
call is made, and only the name of the variable that supplied a credential is printed. The
new `shell` check executes `bash -lc "exit 0"` rather than looking `bash` up, because on
Windows `bash.exe` is usually WSL's launcher and exists whether or not a working
distribution sits behind it — a broken one fails every command, which the model cannot
distinguish from a failing test suite. Both are warnings that still exit 0.

`adze models` no longer hides a keyless endpoint. A provider with no API key was treated as
unconfigured and skipped, but an `openai-compatible` endpoint — a local llama.cpp or Ollama
server — legitimately needs none, so the model named by `defaultModel` was missing from the
list while `adze run` was about to use it. Usable and credentialed are now reported as the
separate facts they are.

The approval prompt moved to stderr, and every queued answer is now used. Under `--json`
stdout carries the event stream and nothing else, and the prompt was landing inside the
`tool.started` event the approval was gating, making that line unparseable. Separately, the
reader used a one-shot readline listener while readline emits every line in a chunk at once,
so a piped run granted its first approval and silently denied the rest with their answers
still in the buffer — a denial indistinguishable in the trajectory from one the user typed.
