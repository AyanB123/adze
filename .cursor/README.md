# Agent configuration for this repository

Adze is an AI coding tool, so it should be a good repository for an AI coding
tool to work in. This directory is that configuration, and it is committed so
every contributor gets the same setup.

## MCP servers (`mcp.json`)

Versions are pinned. An unpinned MCP server is remote code that can change under
you between sessions.

| Server | Why it is here |
| --- | --- |
| `context7` | Library documentation lookups. This repository depends on fast-moving packages — the AI SDK, the MCP SDK, tree-sitter, Vitest 4, TypeScript 7 — where training data is routinely stale. Set `CONTEXT7_API_KEY` for higher rate limits; it works without one. |
| `git` | History, blame, and diff reasoning. Load-bearing for the IDE fork work in [ADR-0010](../docs/architecture/adr/0010-ide-fork-strategy.md), which is fundamentally about tracking upstream churn. |
| `sequential-thinking` | Structured reasoning for ADR-scale decisions where the alternatives matter as much as the choice. |

Deliberately **not** configured here:

- **A filesystem server.** Cursor's native file tools are better and already scoped.
- **A GitHub server.** Useful, but it belongs in your user-level config with your
  own token rather than in a shared project file.
- **Playwright.** It will earn its place at M4 when there is an extension and an
  IDE to test end to end. Adding it now would be configuration without a consumer.

## Rules (`rules/*.mdc`)

The rules encode invariants that are **expensive to discover by review and cheap
to state up front**. They are not style preferences.

| Rule | Scope | Enforces |
| --- | --- | --- |
| `architecture-invariants.mdc` | always | The engine-first boundaries from ADR-0001. Violating these is how a multi-surface project collapses into one surface. |
| `apply-engine.mdc` | `packages/apply/**` | The correctness rules for edit application. This code decides whether an edit touches disk. |
| `benchmark-claims.mdc` | `bench/**`, `docs/benchmarks/**` | The evidence standard from ADR-0011, including the two rules that cost us headlines. |
| `commits-and-adrs.mdc` | always | DCO sign-off, Conventional Commits, and when an ADR is required. |

## Why commit this

Two reasons. First, consistency: a contributor whose agent does not know that
`@adze/core` must never import a surface will produce a PR that has to be
rejected for a reason nobody wrote down. Second, honesty: if we are asking people
to trust Adze's own configuration defaults, we should be willing to show ours.
