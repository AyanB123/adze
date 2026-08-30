# `@adze/plugin-sdk`

The plugin manifest, the loader, and the six extension surfaces from
[ADR-0008](../../docs/architecture/adr/0008-plugin-architecture.md). Specification:
[docs/plugins/spec.md](../../docs/plugins/spec.md).

A plugin is a directory containing `adze.plugin.json`. Most plugins contain no
executable code: tool contributions, context providers, slash commands, and subagents
are declaration. Hooks are the exception, because a policy that cannot run code cannot
express policy.

## What is real, and what is a seam

Stated first, because the spec describes all six surfaces in the present tense and none
of them existed when it was written.

| Surface | State |
| --- | --- |
| 1 — Tools (MCP) | **Real.** Translated to `@adze/mcp`'s server config. MCP is not reimplemented here. |
| 2 — Context providers | **Real** for `type: "glob"`. A `type: "wasm"` provider needs a runtime this build does not have. |
| 3 — Slash commands | **Real**, including `!` and `@` interpolation. `!` requires a host-supplied, gate-checked command runner and is refused without one. |
| 4 — Hooks | **Real** for seven of nine events, wired to core's actual dispatch path. `edit.pre`/`edit.post` are derived from `tool.pre`/`tool.post`. `context.pre` and `session.compact` have no seam in core and do not fire. |
| 5 — Subagents | **Real.** Declaration plus narrowing that cannot widen. |
| 6 — UI | **Type only, by design.** The engine refuses UI contributions and throws if offered one. |
| WASM runtime | **Seam.** `wasm32-wasip2` is not implemented. The default runtime fails the plugin's load rather than loading it without the module. |

The one thing to take from that table: **a policy hook shipped as `.wasm` will not run in
this build**, and the plugin containing it refuses to load rather than loading without
it. Refusing is deliberate — a policy hook that silently does not run leaves a team
believing their rule is enforced.

## Nothing consumes this package yet

No surface imports it, and there is no `adze plugin add` or `adze plugin dev` command.
Wiring belongs in a surface, not here: `packages/cli` already depends on `@adze/core`
and is the layer permitted to know about every service package at once. Until that
exists, plugins load only when a host calls `loadPlugins` itself.

## Using it

```ts
import { hookHostFor, jsModuleRuntime, loadPlugins, toRegisteredHook } from '@adze/plugin-sdk';

const set = await loadPlugins([resolve('plugins/acme-migration-guard')], {
  engineVersion: '0.0.1',
  jsRuntime: jsModuleRuntime({ allowedRoots: [resolve('plugins')] }),
  allowUnsandboxedJs: true, // required: a JS module is not sandboxed
  claimedNamespaces: ['acme'],
});

const host = hookHostFor(set.plugins);
hookBus.register(toRegisteredHook({ host }));
```

A `tool.pre` or `edit.pre` denial now stops the call inside `dispatchToolCall`, before
the permission gate is consulted. `test/dispatch-deny.test.ts` asserts that against
core's real dispatcher rather than a stand-in, because the claim is about core's
ordering and only core's code can establish it.

Two worked examples live in [`plugins/`](../../plugins): a glob context provider with a
subagent and a slash command, and a deny-capable policy hook.

## Two timeout policies, in conflict

`packages/core`'s `HookBus.fireToolPre` **denies** when a hook does not answer; its
header argues that an unanswered veto is not consent. The spec requires the **opposite**
for plugin hooks — a timeout is an `allow`, logged loudly — because one plugin with a
slow network call would otherwise deny every tool call in the session, and the symptom
would look like an engine fault rather than a plugin fault.

`toRegisteredHook` resolves this by declaring a budget to core's bus larger than the sum
of the per-hook budgets it enforces itself, so core's fail-closed branch never fires
first. An operator who prefers core's behaviour passes `onFailure: 'deny'` to the
`HookHost`; this package refuses to make that choice on their behalf.

## Where the spec is wrong, ambiguous, or impossible

The spec was written before any implementation existed and asks for this list. Each
entry was found by trying to build the thing it describes.

1. **`edit.pre`'s own example cannot work as written.** It branches on
   `!ctx.approved_by_human`, but hooks run *before* the permission gate — that ordering
   is the point, so a plugin can veto without the user being prompted first. At
   `edit.pre` time nothing has been approved, so the field is `false` unless a host
   supplies an out-of-band signal. It is exposed as `approvedByHuman` and defaults to
   `false`, which is the direction that makes "migrations require review" hold rather
   than fail open.

2. **`edit.pre` cannot see what the spec implies it sees.** `core/src/tools/edit.ts`
   calls `applyEdit` and then `grant.writeFile` inside a single `execute` with no
   interior hook point, so there is no moment between "the edit is known" and "the file
   is written". Dispatch is the moment before both, so a hook sees the edit the model
   *proposed*, not the applier's resolved match locations.

3. **`edit.post` cannot report which tier applied an edit.** The structured
   `AppliedEdit` travels as a `ToolEmission` that never reaches the hook bus. A
   formatter hook works; an "audit every applied edit with its validator level" hook
   needs a core change.

4. **`context.pre` and `session.compact` have no seam at all.** The spec lists nine
   events; core's bus has four and two more are derivable. These two are neither.

5. **`tool.post`'s `modify` means something different from `tool.pre`'s.** The spec uses
   one word for two operations — rewriting *arguments* before a call and rewriting a
   *result* after one. They are split here as `modify` and `replace`, because a hook
   returning the wrong one should be told so rather than have it guessed at.

6. **A subagent cannot narrow `network` or `env` in front matter.** An inline mapping's
   values are scalars, so `permissions: { network: [a, b] }` parses as the string
   `'[a, b]'`, and the block form that would carry a list cannot nest under a mapping
   key. Both are refused with that reason rather than accepted and dropped. Only
   `filesystem` is narrowable in front matter. The spec's subagent example shows no
   `permissions` block at all, so this is a gap the spec does not acknowledge.

7. **`autoApprove` is a plugin declaring its own permission level.** The spec describes
   it as "read-only calls that skip prompting", which sits awkwardly with architecture
   invariant 4 — every tool call passes the permission gate, with no code path around
   it. It is carried through to the MCP config unchanged and *not* interpreted here; a
   host that honours it is making that decision, and it should be a user-side allowlist
   rather than a manifest-side one. Unresolved.

8. **`EngineCapabilities` has no plugin flag.** A surface cannot ask the engine whether
   plugins loaded or how many hooks are active, so it cannot tell a user that a policy
   is in force. By architecture invariant 2 that is a missing protocol message, not
   something to work around per surface.

9. **Unicode scanning is specified as a *build* failure; it is implemented as a *load*
   failure too.** The spec's framing is about a registry that does not exist yet.
   Scanning at load defends the user rather than the index, so it runs on manifest bytes
   before JSON parsing, and on every JavaScript module and markdown file.

## Verifying

From inside this directory, without a workspace-wide command:

```
node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node ../../node_modules/vitest/vitest.mjs run
node ../../node_modules/typescript/bin/tsc -p tsconfig.build.json
node ../../node_modules/@biomejs/biome/bin/biome check .
```
