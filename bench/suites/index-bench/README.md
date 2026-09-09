# index-bench

**Local retrieval measurements at small scale.** Ripgrep latency, cold symbol
index time, incremental re-index latency on save, and precision@k against a
checked-in fixture repository — with no model, no network, and no container.

```bash
pnpm bench:index     # run the fixture queries and write a report
node bench/harness/bin/adze-bench.mjs index
```

## What this suite measures, and what it does not

It measures **local code retrieval on this machine**: how long lexical search
takes, how long a cold symbol pass over the fixture takes, how long one query
takes after a single file changes, and how many of the top-k returned paths are
expected ones.

**Latency is not comparable across machines.** The same queries take different
time on different CPUs, disks, and load. So every run records the machine (CPU,
memory, platform), the fixture digest (sha256 over the fixture files), and the
resource band (`small-scale local`: file and byte counts, no container,
single attempt) in `config.json` and `report.md`. Compare pass rates across
machines if you like; do not compare milliseconds.

**Precision here is a wiring signal, not a ranking benchmark.** The fixture is
11 files with unambiguous symbol names, so every query is answerable by literal
search and the expected precision is 1.0. A drop means lookup broke, not that
ranking regressed. Real ranking quality at 10k/100k/1M files is `index-bench`
at M6 scale and does not exist yet — see `docs/roadmap.md`.

**These numbers measure retrieval, not any model** (`inputSource: synthetic`).
The queries and the fixture are hand-written and checked in beside this file.

## Metrics

| Metric | How it is measured |
| --- | --- |
| `ripgrepLatencyMs` (per query) | `ripgrepSearch` wall clock for the query against a temp copy of the fixture. |
| `coldIndexMs` | Fresh `LocalRetrievalProvider` over the temp copy: `listFiles` plus the first full query pass, including grammar loads and file reads. |
| `incrementalMs` | One query re-run after appending a comment line to a single fixture file in the temp copy. The provider holds no persistent index, so this is a second-search latency with warm caches — stated as such rather than as an incremental-index data structure. |
| `precision@k` (per query) | Fraction of the top-k returned paths that are expected. `matched` means at least one expected path is in the top-k. |
| `peakMemoryMb` | `process.memoryUsage().rss` after the query pass. |

The checked-in fixture is never modified: all measurements run against a temp
copy, and the digest is computed over the committed files.

## Output

Same five files as the other Tier-1 suites (`report.md` limitations-first,
`result.json`, `config.json` with machine + digest + resource band,
`trajectories/` for every query including misses, `audit.md`), written to
`bench/.runs/<stamp>-index-bench/` (gitignored) by default, or to
`bench/reports/<date>-index-bench/` with `--out` for a report meant to be
reviewed.
