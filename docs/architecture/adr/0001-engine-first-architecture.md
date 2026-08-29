# 0001 — Engine-first, multi-surface architecture

**Status:** Accepted
**Date:** 2026-08-29
**Deciders:** @AyanB123

## Context

We are entering a category with an unusually well-documented failure record. In
the eighteen months before this project started, several well-funded and
well-engineered open-source AI coding tools died:

| Project | Fate | Shape at death |
| --- | --- | --- |
| Void | Archived 2026-06-02, ~28.8k stars, no maintainers | Editor fork only |
| Roo Code | Shut down 2026-05-15, ~24.3k stars, had paying users | Extension only |
| Continue | Acquired by Cursor, wound down, ~35.7k stars | Extension + proprietary hub |
| Sourcegraph Cody | Repo private, free tier killed 2025-07-23 | Extension, open-core |
| Aider | No commits since 2026-05-22, ~48.6k stars | CLI only |

Meanwhile the projects that grew:

| Project | Stars | Shape |
| --- | --- | --- |
| opencode | ~202k | Engine + CLI + TUI + server + desktop + plugin API |
| Codex CLI | ~120k | Engine crates + CLI + app-server protocol + MCP both ways |
| Gemini CLI | ~107k | Engine + CLI |
| OpenHands | ~85k | Separate SDK repo + CLI + GUI + extensions + benchmarks |
| Cline | ~67k | Extension + CLI + SDK |
| goose | ~54k | Engine + surfaces, now Linux Foundation governed |

The correlation is not subtle. Every casualty was **single-surface** or bet its
business on **owning the plugin registry**. Every survivor separated the agent
engine from the presentation layer and shipped the engine through several
surfaces.

The causal story is straightforward. A single-surface project has exactly one
distribution channel and one reason for users to tolerate churn. When Void's
maintenance lapsed there was nothing else carrying its users. An engine-first
project can lose a surface — or gain one — without losing the project, and users
arriving through any surface are users of the same engine.

## Decision

**The engine is the product. Surfaces are distribution.**

1. `@adze/core` is headless, embeddable, and renders nothing. It emits structured
   events and never imports from a surface package.
2. Every surface — CLI, VS Code extension, IDE, HTTP daemon — communicates with
   the engine **only** through `@adze/protocol`, a versioned JSON-RPC contract.
3. Plugins may not inject UI into the engine. UI extensibility is per-surface.
4. `@adze/sdk` is a supported public API. Third parties can build surfaces
   without our involvement or permission.
5. Ship order is **extension → CLI → IDE**, cheapest and widest-reach first.

Rule 2 carries the most weight. It means a capability gap between surfaces is
always a *protocol* gap, fixed by adding a message. Without it, each surface
accretes private back channels, the surfaces diverge into three products with
three bug surfaces, and the project collapses back to maintaining one — which is
the observed failure mode.

## Alternatives considered

### Fork an existing AI IDE (Void) — rejected

Apache-2.0 and technically the closest thing to our target. But it is archived,
was already months behind upstream at archival, and has no maintainers. We would
inherit a rebase debt with no upstream partner. Its own fork ecosystem is the
strongest evidence: the largest continuation reached roughly 230 stars and one
went closed-source. Nothing survived. We read its source and take its CI
workflows; we do not inherit its tree.

### Fork opencode — rejected, and this was close

MIT, TypeScript, actively developed, and its package layout is nearly exactly
what we want. Forking would plausibly save a year, and there is a working
precedent (Kilo Code rebuilt itself on opencode).

Rejected for two reasons. First, positioning: a fork is permanently "an opencode
fork", which is a poor foundation for a project whose pitch is a distinct set of
guarantees around locality, edit reliability, and benchmark honesty. Second,
those guarantees are architectural — parse-validated edits, a gate no tool call
bypasses, epoch-based caching — and retrofitting them into someone else's turn
machine is close to a rewrite while carrying their design constraints.

We depend heavily on the *ecosystem* instead: MCP for tools, the AI SDK for
providers, ripgrep, tree-sitter, Harbor for benchmarks. "From scratch" applies to
the engine, not to solved problems.

### Extension only — rejected as an endpoint, adopted as step one

Fastest to ship, legal on the Microsoft Marketplace, reaches Cursor users
immediately. But the VS Code extension API cannot express a Cursor-class
experience: chat panel layout is not extensible, you cannot render overlays into
built-in views, there is no comprehensive workbench activity stream, and reliable
raw terminal output needs proposed APIs. It is also precisely the shape that
died twice (Roo Code, Continue).

So it is our first surface, not our only one.

### IDE fork first — rejected

Highest ceiling, worst sequencing. Six to ten weeks before anyone can try
anything, against days for an extension, and with weekly upstream releases the
maintenance clock starts before there are users to justify it.

### Monolith with pluggable UI — rejected

Superficially simpler, but with no enforced protocol boundary the engine
gradually learns about rendering, and embedding becomes impossible. The boundary
has to be a hard contract from day one or it will not exist at all.

## Consequences

### Good

- Losing or gaining a surface does not threaten the project.
- The protocol boundary makes the engine trivially testable without a UI.
- Third-party surfaces are possible without coordination, which is where
  unexpected adoption comes from.
- Adze becomes useful to people who will not switch editors — via the extension
  and via Adze-as-MCP-server.

### Bad

- A protocol boundary is real overhead. Some features need a protocol change
  before they can be built.
- Three surfaces is three sets of UX work and three release pipelines.
- Event-stream indirection makes some debugging less direct.

### Costs we accept

- **Slower to first demo** than a monolith. A monolith would show something
  impressive sooner and be unembeddable forever.
- **Protocol versioning discipline** forever, including deprecation windows.
- **No shortcuts.** The temptation to let the IDE reach into engine internals
  "just this once" is the thing that destroys the architecture, so it is a
  review-blocking rule rather than a guideline.

## Revisit when

- A surface needs something the protocol genuinely cannot express — that is
  evidence about the protocol design, not about this decision.
- The engine ships as an npm package that someone outside the project builds a
  real surface on. That is the success signal for this ADR.
