# 0006 — Local-first hybrid retrieval, lexical before vector

**Status:** Accepted
**Date:** 2026-08-29
**Deciders:** @AyanB123

## Context

Retrieval is where an AI coding tool decides what it is willing to know about you.

**What the incumbent does.** Cursor documents that it uploads code chunks to its
backend to compute embeddings, states the plaintext does not persist after the
request, and retains embeddings plus metadata including file names and hashes. It
also documents that **even with a user-supplied API key, requests route through
its backend**, because final prompt assembly happens server-side. That is a
defensible engineering choice and it is not the only possible one.

**What actually retrieves well.** The strongest agents lean on tools rather than
indexes — agentic grep plus symbol lookup outperforms vector search on most
repositories. Embeddings earn their place for "find the thing I cannot name",
which is a real but minority case.

**What is available locally.** LanceDB (Apache-2.0) is the only actively
developed embedded vector store in this space with a maintained Node binding.
`ripgrep` is Unlicense, so it has zero attribution burden and nothing beats it on
speed. `web-tree-sitter` gives real parsing without native module rebuilds.

## Decision

**Everything local by default. Cheapest signal first. Remote embedding is a
choice a user makes, never a default.**

Retrieval order:

1. **ripgrep** — literal and regex. Most lookups are lexical, and this is a
   bundled binary with no index to build.
2. **tree-sitter** — symbols, definitions, references, and structure-aware chunk
   boundaries. Answers "where is X defined" precisely and cheaply.
3. **Local vectors (LanceDB)** — semantic similarity. **Off until a workspace is
   explicitly indexed.** Embeddings computed locally by default.

Then hybrid ranking with reciprocal rank fusion across whichever signals ran, plus
recency and proximity-to-open-file boosts.

Hard commitments:

- **No network call for retrieval without explicit opt-in.** Setting a remote
  embedding provider is a deliberate configuration change that the CLI reports and
  the extension surfaces in its status bar.
- **`RetrievalProvider` is a public interface.** Swap the whole subsystem without
  forking.
- **Index artifacts stay in the workspace** (`.adze/index/`), are gitignored, and
  are deletable without breaking anything.
- **Structure-aware chunking**, on tree-sitter node boundaries rather than fixed
  token windows, so a chunk is a function rather than a fragment of two.

## Alternatives considered

**Remote embedding service** — rejected. Better retrieval quality at scale and
it forfeits the one product promise we can make that the incumbent cannot. Also
means running infrastructure, which contradicts the "no hosted service" non-goal.

**Vector-first retrieval** — rejected. Inverts the evidence. It also makes the
tool useless until indexing completes, which is a terrible first-run experience on
a large repository.

**Precomputed index formats (LSIF / SCIP)** — rejected for now. LSIF is
superseded. SCIP is Apache-2.0 and genuinely more precise, but it needs
per-language indexers as a build step, and its stewardship moved as Sourcegraph
retreated from open source. Live LSP gives most of the precision and the editor is
already running it.

**sqlite-vec instead of LanceDB** — rejected. Attractively simple, but development
has slowed markedly. LanceDB is actively maintained and covers both embedded and
server modes, so a future team tier does not force a migration.

**No vector search at all** — tempting, and rejected. It would simplify a lot.
But "find the code that handles retries somewhere" is a real query that lexical
search answers badly, and making it opt-in gets us the capability without the
default cost.

## Consequences

**Good.** A genuine, checkable privacy claim rather than a marketing one. Instant
usefulness with no index build. No embedding infrastructure to run or pay for.
Works offline and in air-gapped environments — which is a segment nobody currently
serves.

**Bad.** Local embeddings are weaker than frontier hosted ones. Indexing a very
large monorepo costs local CPU and disk. Hybrid ranking across heterogeneous
signals is genuinely harder to tune than one vector search.

**Costs we accept.** Somewhat lower retrieval quality on the semantic case than a
server-side index would give, in exchange for a promise we can keep. And the
tuning burden of hybrid ranking, which we take on rather than pushing to users.

## Revisit when

- `bench:retrieval` shows local retrieval materially behind on a repository-QA
  suite. That is evidence about ranking, and possibly about local embedding
  models, before it is evidence about this decision.
- A local embedding model reaches parity with hosted ones, which would close the
  gap entirely.
