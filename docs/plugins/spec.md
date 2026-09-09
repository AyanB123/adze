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
providers need code. That code targets `wasm32-wasip2` so it runs sandboxed —
and this build ships the WASM host interface with **no WASM runtime**, so a
`.wasm` module refuses to load rather than loading without its policy (the
loader reports `module-unloadable`). What executes procedural plugin code today
is a local ES module runtime: `runtime: "js"` runs in the Adze process with no
sandbox and loads only when the host opts in with `allowUnsandboxedJs`;
`runtime: "native"` likewise needs `allowNative`. The four declarative-first-party
plugins need no flags at all, because there is no code to run.

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

Install: `adze plugin add <local-path | git-url>` — local-only, no registry
service. The command shows the plugin's id, license, namespace, permissions,
and contributions, then asks for consent before recording anything; pass
`--yes` in CI. State lives in `.adze/plugins/` (gitignored).
Develop: `adze plugin dev ./my-plugin` — points a live override at the
directory, shadowing the installed entry with the same id. Every load reads the
directory, and the override is bannered in `adze doctor` and run trajectories
while active. `adze plugin list` shows the set, `adze plugin remove <id>`
removes one, and `adze plugin validate <path>` runs every static gate without
executing plugin code. What also works is loading plugins **programmatically**
through `@adze/plugin-sdk`:

```ts
import { jsModuleRuntime, loadPlugins } from '@adze/plugin-sdk';

const set = await loadPlugins(['./my-plugin'], {
  engineVersion: '0.0.1',
  jsRuntime: jsModuleRuntime({ allowedRoots: ['.'] }),
  allowUnsandboxedJs: true, // required for runtime: "js"; a JS module is not sandboxed
});
```

See [the plugin guide](../guides/plugins.md) for the full worked loading script,
verified against all eight first-party plugins.

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
  // The engine is pre-1.0 (currently 0.0.1); copy this range verbatim.
  "engines": { "adze": ">=0.0.1 <1.0.0" },

  // Everything below is optional. Declare only the surfaces you use.
  // Shapes: tools are MCP server configs (surface 1); contextProviders are
  // glob or wasm entries (surface 2); commands and agents are file references
  // to markdown with front matter (surfaces 3 and 5); hooks carry an explicit
  // runtime (surface 4); ui is accepted by the manifest and refused by the
  // engine, which hands it to a surface (surface 6).
  "contributes": {
    "tools":            [ /* { name, transport, command|url, ... } — surface 1 */ ],
    "contextProviders": [ /* { type: "glob", ... } | { type: "wasm", ... } — surface 2 */ ],
    "commands":         [ { "path": "commands/review.md" } ],
    "hooks":            [ { "event": "edit.pre", "module": "hooks/policy.wasm", "runtime": "wasm", "timeoutMs": 500 } ],
    "agents":           [ { "path": "agents/security.md" } ],
    "ui":               [ { "surface": "cli", "id": "panel", "kind": "panel" } ]
  },

  // Requested capabilities. Shown to the user at install time. A plugin that
  // asks for more than it needs is a plugin users should decline.
  // Omit permissions and the plugin gets none: filesystem "none", no network,
  // no env. A hook that inspects the edit payload needs no filesystem access.
  "permissions": {
    "filesystem": "read",              // none | read | workspace-write
    "network": ["api.acme.com"],       // explicit hosts, or omit for none
    "env": ["ACME_TOKEN"]              // explicit variable names
  }
}
```

`id` must be `<namespace>.<name>` with **exactly one dot**, lowercase letters,
digits and hyphens only. `acme.team.guard` is refused: the namespace is a trust
boundary (explicit namespace claims defend against squatting), so the part of
the id a claim applies to has to be mechanically extractable.

`timeoutMs` on a hook (or a `wasm` context provider) defaults to 500 and is
capped at 10,000. A hook is synchronous with respect to the agent's progress,
so an unbounded hook is a latency bug the plugin author will not notice.

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
ones export one function from a guest module.

```jsonc
"contextProviders": [
  { "name": "adr", "type": "glob", "patterns": ["docs/adr/**/*.md"], "trigger": "@adr", "maxBytes": 32768 },
  { "name": "jira", "type": "wasm", "module": "providers/jira.wasm", "trigger": "@jira", "timeoutMs": 500, "maxBytes": 32768 }
]
```

A `glob` provider needs `name`, `patterns`, `trigger` (`@name`, lowercase), and
an optional `maxBytes` ceiling. A `wasm` provider needs `module`, `trigger`, and
optional `timeoutMs` / `maxBytes`. The `wasm` discriminant names the surface, not
the isolation: the module's runtime is inferred from its extension exactly as
hooks are (`.wasm` → wasm, `.js`/`.mjs` → js), and the same host opt-ins apply —
a `.mjs` provider needs `allowUnsandboxedJs`, and a `.wasm` provider needs a
`wasm32-wasip2` runtime this build does not ship, so it refuses to load. There is
no `runtime` field to override the inference; a `type: "wasm"` entry pointing at
a `.mjs` file runs as unsandboxed JavaScript, gated by `allowUnsandboxedJs`.

```rust
// wasm32-wasip2
#[adze::context_provider]
fn provide_context(query: &str) -> Vec<Chunk> {
    vec![Chunk { source: format!("jira:{query}"), content: fetch(query), relevance: 0.9 }]
}
```

Context-provider triggers are checked for collisions across plugins by the
single funnel every provider passes through (`buildContextProviders`): two
plugins claiming `@docs` load, the first one wins, and the loser is reported.
Slash-command and subagent names are checked the same way, by the command and
agent registries (`buildCommandRegistry`, `buildAgentRegistry`) every surface
assembles from: two plugins contributing `review` load, the first one wins, and
the later entry is refused with a diagnostic rather than silently shadowed.
`adze plugin validate` reports the collision an install would create before
anything is installed.

## Surface 3 — Slash commands

A slash command is a manifest file reference plus a markdown file: YAML front
matter plus a prompt template.

```jsonc
"commands": [{ "path": "commands/review.md" }]
```

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
A `!` block with no host-supplied command runner refuses the whole command with
`frontmatter-invalid` rather than running without it. `@name` invokes a context
provider. `model:` must be inline (`model: { prefer: reasoning }`); the nested
block form is a parse error, because the front-matter parser accepts no nested
block mapping under a mapping key.

## Surface 4 — Hooks

**The surface that makes Adze policy-extensible.** A hook can *veto* an action, so
a team can encode its own rules without us building a policy feature and without
forking.

```jsonc
"hooks": [
  { "event": "edit.pre", "module": "hooks/policy.wasm", "runtime": "wasm", "timeoutMs": 500 },
  // Scoped to what the hook polices: the host applies these before dispatching
  // to the guest, so the hook never runs for calls it would ignore.
  { "event": "tool.pre", "module": "hooks/bash-guard.mjs", "runtime": "js", "tools": ["bash"], "paths": ["infra/**/*.yml"], "timeoutMs": 500 }
]
```

`tools` matches the tool name (`tool.pre`/`tool.post`, or the originating tool
for derived `edit.pre`/`edit.post`); `paths` matches the edit path with the same
glob syntax as context providers. Both lists are OR within and AND across: a
hook with both fires only when both match. An invalid glob is a load error, and
a skipped dispatch is recorded as `skipped` rather than silently dropped.

`runtime` is `"wasm"`, `"js"`, or `"native"`. It may be omitted when the module
extension says how to run it: `.wasm` infers `wasm`, `.js`/`.mjs` infers `js`.
Anything else refuses to load with `module-unloadable` rather than guessing —
defaulting an unknown extension to `native` would silently run unsandboxed code,
and `native` is never inferred. `export` optionally names the guest function
(defaults to the event name). Every hook entry above is explicit about its
runtime so a reader of the manifest can see the isolation without knowing the
inference rules.

What the runtime costs: `wasm` needs a `wasm32-wasip2` runtime this build does
not ship, so the default host refuses the plugin with `module-unloadable`
instead of loading it without its policy. `js` is an ES module imported into the
Adze process with the engine's full privileges — the same exposure as `native`
— so the host must pass `allowUnsandboxedJs` (or `allowNative` for `native`),
supply `jsRuntime: jsModuleRuntime({ allowedRoots })` so the module cannot leave
its roots, and the plugin refuses without that opt-in (`native-not-permitted`).
A hook module that will not load fails the whole plugin: a policy that appears
installed and enforces nothing is worse than one that refuses to install.

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

What runs today is the same contract as an ES module, because the WASM runtime
above is not built. The guest exports `invoke(functionName, input)` and returns
`{ kind: "allow" | "deny" | "modify" | "inject" | "replace" }`:

```js
// hooks/policy.mjs — runtime: "js", unsandboxed, needs allowUnsandboxedJs
export function invoke(functionName, input) {
  if (functionName === 'edit.pre') {
    const introduced = [
      ...(input.wholeFile && typeof input.content === 'string' ? [input.content] : []),
      ...(Array.isArray(input.edits) ? input.edits.map((e) => e.replace) : []),
    ];
    if (input.path.includes('/migrations/') && input.approvedByHuman !== true) {
      return { kind: 'deny', reason: 'Migrations require human review (policy: acme-eng-014)' };
    }
    void introduced;
    return { kind: 'allow' };
  }
  return { kind: 'allow' };
}
```

Hooks are in the hot path, so `timeoutMs` is enforced. A hook that times out is
treated as `allow` and logged loudly — failing closed on a slow hook would make
the agent unusable, and failing silently would hide a broken policy. A host that
would rather stop the agent passes `onFailure: 'deny'` to the `HookHost`; the
SDK refuses to make that choice on its behalf. A hook entry may scope itself
with `tools` and `paths` filters, which the host applies before guest dispatch —
prefer `tools: ["bash"]` over opening with
`if (input.name !== 'bash') return { kind: 'allow' };`, so the guest is never
entered for calls the hook would ignore. An unscoped hook runs on every call of
its event, and the cost grows linearly with installed policy plugins. `tool.pre`
fires for every tool call and additionally derives `edit.pre` for edit-shaped tools, so a plugin
registering both is invoked twice per edit; the events compose rather than
alternate.

### The `edit.pre` payload

Documented in full because the veto surface is the one where an incomplete reading
produces a policy with a hole in it rather than an error.

| Field | Type | Notes |
| --- | --- | --- |
| `path` | `string` | The file the edit targets |
| `edits` | `{ search, replace }[]` | The search/replace blocks. **Empty for a whole-file write.** |
| `wholeFile` | `boolean` | True when the call replaces the entire file |
| `content` | `string?` | The bytes a whole-file write would leave on disk. Present when `wholeFile` is true, **omitted** — not null — otherwise. |
| `approvedByHuman` | `boolean` | Whether a human already approved this path this turn |
| `arguments` | `object` | The raw tool arguments at this point in the chain |
| `sessionId`, `turnId`, `callId` | `string` | Correlation ids |

**A content policy must read `content` as well as `edits[].replace`.** Reading only
`edits` produces a guard that refuses a credential added by `edit` and allows the
identical credential written by `write`, because a whole-file write reports
`edits: []`. That is not hypothetical — it is the bypass `plugins/FINDINGS.md`
records against an earlier version of this payload, which carried no `content` at
all, and it is the reason the field exists.

Three shapes reach disk and a policy has to treat them alike: a search/replace edit
(`edits` populated, `wholeFile` false), a whole-file `write` (`content` set,
`edits` empty), and an `edit` carrying a whole-file `replacement` (`content` set,
`edits` possibly empty). Deciding on `edits` alone covers one of the three.

Prefer `path`, `edits`, `wholeFile` and `content` over `arguments`. `arguments` is
the lower-level escape hatch, and reading tool-specific argument names couples the
policy to which tool produced the edit — the coupling `edit.pre` exists to remove.
It is declared, so it is safe to use when a rule genuinely needs something the
tool-agnostic fields do not carry.

## Surface 5 — Subagents

A subagent is a manifest file reference plus a markdown definition:

```jsonc
"agents": [{ "path": "agents/security.md" }]
```

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
sandbox — narrower tools, never broader permissions. `tools` is required: a
subagent omitting it is refused, because an empty list would otherwise inherit
the parent's whole tool set. A subagent omitting `permissions` inherits the
parent's, which can only narrow and never widen — state `permissions` explicitly
so the asymmetry is visible. As with commands, `model:` must be inline, and only
`filesystem` is narrowable in front matter: `network` or `env` lists cannot nest
under a mapping key and are refused rather than dropped.

## Surface 6 — UI

Surface-specific and deliberately last. **UI cannot be contributed to the
engine** — only to a surface — because a plugin that injects UI into the engine
would immediately split the CLI, extension, and IDE into three different products.
See [ADR-0001](../architecture/adr/0001-engine-first-architecture.md).

```jsonc
"ui": [{ "surface": "cli", "id": "panel", "kind": "panel", "title": "Review", "entry": "ui/panel.mjs" }]
```

The manifest accepts UI so a plugin with both a hook and a panel loads
engine-side; the engine host drops every UI entry, records each as a
`ui-refused-by-engine` notice for the surface, and throws if a surface offers
one to the engine. `surface` is `cli`, `vscode`, or `ide`.

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
