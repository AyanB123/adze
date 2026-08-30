# What building these plugins found

`docs/plugins/spec.md` was published before the registry and before any plugin existed,
on purpose: ADR-0008 says the extension points do not become clear until someone tries to
build something and cannot, and `CONTRIBUTING.md` calls that "the feedback we most need
right now". This file is that feedback, written while building the eight first-party
plugins in this directory.

Each entry says what was attempted, what the spec or the SDK actually does, and what it
cost. Nothing here is fixed in `packages/plugin-sdk` — these are reports.

---

## 1. `edit.pre` cannot see the content of a whole-file write

**Severity: this is a policy bypass.**

`docs/plugins/spec.md` presents `edit.pre` as *the* event for vetoing an edit, and its
worked example branches on `ctx.path`. The SDK's `EditPrePayload` adds
`edits: readonly { search, replace }[]` and `wholeFile: boolean`.

For core's `write` tool, `readCoreWriteArgs` in `packages/plugin-sdk/src/bridge.ts`
returns `{ path, edits: [], wholeFile: true }`. **The bytes being written are not in the
payload.** So a hook that registers `edit.pre` and inspects `edits[].replace` — the only
content field the declared payload has — will refuse a credential added by `edit` and
allow the identical credential written by `write`.

That is the worse of the two cases, because `write` replaces the whole file.

`adze.secrets-guard` works around it by *also* registering `tool.pre`, where `arguments`
is a declared field and `arguments.content` is the real content. That works, and it means
the plugin has to know which underlying tool produced the edit — exactly the coupling
`edit.pre` exists to remove. A plugin author who read only the spec would not discover
this; they would ship a guard with a hole in it and no failing test.

There is a second, subtler half. The wire payload `toJson` builds for `edit.pre` in
`packages/plugin-sdk/src/hooks.ts` *does* include an `arguments` field, so a guest
receiving JSON can reach `arguments.content` today. But `arguments` is **not** on the
`EditPrePayload` interface. A plugin relying on it is relying on something the declared
type does not promise, and a refactor that made the serializer match the interface would
silently break every such policy. The wire format and the declared type disagree, and
the declared type is the one plugin authors read.

**Suggested fix, for whoever picks this up:** put the resolved content on the `edit.pre`
payload — `content?: string` for a whole-file write — and add it to `EditPrePayload` so
the type and the wire format agree. Either that, or say in the spec that `edit.pre` is
edit-tool-only and whole-file writes must be policed on `tool.pre`.

---

## 2. Hook events cannot be scoped to a tool, so every hook runs on every call

`tool.pre` fires for every tool call. A hook that only cares about `bash` — which is most
policy hooks — is invoked on every `read`, `grep`, `write`, and `edit` in the session and
must open with `if (input.name !== 'bash') return { kind: 'allow' };`.

Every first-party hook here begins with a guard like that. It is harmless individually
and it is the hot path: the hook is `await`ed inside `dispatchToolCall`, so with ten
policy plugins installed a session pays ten guest round-trips per tool call to have nine
of them immediately return `allow`.

The manifest already has the natural place to fix this. `contributes.hooks[]` entries
could carry a `tools: ["bash"]` or `paths: ["**/*.yml"]` filter that the host applies
before dispatching to the guest — declarative, checkable at load, and it would let the
host skip the guest call entirely. There is no such field.

**Cost accepted here:** a redundant guard clause in six plugins, and a latency profile
that gets worse linearly with the number of installed policy plugins.

---

## 3. The spec gives no entry shape for four of the six surfaces

`docs/plugins/spec.md`'s manifest example is:

```jsonc
"contributes": {
  "tools":            [ /* MCP servers — surface 1 */ ],
  "contextProviders": [ /* surface 2 */ ],
  "commands":         [ /* surface 3 */ ],
  "hooks":            [ /* surface 4 */ ],
  "agents":           [ /* surface 5 */ ],
  "ui":               [ /* surface 6, surface-specific */ ]
}
```

Only `tools` and `contextProviders` are given a worked example anywhere in the document.
For `commands`, `hooks`, `agents`, and `ui` the manifest shows a comment where the entry
shape should be. Every one of these plugins was written against
`packages/plugin-sdk/src/manifest.ts` instead, because it is the only place the shapes
exist.

`hooks` is the one where that gap has teeth. The spec's example is:

```jsonc
{ "event": "edit.pre", "module": "hooks/policy.wasm", "timeoutMs": 500 }
```

The SDK requires a `runtime` field for anything it cannot infer, and — critically —
refuses `runtime: "js"` unless the host passes `allowUnsandboxedJs`. Since the SDK ships
no WASM runtime, **every procedural plugin that can actually run today needs a host flag
the spec never mentions.** A plugin author following the spec writes a manifest naming a
`.wasm` module they have no toolchain to produce, and the failure they hit is
`module-unloadable` from a runtime that does not exist.

The SDK is honest about this in its own header comments. The spec is not.

---

## 4. `edit.post` cannot inject anything, which rules out a whole class of plugin

The spec's table gives `edit.post` the row "Notify, log, run a formatter" and a `May
return` column of "—". The SDK implements that exactly: `fireNotification` invokes the
hook and discards whatever it returns.

The plugin this blocks is `docs-sync`: notice that a public API file changed, and remind
the model to update the documentation. The reminder has to reach the model, and there is
no output shape on any post-event that reaches the model. `inject` exists, but only
`session.start`, `session.turnStart`, `context.pre`, and `session.compact` honour it —
all of which fire before the edit that would trigger the reminder.

The available workarounds are all wrong in a specific way:

- `session.turnStart` `inject` fires before the edit, so it cannot know about it.
- `edit.pre` `deny` would block the edit rather than annotate it, turning a reminder into
  a refusal.
- A `tool.post` `replace` on the edit tool's own output *would* reach the model, but it
  rewrites the tool result the model is reading, which means lying to the model about
  what the tool said in order to append a note.

So `adze.docs-sync` shipped as a slash command and a subagent instead — both of which
work, and neither of which is automatic. The plugin a team actually wants here is the
automatic one.

**Suggested fix:** let `edit.post` and `session.turnEnd` return `inject`. A post-event
that can add context but cannot veto is not a permission boundary, so it does not
reintroduce the fail-open/fail-closed argument that governs the `pre` events.

---

## 5. Only context-provider triggers are checked for collisions

`loadPlugins` refuses a duplicate plugin id, and `buildContextProviders` reports a
duplicate `@trigger` and lets the first loaded provider win. Both are right.

Nothing checks **slash command names or subagent names across plugins.** Two plugins can
each contribute a command called `review`, both load with no diagnostic, and which one
`/review` invokes depends on load order. This is not hypothetical in this repository:
`plugins/acme-adr-context` (the spec's example fixture) contributes `review`, and
`adze.review` had to be given the command name `review-diff` to stay out of its way.

Trigger collisions are reported because `buildContextProviders` is the single funnel every
provider passes through. Commands and agents have no equivalent funnel — the loader
returns them per plugin and nothing merges them — so there is no place the check would
naturally live. That is the actual defect: the SDK has no registry for commands and
agents, so a surface assembling them has to dedupe for itself and none of them will do it
the same way.

---

## 6. A `type: "wasm"` context provider will run as unsandboxed JavaScript

In `collectContextProviders`, a provider with `type: "wasm"` resolves its runtime with
`resolveRuntime(contribution.module, undefined)` — inferring from the file extension,
with no declared runtime to override it. So a manifest entry reading
`{ "type": "wasm", "module": "providers/jira.mjs" }` loads through the **JS** runtime and
runs unsandboxed in the Adze process.

The `allowUnsandboxedJs` opt-in does still gate it, so this is not an escape from the
security model. But the discriminant is named `wasm`, the spec describes surface 2's
procedural form as WASM, and a reviewer reading `"type": "wasm"` in a manifest would
reasonably conclude the module is sandboxed. Unlike `contributes.hooks[]`, a context
provider has no `runtime` field to state the truth in.

**Suggested fix:** rename the discriminant to `procedural`, or require
`type: "wasm"` to have a `.wasm` module and error otherwise.

---

## 7. Surface 1 is not exercised by any first-party plugin, deliberately

`contributes.tools` is declaratively complete and `translateToolContribution` works. No
plugin here uses it, and the reason is worth recording rather than leaving as an
omission.

Every MCP server this repository could point a first-party plugin at is either fetched
from the network on first run (`npx -y @some/mcp-server`, which would make an
"install this plugin" instruction into an outbound fetch) or is a server this repository
does not ship. Contributing a manifest entry nobody has ever started would be exactly the
thing the honesty rules forbid: a surface described as working on the strength of a
manifest that parsed.

So surface 1 is listed here as untested by these plugins rather than covered by a fixture
that proves only that JSON validates.

---

## 8. Smaller things

- **`permissions` has no way to say "reads the text it is given and nothing else".** Every
  hook plugin here declares `filesystem: "none"`, which is accurate, and there is no way
  to express the more useful statement: this hook is a pure function of its payload. The
  distinction matters because `filesystem: "none"` is also what a plugin that *wants*
  filesystem access but forgot to ask for it looks like.
- **`engines.adze` cannot express "any pre-1.0".** Every manifest here says
  `>=0.0.1 <1.0.0`, which is fine, but the spec's own example is `>=0.4.0 <2.0.0` against
  an engine at `0.0.1`, so copying the spec's manifest verbatim produces
  `engine-mismatch` and a plugin that will not load. The example should match the engine
  the reader has.
- **A slash command's `!` blocks fail the whole command when no runner is supplied.** This
  is the right call and it is undocumented: `docs/plugins/spec.md` says `!` is
  "gate-checked like any tool call" and does not say the command is refused outright
  without a runner. A surface that forgets to wire `runCommand` gets a refusal naming
  `frontmatter-invalid`, which is not where the author will look.
- **Front matter forbids a nested block mapping, so `model:` must be inline.** The spec
  writes `model: { prefer: reasoning }`, which works. The ordinary YAML form
  (`model:` then an indented `prefer: reasoning`) is a parse error. That is a defensible
  and deliberate restriction — `packages/plugin-sdk/src/frontmatter.ts` explains why a
  full YAML parser is a security problem on this path — but the spec presents inline
  mapping as a style choice rather than the only accepted form.
