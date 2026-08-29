<div align="center">

# Adze

**An open-source AI coding platform: one engine, every surface.**

A headless agent engine you can embed, a CLI, a VS Code / Cursor extension, and a
branded IDE — all Apache-2.0, all running the same engine, all local-first by default.

[Architecture](docs/architecture/README.md) ·
[Roadmap](docs/roadmap.md) ·
[Benchmark policy](docs/benchmarks/strategy.md) ·
[Plugin spec](docs/plugins/spec.md) ·
[Contributing](CONTRIBUTING.md)

</div>

---

> [!IMPORTANT]
> **Status: pre-alpha, built in the open from day one.** Nothing here is a
> benchmark claim yet. We have not beaten Cursor on anything, and we will not say
> we have until there is a reproducible run with published trajectories behind it.
> The [benchmark policy](docs/benchmarks/strategy.md) is deliberately written
> before the first number exists, so it cannot be bent to fit a result later.

## Why this exists

The open-source AI coding tool space has a graveyard problem. In the eighteen
months before this project started: **Void** was archived, **Continue** was
acquired by Cursor and wound down, **Roo Code** shut down with paying customers
on the books, **Sourcegraph Cody** went private and killed its free tier, and
**Aider** went quiet. Meanwhile the proprietary tools consolidated.

Reading those failures, one pattern separates the survivors from the casualties:

| Outcome | Projects | Shape |
| --- | --- | --- |
| Thriving | opencode, Codex CLI, Gemini CLI, OpenHands, Cline, goose | **Engine-first, multiple surfaces** |
| Dead or absorbed | Void, Roo Code, Continue, Cody | **Single-surface, or monetized the registry** |

Every casualty was either one surface (an editor fork, or an extension) or bet
its business on owning a plugin hub. Every survivor separated the agent engine
from the thing you look at, and shipped the engine everywhere.

So that is the bet: **the engine is the product; the surfaces are distribution.**

## What makes Adze different

These are the five things we intend to be measurably better at. Each is a
commitment with a test attached, not a slogan.

### 1. Local-first context, by default

Your code does not leave your machine unless you opt in. Retrieval is a hybrid of
`ripgrep` (literal and regex), `tree-sitter` (symbol and structure), and *local*
embeddings via LanceDB — no remote indexing service, no server-side prompt
assembly. Bring-your-own-key means your key talks to your provider, not to us.

This is a real contrast, not a marketing one: Cursor documents that it uploads
code chunks to compute embeddings and that requests route through its backend
even with a user-supplied API key, because final prompt assembly happens
server-side. We think the other trade-off deserves to exist.

### 2. Benchmarks you can re-run, on benchmarks that still mean something

SWE-bench Verified is not a serious target in 2026. OpenAI stopped reporting it
in February 2026 after finding that a majority of its hard instances have broken
tests and that frontier models reproduce the gold patch verbatim. We report it
only with that caveat attached.

Our actual targets are the boards that are contamination-controlled and where the
competition is honestly measurable — **SWE-rebench** (time-windowed, freshly
mined, and the one public leaderboard where Cursor is a listed agent) and
**Terminal-Bench** (trajectory-verified, reward-hacking-judged). Every number we
publish ships with trajectories for *every* trial including failures, container
digests, resource floors *and* ceilings, pinned model snapshots with effort
level, seeds, and per-task cost.

And we adopt a rule that costs us headlines: **we do not claim a win inside 3
percentage points**, because that is below the documented infrastructure-noise
floor for these harnesses.

### 3. Edit reliability treated as a product metric

The failure users actually feel is not a wrong answer, it is a mangled file. Adze
applies edits through a three-tier pipeline — bounded-fuzzy search/replace with
`tree-sitter` parse validation, then whole-file rewrite, then an optional
pluggable fast-apply provider — and **publishes the success rate per model per
tier**. To our knowledge no open-source tool measures this in public. It is cheap
to measure and it is the number that predicts whether you will trust the tool.

### 4. A plugin surface that can actually express a workflow

Tools alone are not extensibility. Adze plugins get six surfaces: **tools** (via
MCP, so thousands of existing servers work on day one), **context providers**,
**slash commands**, **deny-capable lifecycle hooks**, **subagents**, and **UI**.
Hooks can veto a tool call or an edit, which is what lets a team encode policy
without waiting for us to build a policy feature.

### 5. Sandboxing that includes Windows

Adze uses a two-axis permission model — sandbox mode crossed with approval policy
— so you can run agents with low approval friction without handing over the
machine. macOS and Linux are covered by mature OSS sandboxes. **Windows is
currently a gap across the entire OSS agent ecosystem**, and it is on our roadmap
as a first-class target rather than a footnote.

## What Adze will not do

Being explicit about limits early is cheaper than being discovered later.

- **We will not use the Visual Studio Marketplace.** Microsoft's Terms of Use
  restrict Marketplace extensions to Microsoft's own products, and the VS Code FAQ
  names Code-OSS forks specifically. Adze's IDE uses Open VSX. This means some
  proprietary extensions — Pylance, C# Dev Kit, Remote-SSH, Live Share — are
  unavailable. See the [substitution table](docs/architecture/adr/0009-extension-gallery.md).
- **We will not add a contributor license agreement.** Adze uses a DCO
  sign-off. A CLA is a reserved right to relicense, which is exactly what the
  projects in the graveyard above did. Giving that up is the point.
- **We will not monetize the plugin registry.** That business model has a
  perfect failure record in this category.
- **We will not quote leaderboard aggregators.** Only first-party harnesses and
  named independent evaluators with published methodology.

## Architecture at a glance

```
        CLI / TUI        VS Code ext.        Adze IDE          HTTP / WS
            │                 │                  │                 │
            └────────────┬────┴──────────┬────────┴─────────────────┘
                         │  Adze Wire Protocol (JSON-RPC, versioned)
              ┌──────────▼───────────────────────────────────┐
              │  @adze/core — headless engine                │
              │                                              │
              │  session · agent loop · tool registry        │
              │  permission gate · context assembler         │
              │  model gateway · edit applier · sandbox      │
              │  plugin host · MCP client + MCP server       │
              └──────────────────────────────────────────────┘
```

The engine never renders anything. Every surface owns its own UI and speaks the
same protocol, which is why the CLI, the extension, and the IDE cannot drift.
Read [docs/architecture/README.md](docs/architecture/README.md) for the real
version, and [docs/architecture/adr/](docs/architecture/adr/) for why each
decision went the way it did.

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/protocol` | Wire types and JSON Schemas. The contract between engine and surfaces. |
| `packages/core` | The engine: agent loop, tools, permissions, context assembly, sessions. |
| `packages/providers` | Model gateway. Provider-agnostic routing and cost accounting. |
| `packages/apply` | Three-tier edit applier with parse validation. |
| `packages/retrieval` | Hybrid local retrieval: ripgrep, tree-sitter, local vectors. |
| `packages/sandbox` | Per-OS sandbox brokers and the permission model. |
| `packages/plugin-sdk` | Plugin manifest schema, host, and authoring API. |
| `packages/mcp` | MCP client and server. Adze is addressable as an MCP server. |
| `packages/cli` | The `adze` command and its TUI. |
| `packages/sdk` | Public embeddable SDK for building your own surface. |
| `apps/vscode` | VS Code / Cursor / Windsurf extension. |
| `apps/ide` | Code-OSS patch series and build pipeline. Not a vendored fork. |
| `apps/hub` | Plugin registry index and web UI. |
| `bench` | Evaluation harness, our own benchmark suites, and published reports. |
| `docs` | Architecture, ADRs, research digests, guides. |

## Getting started

> Pre-alpha: this builds and the CLI runs, but the agent loop is still landing.
> Follow [the roadmap](docs/roadmap.md) for what is actually usable this week.

```bash
git clone https://github.com/AyanB123/adze.git
cd adze
pnpm install
pnpm build
pnpm test

# Run the CLI against the current directory
pnpm adze --help
```

Requirements: Node 22+, pnpm 10+, Git. Docker is needed only for benchmarks.
Rust is needed only if you build the IDE.

## Contributing

Adze is being built in public, and the parts most worth having are the parts we
have not written yet. Good first areas:

- **Edit-format reliability** — extend `bench/suites/apply-bench` with cases that
  break real models. Every case you add is permanent regression protection.
- **Plugins** — the plugin surfaces are specified before the registry exists, on
  purpose. We do not know the right extension points until real plugins exist.
- **Language coverage** — tree-sitter grammars and symbol extraction beyond the
  initial set.
- **Provider adapters** — especially open-weight models, which are at frontier
  parity now and a fraction of the cost.

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Commits need a DCO `Signed-off-by`
line (`git commit -s`). There is no CLA.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Apache-2.0 rather than MIT for two specific reasons: the express patent grant in
§3, and the trademark disclaimer in §6. Both matter in a space this dense with
patents and brands.
