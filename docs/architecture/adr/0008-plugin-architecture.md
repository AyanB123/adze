# 0008 — Six plugin surfaces; git-index registry before a service

**Status:** Accepted
**Date:** 2026-08-29
**Deciders:** @AyanB123

## Context

"Extensible" usually means "you can add a tool", which is not enough to express a
workflow. Meanwhile the registry question has a clear cautionary record: the
closest comparable project built a proprietary hub on top of an Apache-2.0
extension, monetized the hub, and no longer exists.

**Prior art worth copying:**

- **MCP** is the settled standard for tool extensibility — an official registry, a
  reference server collection with ~90k stars, and now foundation governance.
  Inventing a tool protocol forfeits thousands of existing servers.
- **Zed's extension model** is the best design in the field: an extension is *a
  git repository containing a manifest*, most extensions need **no code at all**,
  procedural code compiles to `wasm32-wasip2`, the registry is a PR-reviewed index
  repo, and dev extensions can override published ones locally.
- **Obsidian** proves GitHub-releases-as-CDN is sufficient at real scale.
- **The registry-as-business-model** has a perfect failure record here.

**And the security record is not hypothetical.** Open VSX has had a
super-admin publish-token vulnerability affecting an estimated 10M+ developers, a
self-propagating worm that hid payloads in invisible Unicode so reviewers saw
blank lines, and a namespace-squatting vector that let researchers target users of
four major VS Code forks. Any registry design has to start from that.

## Decision

### Six extension surfaces, in shipping order

| # | Surface | Mechanism | Isolation | Milestone |
| --- | --- | --- | --- | --- |
| 1 | **Tools** | MCP (stdio + Streamable HTTP) | subprocess sandbox | M2 |
| 2 | **Context providers** | manifest, or WASM `provide_context(query)` | WASM | M2 |
| 3 | **Slash commands** | declarative: prompt template + tool allowlist | none needed | M2 |
| 4 | **Hooks** | lifecycle events, **may deny** | WASM + hard timeout | M3 |
| 5 | **Subagents** | declarative: prompt, tools, model preference | inherits parent | M3 |
| 6 | **UI** | surface-side contribution | surface CSP | M4 |

**Hooks are the important one.** Events: `session.start`, `session.turnStart`,
`tool.pre`, `tool.post`, `edit.pre`, `edit.post`, `context.pre`, `session.turnEnd`,
`session.compact`. `tool.pre` and `edit.pre` may return `allow`, `deny(reason)`,
or `modify(args)`.

A hook that can veto a tool call or an edit means a team can encode its own policy
— forbid writes outside a directory, require review for migrations, block network
calls to non-allowlisted hosts — **without us building a policy feature and
without a fork.** That is the difference between extensible and configurable.

**UI is deliberately last and deliberately surface-side.** If plugins could inject
UI into the engine, the CLI, extension, and IDE would immediately diverge. This is
the same boundary as [ADR-0001](0001-engine-first-architecture.md).

### Packaging

A plugin is **a directory or git repository containing `adze.plugin.json`** —
manifest first, following Zed. Most plugins are declarative and contain no
executable code. Procedural plugins target `wasm32-wasip2`. Native plugins are
permitted, clearly labelled as unsandboxed, and never installed silently.

### Registry: git index in v1, service in v2

**v1** — a single PR-reviewed index repository plus normal distribution (npm for
JS, git tags otherwise). Total infrastructure: one repo and a CI validator.

This is not laziness. A registry with no plugins in it is worthless, and **we do
not yet know the right extension points.** They become clear when someone tries to
build something and cannot. Building a registry service first would mean shipping
infrastructure for a specification we have not validated.

**v2** — a read-mostly index service over the same git index for search,
download counts, and compatibility resolution, plus an OCI registry for WASM
artifacts.

**Never** — a paid hub. Distribution stays free and unmetered, permanently.
See [GOVERNANCE.md](../../../GOVERNANCE.md).

### Security, from the incidents above

- **Version compatibility ranges** in the manifest, checked at load.
- **npm provenance attestations** in v1; cosign on OCI artifacts in v2.
- **Invisible-Unicode and bidi-control scanning** on every manifest and source
  file, as a build failure rather than a warning.
- **Automated pre-publish scanning before we need it**, not after an incident.
- **A `verified` flag** gated on identity plus review, and never implied.
- **Namespace claims are explicit**, so an unclaimed name cannot be squatted into
  a trusted position.

## Alternatives considered

**MCP only** — rejected. Excellent for tools, but it cannot express a hook, a
subagent, or a slash command. Adopted as surface 1 of 6.

**A VS Code-style extension API for the engine** — rejected. It would drag UI
concepts into a headless engine and break embedding.

**Registry service in v1** — rejected. Months of infrastructure to host an empty
store, built against unvalidated extension points.

**npm as the registry** — partially adopted. Free CDN, auth, versioning, and
provenance for free. But npm cannot express engine-compatibility ranges or a
review tier, so the git index carries metadata and npm carries bytes.

**Monorepo-of-all-plugins (the Raycast model)** — rejected. Highest quality bar
and highest maintainer cost; it makes us the bottleneck for every plugin. Kept as
a model for a future curated tier only.

## Consequences

**Good.** Thousands of MCP servers work on day one. Declarative plugins mean
non-programmers can contribute. Deny-capable hooks make enterprise policy a
community problem rather than a roadmap item. Near-zero registry infrastructure.
WASM keeps third-party code contained.

**Bad.** Six surfaces is a large API to keep stable. WASM tooling is unfamiliar to
many contributors. A git-index registry has worse discovery than a real service.
Hooks in the hot path need strict timeouts or they become a latency bug.

**Costs we accept.** **Worse plugin discovery than a hosted registry** for the
first several months, in exchange for designing extension points against real
usage. And permanently forgoing registry revenue, which is the obvious business
model and the one with a perfect failure record here.

## Revisit when

- Roughly 20+ third-party plugins exist. That is the signal to build the v2 index
  service, and by then we will know what to index.
- A plugin author reports something they cannot express. That is the most valuable
  bug report this ADR can receive.
