---
'@adze/cli': patch
---

Keep `run --json` a valid JSONL stream through the summary.

`run --json` streams one event per line, and the run summary went onto that same stdout
stream through the indented writer — so the last document of every JSON run arrived as
about twenty lines that no line-oriented reader can parse. Measured on a real run: 20 of 31
stdout lines were unparseable, and the twenty broke at exactly the point a consumer would
read the result.

The contract was already stated twice — `agent/render.ts` says "one event per line,
verbatim, so a script can consume the same stream the engine produced", and
`agent/approval.ts` says "stdout carries the JSONL event stream and nothing else" — and was
enforced nowhere. The renderer was tested in isolation and the summary was never on the same
stream in any test, which is how a documented format went unchecked.

`writeJsonLine` is now the writer for a stream where every line is a document, and `run`
uses it for the summary. `writeJson` keeps its indented form for the commands that emit one
document and exit — `doctor`, `models`, `apply`, `validate` — where there is no second
document for it to run into. Both shapes are asserted, so swapping one back for the other
fails a test instead of silently breaking consumers.

The summary's fields are unchanged; only its framing is. A consumer that parsed the whole of
stdout as one document was already broken by the event stream preceding it.
