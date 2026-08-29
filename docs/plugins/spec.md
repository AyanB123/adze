# Plugin specification

**Status: draft, v0.** This spec is published *before* the registry exists, on
purpose — we do not yet know which extension points are wrong, and we will not
find out until someone tries to build something and cannot. If you hit a wall,
[that is the bug report we most want](https://github.com/AyanB123/adze/issues/new).

Design reasoning: [ADR-0008](../architecture/adr/0008-plugin-architecture.md).

---

## What a plugin is

**A directory containing `adze.plugin.json`.** That is the whole requirement.

Most plugins contain no executable code at all — a tool integration, a slash
command, or a subagent is pure declaration. Only hooks and dynamic context
providers need code, and that code compiles to WebAssembly so it runs sandboxed.

```
my-plugin/
├── adze.plugin.json      # required
├── README.md
├── commands/
│   └── review.md         # slash command: front matter + prompt template
├── agents/
│   └── security.md       # subagent definition
└── hooks/
    └── policy.wasm       # compiled from Rust/Go/Zig/TinyGo → wasm32-wasip2
```

Install: `adze plugin add <npm-package | git-url | ./local-path>`
Develop: `adze plugin dev ./my-plugin` — overrides any published version, so you
can iterate without publishing.

---

## Manifest

```jsonc
{
  "$schema": "https://adze.dev/schema/plugin/v0.json",
  "id": "acme.migration-guard",        // <namespace>.<name>, lowercase
  "version": "1.2.0",                  // semver
  "displayName": "Migration Guard",
  "description": "Requires human review before any database migration is written.",
  "license": "Apache-2.0",
  "repository": "https://github.com/acme/migration-guard",

  // Adze engine versions this plugin supports. Checked at load time; a
  // mismatch is a clear error rather than a mysterious runtime failure.
  "engines": { "adze": ">=0.4.0 <2.0.0" },

  // Everything below is optional. Declare only the surfaces you use.
  "contributes": {
    "tools":            [ /* MCP servers — surface 1 */ ],
    "contextProviders": [ /* surface 2 */ ],
    "commands":         [ /* surface 3 */ ],
    "hooks":            [ /* surface 4 */ ],
    "agents":           [ /* surface 5 */ ],
    "ui":               [ /* surface 6, surface-specific */ ]
  },

  // Requested capabilities. Shown to the user at install time. A plugin that
  // asks for more than it needs is a plugin users should decline.
  "permissions": {
    "filesystem": "read",              // none | read | workspace-write
    "network": ["api.acme.com"],       // explicit hosts, or omit for none
    "env": ["ACME_TOKEN"]              // explicit variable names
  }
}
```

---

## Surface 1 — Tools (MCP)

Tools are contributed as MCP servers. We did not invent a tool protocol, so the
existing ecosystem of MCP servers works with Adze on day one.

```jsonc
"tools": [
  {
    "name": "acme-db",
    "transport": "stdio",                    // stdio | http
    "command": "npx",
    "args": ["-y", "@acme/mcp-database"],
    "env": { "ACME_TOKEN": "${env:ACME_TOKEN}" },
    "sandbox": "workspace-write",            // sandbox mode for the subprocess
    "autoApprove": ["query_schema"]          // read-only calls that skip prompting
  }
]
```

MCP servers are subprocesses and are sandboxed like any other subprocess. Adze
supports **stdio** and **Streamable HTTP** only; the deprecated standalone SSE
transport is not implemented.

## Surface 2 — Context providers

Inject content into the agent's context. Static providers are declarative; dynamic
ones export one WASM function.

```jsonc
"contextProviders": [
  { "name": "adr", "type": "glob", "patterns": ["docs/adr/**/*.md"], "trigger": "@adr" },
  { "name": "jira", "type": "wasm", "module": "providers/jira.wasm", "trigger": "@jira" }
]
```

```rust
// wasm32-wasip2
#[adze::context_provider]
fn provide_context(query: &str) -> Vec<Chunk> {
    vec![Chunk { source: format!("jira:{query}"), content: fetch(query), relevance: 0.9 }]
}
```

## Surface 3 — Slash commands

A markdown file: YAML front matter plus a prompt template.

```markdown
---
name: review
description: Review staged changes against our conventions
tools: [read, grep, symbols, bash]     # allowlist — narrower than the session's
model: { prefer: reasoning }
---

Review the staged diff.

!`git diff --cached`

Check: error handling, missing tests, and anything violating @adr.
Report findings by severity. Do not modify files.
```

`!` executes a command and inlines its output (gate-checked like any tool call).
`@name` invokes a context provider.

## Surface 4 — Hooks

**The surface that makes Adze policy-extensible.** A hook can *veto* an action, so
a team can encode its own rules without us building a policy feature and without
forking.

```jsonc
"hooks": [
  { "event": "edit.pre", "module": "hooks/policy.wasm", "timeoutMs": 500 }
]
```

| Event | May return | Use |
| --- | --- | --- |
| `session.start` | context | Inject project state |
| `session.turnStart` | context | Per-turn setup |
| `context.pre` | `modify` | Rewrite assembled context |
| `tool.pre` | `allow` / `deny` / `modify` | **Block or rewrite a tool call** |
| `tool.post` | `modify` | Transform results |
| `edit.pre` | `allow` / `deny` / `modify` | **Block or rewrite an edit** |
| `edit.post` | — | Notify, log, run a formatter |
| `session.compact` | `modify` | Control what survives compaction |
| `session.turnEnd` | — | Report, audit |

```rust
#[adze::hook(event = "edit.pre")]
fn guard(ctx: EditContext) -> HookResult {
    if ctx.path.contains("/migrations/") && !ctx.approved_by_human {
        return HookResult::deny("Migrations require human review (policy: acme-eng-014)");
    }
    HookResult::allow()
}
```

Hooks are in the hot path, so `timeoutMs` is enforced. A hook that times out is
treated as `allow` and logged loudly — failing closed on a slow hook would make
the agent unusable, and failing silently would hide a broken policy.

## Surface 5 — Subagents

```markdown
---
name: security-reviewer
description: Audits a diff for security issues
tools: [read, grep, symbols]      # deliberately no bash, no write
model: { prefer: reasoning }
maxSteps: 30
---

You audit code for security defects. Report findings with severity and file:line.
You cannot modify files. Prefer a false positive over a missed injection.
```

Invoked by the `task` tool or a slash command. Subagents inherit the parent's
sandbox — narrower tools, never broader permissions.

## Surface 6 — UI

Surface-specific and deliberately last. **UI cannot be contributed to the
engine** — only to a surface — because a plugin that injects UI into the engine
would immediately split the CLI, extension, and IDE into three different products.
See [ADR-0001](../architecture/adr/0001-engine-first-architecture.md).

---

## Distribution and trust

**v1 registry is a PR-reviewed git index plus normal package distribution** (npm
for JavaScript, git tags otherwise). A registry with no plugins in it is worthless,
so the service comes after the ecosystem, not before.

Security requirements, each responding to a real documented incident in this
ecosystem:

| Requirement | Incident it addresses |
| --- | --- |
| npm provenance attestations; cosign on OCI in v2 | Publish-token compromise |
| Invisible-Unicode and bidi-control scanning, as a **build failure** | A self-propagating worm hid payloads in invisible characters so reviewers saw blank lines |
| Explicit namespace claims | Unclaimed namespaces let researchers target users of four major VS Code forks |
| `engines.adze` range checked at load | Silent breakage on upgrade |
| Permissions shown at install; WASM sandboxed; native plugins labelled unsandboxed | Third-party code execution |

**Distribution is free and unmetered, permanently.** Monetizing the registry is
the failure mode that killed the closest comparable project, and
[GOVERNANCE.md](../../GOVERNANCE.md) makes that commitment binding.

---

## Open questions

Genuinely unresolved. Opinions welcome on the issue tracker.

1. **Hook ordering.** When two plugins hook `tool.pre`, what determines order?
   Declaration order is arbitrary; explicit priority invites priority inflation.
2. **Conflicting denials.** If one hook denies and another modifies, deny wins —
   but should the user see that a modification was discarded?
3. **WASM ergonomics.** Rust is a real barrier. Is a TypeScript-to-WASM path worth
   the toolchain weight?
4. **Cross-surface UI.** Is there a declarative subset of UI that could work
   across CLI, extension, and IDE without recreating the divergence problem?
5. **Versioning against a pre-1.0 engine.** How much churn is acceptable before
   plugin authors reasonably give up on us?
