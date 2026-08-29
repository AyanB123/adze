# Architecture Decision Records

Each ADR records one decision: the situation that forced it, what we chose, what
we rejected and why, and what it costs us.

The rejected options are the most valuable part. A decision without its
alternatives is indistinguishable from an accident, and six months from now
nobody — including the author — will remember whether an option was considered.

## Index

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-engine-first-architecture.md) | Engine-first, multi-surface architecture | Accepted |
| [0002](0002-language-and-runtime.md) | TypeScript for the engine, Rust reserved for sidecars | Accepted |
| [0003](0003-agent-loop.md) | Minimal linear turn machine, not elaborate scaffolding | Accepted |
| [0004](0004-tool-surface.md) | Bash-first tools with native tool calling | Accepted |
| [0005](0005-edit-application.md) | Three-tier edit applier with parse validation | Accepted |
| [0006](0006-retrieval.md) | Local-first hybrid retrieval, lexical before vector | Accepted |
| [0007](0007-sandbox-and-permissions.md) | Two-axis permission model; Windows containment as a gap | Accepted |
| [0008](0008-plugin-architecture.md) | Six plugin surfaces; git-index registry before a service | Accepted |
| [0009](0009-extension-gallery.md) | Open VSX only; the MS Marketplace is closed to forks | Accepted |
| [0010](0010-ide-fork-strategy.md) | Patch series + Agent Host Protocol, not a merged fork | Accepted |
| [0011](0011-benchmark-harness.md) | Adopt Harbor; isolate evaluation in two containers | Accepted |
| [0012](0012-licensing-and-governance.md) | Apache-2.0, DCO, no open-core split | Accepted |

## Statuses

`Proposed` → under discussion · `Accepted` → in force · `Superseded by NNNN` →
replaced, kept for history · `Deprecated` → no longer applies

An accepted ADR is not permanent. It is reversed by writing a new ADR that
supersedes it, so the reasoning chain stays intact.

## Template

```markdown
# NNNN — Title

**Status:** Proposed | Accepted | Superseded by NNNN
**Date:** YYYY-MM-DD
**Deciders:** @handle

## Context
What forces the decision. Include measurements and citations where they exist.

## Decision
What we are doing, stated so it can be checked in review.

## Alternatives considered
### Option — verdict
Why it lost. Be specific and fair; a strawman is worse than no entry.

## Consequences
### Good
### Bad
### Costs we accept
What this makes harder, stated honestly.

## Revisit when
The concrete signal that should make us reopen this.
```
