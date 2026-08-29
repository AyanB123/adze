# 0002 — TypeScript for the engine, Rust reserved for sidecars

**Status:** Accepted
**Date:** 2026-08-29
**Deciders:** @AyanB123

## Context

The engine language choice constrains everything downstream: which surfaces are
cheap, who can contribute, how many build matrices exist, and whether a process
boundary is forced.

Two hard facts shape it:

1. **Our surfaces are TypeScript whether we like it or not.** A VS Code extension
   is TypeScript. A Code-OSS fork is TypeScript. That is two of three surfaces
   before we choose anything.
2. **The ecosystem we depend on is split.** The MCP SDK, the AI SDK, and
   `web-tree-sitter` are strongest in TypeScript. Sandboxing and high-performance
   indexing are strongest in Rust.

Reference points: opencode, Gemini CLI, Cline, and Continue chose TypeScript.
Codex CLI chose Rust. OpenHands chose Python for its engine and then had to build
a REST boundary to its TypeScript/Electron GUI.

## Decision

**TypeScript for the engine, protocol, surfaces, and CLI. Rust only for native
sidecars where it earns its keep.**

- Target Node 22.12+, ESM only, `"type": "module"` everywhere.
- TypeScript 7 (the native compiler) with `strict`, `noUncheckedIndexedAccess`,
  and `exactOptionalPropertyTypes`.
- pnpm workspaces with a version catalog, Turborepo for task orchestration,
  Biome for lint and format, Vitest for tests.
- **Rust is permitted only** for: the Windows sandbox broker, a native index
  daemon if profiling proves the TypeScript one insufficient, and IDE CLI
  integration. Each requires its own ADR justifying the process boundary.
- Prefer WASM over native Node addons. `web-tree-sitter` over `tree-sitter`
  bindings, specifically to avoid rebuilding native modules across
  Electron ABI × OS × arch.

## Alternatives considered

### Rust for the engine — rejected, with real regret

Genuinely better for sandboxing (Codex has the only credible Windows story, in
Rust), better for indexing throughput, better single-binary distribution, no
runtime dependency.

Rejected because it forces a process boundary to *both* of our TypeScript
surfaces, and that boundary is not free — it is serialization, lifecycle
management, error mapping, and debugging across a wire for every feature. It also
narrows the contributor pool sharply relative to the VS Code extension community
we most want to recruit from, and it doubles the build matrix.

We keep the option scoped: the components where Rust actually wins are sandboxing
and indexing, and both are naturally out-of-process anyway. That is the right
place for a boundary, rather than through the middle of the engine.

### Python for the engine — rejected

Best AI/ML ecosystem, and it is what the benchmark harnesses are written in.

But every surface we ship is TypeScript, so Python forces the boundary
immediately and permanently. OpenHands demonstrates the cost: engine in Python,
GUI in TypeScript, REST between them. Packaging is also materially worse —
shipping a Python runtime inside a VS Code extension is unpleasant, and startup
latency is hard to get under our 400 ms budget.

We still *use* Python for benchmark harnesses, via subprocess. That is the
correct amount of Python.

### Go for the engine — rejected

Excellent concurrency and single-binary output. But it has the same
boundary-to-surfaces problem as Rust with a weaker case: it does not win on
sandboxing or on raw indexing performance the way Rust does, so it pays the cost
without collecting the benefit.

### Node with CommonJS — rejected

The ecosystem has moved. The MCP SDK, the AI SDK, and modern tooling are
ESM-first, and dual publishing is ongoing overhead for no user-visible gain.

### TypeScript 5 instead of 7 — considered, rejected

TypeScript 7 is the current stable release and is dramatically faster on a
monorepo this size, which matters for the typecheck loop. The risk is that the
native compiler's edges differ from the JavaScript implementation's. We accept
that risk because CI catches it immediately and the fallback (pin to 5.x) is one
line.

## Consequences

### Good

- One language across engine, protocol, CLI, extension, and IDE. One toolchain,
  one build, one test runner.
- Contributors from the VS Code extension ecosystem — the largest relevant pool —
  can contribute to the engine on day one.
- The engine can run **in-process** inside the extension host, which removes IPC
  latency from the most common surface.
- WASM-first native strategy avoids the Electron ABI rebuild problem that eats
  days on fork builds.

### Bad

- Slower than Rust on CPU-bound indexing. Mitigated by shelling out to ripgrep
  (which is Rust) and by reserving a native sidecar.
- Node runtime dependency for the CLI. Mitigated by single-file bundling.
- Higher idle memory than a native binary. Hence the 120 MB budget in the
  architecture doc, enforced by benchmark.
- Windows sandboxing will require Rust, so we take one process boundary anyway.

### Costs we accept

- **Losing the single-static-binary distribution story** that Codex and goose
  enjoy. Node 22+ is a real prerequisite we must document.
- **A hard performance ceiling** on pure-TypeScript indexing. We commit to
  measuring it rather than assuming, and to writing the Rust sidecar when a
  benchmark — not a hunch — says so.

## Revisit when

- A `bench:index` or `bench:latency` run misses its target and profiling shows the
  cause is language-level rather than algorithmic.
- Windows sandboxing work begins. That is the first legitimate Rust sidecar and
  it needs its own ADR.
