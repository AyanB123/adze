# Plugins

A plugin is a directory containing a file called `adze.plugin.json`. That is the whole
requirement — six of the eight first-party plugins contain no executable code at all.

This guide covers what is in `plugins/` today, how to load one, and how to write your
own. The full six-surface reference is [docs/plugins/spec.md](../plugins/spec.md); the
reasoning is [ADR-0008](../architecture/adr/0008-plugin-architecture.md).

> [!IMPORTANT]
> **There is no way to install a plugin from the CLI.** `plugins/README.md` shows
> `adze plugin dev ./plugins/adze-secrets-guard`, and that command does not exist:
>
> ```console
> $ node packages/cli/bin/adze.mjs plugin dev ./plugins/adze-secrets-guard
> error: unknown command 'plugin'
> (add --help for usage)
> ```
>
> Exit code `2`. `adze plugin dev` is a milestone M3 deliverable in
> [the roadmap](../roadmap.md), listed under `@adze/plugin-sdk` alongside "manifest
> schema, authoring types, `adze plugin dev` with local override".
>
> What works today is loading plugins **programmatically** through
> `@adze/plugin-sdk`, which is shown below and was verified against all eight
> first-party plugins. If you are writing a plugin, that is your test harness. If you
> want to *use* a plugin from the `adze` command, wait for M3.

## What is actually in `plugins/`

Eight first-party plugins, plus two `acme.*` fixtures that ship with the spec.

| Plugin | What it does | Surfaces used |
| --- | --- | --- |
| `adze-secrets-guard` | denies writing anything that looks like a credential; denies unreviewed CI workflow edits | hooks (2) |
| `adze-commit-conventions` | denies a commit without a DCO sign-off or a Conventional Commit subject; denies history rewrites; drafts the message | hooks (1), commands (2) |
| `adze-license-gate` | denies a dependency under a copyleft or source-available licence, or added outside the version catalog | hooks (2) |
| `adze-arch-invariants` | denies an import that violates the package dependency graph, or output rendering in the engine | hooks (2) |
| `adze-adr-context` | exposes decision records, invariants, benchmark policy, and governance behind `@`-triggers | context providers (5), commands (1) |
| `adze-review` | read-only subagents that audit a diff, an apply failure, or a benchmark report | commands (1), subagents (3) |
| `adze-test-first` | write-a-failing-test-then-fix as a first-class workflow | commands (3) |
| `adze-docs-sync` | finds documentation the code has outgrown, in both directions | commands (1), subagents (1) |

The contribution counts in that table are not from the README; they are what
`loadPlugins` actually returned:

```console
$ node load-plugins.mjs
loaded 8 of 8 plugin directories
  adze.adr-context           context:5  commands:1
  adze.arch-invariants       hooks:2
  adze.commit-conventions    commands:2  hooks:1
  adze.docs-sync             commands:1  subagents:1
  adze.license-gate          hooks:2
  adze.review                commands:1  subagents:3
  adze.secrets-guard         hooks:2
  adze.test-first            commands:3
diagnostics: 0
hook host built: true
```

**Surface 1 (tools, via MCP) is not exercised by any first-party plugin, and that is
deliberate** — the reasoning is in
[plugins/FINDINGS.md](../../plugins/FINDINGS.md#7-surface-1-is-not-exercised-by-any-first-party-plugin-deliberately).
Surface 6 (UI) is exercised by exactly one contribution in `adze-review`, and the
engine **refuses** it: UI reaches the surface and never the engine, which is the
architecture invariant being demonstrated rather than a limitation.

**Read [plugins/FINDINGS.md](../../plugins/FINDINGS.md) before you write a plugin.**
It records nine places where the spec or the SDK turned out to be wrong, ambiguous, or
insufficient, found by building these eight. ADR-0008 published the spec before the
implementation for exactly that purpose. Two findings will affect you directly:
`edit.pre` cannot see the content of a whole-file write, and hook events cannot be
scoped to a tool, so every hook runs on every call.

## Loading a plugin today

`loadPlugins` takes a list of plugin directories and returns a loaded set. This script
was run from the repository root:

```js
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hookHostFor, jsModuleRuntime, loadPlugins } from './packages/plugin-sdk/dist/index.js';

const root = resolve('plugins');
const dirs = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith('adze-'))
  .map((e) => join(root, e.name));

const set = await loadPlugins(dirs, {
  engineVersion: '0.0.1',
  jsRuntime: jsModuleRuntime({ allowedRoots: [root] }),
  allowUnsandboxedJs: true,
  claimedNamespaces: ['adze'],
});

for (const p of set.plugins) console.log(p.manifest.id, p.hooks?.length ?? 0);
const host = hookHostFor(set.plugins);
```

Four options matter:

| Option | Why |
| --- | --- |
| `engineVersion` | checked against each manifest's `engines.adze` range. A plugin outside its declared range is refused. |
| `jsRuntime` | supply `jsModuleRuntime({ allowedRoots })` to permit JS hook modules under those roots |
| `allowUnsandboxedJs` | the explicit opt-in described below. Without it, a JS-runtime plugin does not load. |
| `claimedNamespaces` | id prefixes the host claims as first-party |

The returned set is `{ plugins, failures, notices }`. Note the shape — the failures do
**not** appear on a top-level `diagnostics` field, they are nested per failed
directory as `failures[].diagnostics`. Reading `set.diagnostics` gives you `undefined`
and a false sense that nothing went wrong.

### The unsandboxed-JS opt-in is real, and it fails closed

Four of the eight plugins declare `"runtime": "js"` for their hooks. A JS hook is an
ES module imported into the Adze process, so it has the engine's full privileges —
there is no sandbox around it. The host must therefore opt in with
`allowUnsandboxedJs`. Drop that flag and the plugin does not load:

```console
$ node no-optin.mjs
{
  "plugins": [],
  "failures": [
    {
      "root": "...\\plugins\\adze-secrets-guard",
      "diagnostics": [
        {
          "severity": "error",
          "code": "native-not-permitted",
          "field": "contributes.hooks[0]",
          "message": "plugin 'adze.secrets-guard' contributes.hooks[0] is a JavaScript module. Importing it runs its code in the Adze process with no sandbox — the same exposure as a native plugin, so it carries the same requirement. Set allowUnsandboxedJs to opt in, or ship the hook as wasm32-wasip2."
        },
        ...
      ]
    }
  ],
  "notices": []
}
```

That flag is not a statement that the first-party plugins are trusted. It is the
honest state of the SDK, which ships the `wasm32-wasip2` host interface and no WASM
runtime. A plugin compiled to WebAssembly would need no flag. The four declarative
plugins need no flags at all, because there is no code to run.

## The deny-capable hook

This is the surface worth understanding first, because it is what lets a team encode
policy without forking Adze. A hook on `tool.pre` or `edit.pre` can return
`{ kind: 'deny', reason }`, and the call does not happen.

Verified against `adze-secrets-guard`:

```console
$ node deny-demo.mjs
hooks registered: 2  (tool.pre: 1, edit.pre: 1)

write a plain source file
  decision: allow

write a file containing an OpenAI-shaped key
  decision: deny
  plugin:   adze.secrets-guard
  reason:   this would write an OpenAI-style API key into '.env'. A credential
            committed to a repository is compromised the moment it is pushed, and
            rewriting history does not un-leak it (policy: adze.secrets-guard).
            Read the value from an environment variable at runtime and document the
            variable name instead. If this is a deliberate test fixture, put the
            marker 'adze:allow-secret' on that line so the exemption is visible in
            the diff.
```

Five properties of that denial are worth copying when you write your own:

**The reason is written for a model to read and retry against.** It says what was
wrong, why it matters, what to do instead, and how to declare a deliberate exception.
One round of actionable feedback is the highest-value intervention in the agent loop;
`denied` on its own wastes a step.

**First denial wins and short-circuits.** Remaining hooks on that event do not run.

**Modifications chain, denials do not.** A hook can return `{ kind: 'modify' }` and the
next hook sees the arguments the previous one produced, which lets a normalizing hook
and a policy hook compose without knowing about each other. If a later hook then
denies, every discarded modification is recorded as `modification-discarded` so a
rewrite that got thrown away is visible rather than silent.

**A hook that fails can be configured to deny.** With the host set to deny on hook
failure, a policy hook that times out or throws produces a denial naming the plugin
and saying the host is configured that way — a policy that silently stops being
enforced is worse than one that blocks.

**Every hook has a timeout.** `timeoutMs` is per contribution, and the host sums them
per event to size the engine's budget, so a slow hook cannot stall a turn
indefinitely.

Nine hook events exist: `session.start`, `session.turnStart`, `context.pre`,
`tool.pre`, `tool.post`, `edit.pre`, `edit.post`, `session.compact`,
`session.turnEnd`. Only `tool.pre` and `edit.pre` can veto. `edit.post` cannot inject
anything, which rules out a whole class of plugin — finding 4 in `FINDINGS.md`.

## Writing a plugin

### The manifest

Required fields, from `packages/plugin-sdk/src/manifest.ts`:

| Field | Notes |
| --- | --- |
| `id` | namespaced, e.g. `acme.migration-guard` |
| `version` | semver |
| `displayName`, `description` | shown to a user |
| `license`, `repository` | required, not optional metadata |
| `engines.adze` | a semver range. Outside it, the plugin is refused rather than loaded and hoped for. |
| `contributes` | one or more of `tools`, `contextProviders`, `commands`, `hooks`, `agents`, `ui` |
| `permissions` | `filesystem`: `none` \| `read` \| `workspace-write`; `network`: a host list; `env`: a variable-name list |

Declare the narrowest permissions that work. `adze-secrets-guard` — a plugin whose
entire job is inspecting file writes — declares `"filesystem": "none"`, because it
reads the content out of the hook payload and never touches the disk itself.

### A declarative plugin, start to finish

This is all of `adze-adr-context`, which needs no code:

```json
{
  "$schema": "https://adze.dev/schema/plugin/v0.json",
  "id": "adze.adr-context",
  "version": "0.1.0",
  "displayName": "Decision Record Context",
  "description": "Exposes this repository's architecture decision records ... behind @-triggers.",
  "license": "Apache-2.0",
  "repository": "https://github.com/AyanB123/adze",
  "engines": { "adze": ">=0.0.1 <1.0.0" },
  "contributes": {
    "contextProviders": [
      {
        "type": "glob",
        "name": "adr",
        "patterns": ["docs/architecture/adr/**/*.md"],
        "trigger": "@adr",
        "maxBytes": 131072
      }
    ],
    "commands": [{ "path": "commands/adr-new.md" }]
  },
  "permissions": { "filesystem": "read" }
}
```

A `glob` context provider needs a `trigger`, a pattern list, and a `maxBytes` ceiling.
Context-provider triggers are the **only** contribution kind currently checked for
collisions between plugins — finding 5 in `FINDINGS.md` — so two plugins claiming the
same slash command will not be caught for you.

A slash command is a markdown file referenced by path. `adze-test-first` contributes
three of them and contains no code either.

### A hook plugin

Declare the event, the module, the runtime, and a timeout:

```json
"contributes": {
  "hooks": [
    { "event": "edit.pre", "module": "hooks/guard.mjs", "runtime": "js", "timeoutMs": 500 },
    { "event": "tool.pre", "module": "hooks/guard.mjs", "runtime": "js", "timeoutMs": 500 }
  ]
}
```

Registering both events for one guard is not redundancy. `edit.pre` carries
`edits: [{ search, replace }]`, which is everything for the `edit` tool and **nothing
for the `write` tool** — a whole-file write arrives as
`{ path, edits: [], wholeFile: true }`, so the bytes being written are not in the
payload at all. A guard that only registered `edit.pre` would block a credential added
by `edit` and wave through the same credential written by `write`, which is the worse
of the two because `write` replaces the whole file. The credential check therefore runs
on `tool.pre`, where `arguments.content` is a declared field, and that also covers
`bash` — `echo <key> > .env` leaks a credential without touching an edit tool.
Meanwhile `edit.pre` keeps the two things only it can do: the search/replace blocks,
and any rule needing `approvedByHuman`, a field `tool.pre` does not have.

The module exports a handler that receives the payload and returns a decision. Read
`plugins/adze-secrets-guard/hooks/guard.mjs` top to bottom; its header comment
explains each choice, including why its credential patterns are prefix-anchored and
length-checked. A guard that fires on the word "sk-" in prose gets uninstalled, and an
uninstalled guard denies nothing.

### Testing it

`plugins/` is deliberately **not** a workspace package. A plugin is a directory with a
manifest and nothing more, and adding a `package.json` to make an import specifier
look tidier would mean the fixtures were no longer shaped like the thing they test. So
the tests import `@adze/core` and `@adze/plugin-sdk` by path. From `plugins/`:

```bash
node ../node_modules/vitest/vitest.mjs run
node ../node_modules/@biomejs/biome/bin/biome check .
```

201 tests across eight files. No test touches the network, spawns a process, or needs
a model key.

Copy one property from how those tests are written: every denial is driven through
`dispatchToolCall` from `@adze/core` with a real `HookBus`, `PermissionGate`, and
`ToolRegistry`. The spy tools declare no effects, so the permission gate has nothing
it *could* refuse, which means a `denied` outcome can only have come from the plugin
under test. A mock dispatcher would prove that a hook returns `deny` — the half that
cannot be wrong. What needs proving is that `deny` stops the call, and that is a fact
about core's dispatch order.

`test/all-plugins.test.ts` is the sweep: it discovers plugin directories by looking
for `adze.plugin.json`, loads every one, and asserts properties that should hold
across the whole set — no network permission, no `workspace-write`, no UI reaching the
engine, every hook refused when the host has not opted in, and every plugin refused
against an engine version outside its declared range. A ninth plugin is covered the
moment it exists.

## Distribution

There is none yet, and that is a decision rather than an omission.

`apps/hub` — the plugin registry — is **intentionally empty** and stays that way until
roughly 20+ third-party plugins exist
([ADR-0008](../architecture/adr/0008-plugin-architecture.md), milestone M7). A
registry with nothing in it is worthless, and monetising the registry has a perfect
failure record in this category: it is what several of the projects in the
open-source AI coding graveyard bet on. When it exists it will be a git-index registry
before it is a service.

So today: clone the plugin directory, or vendor it into your repository, and load it
through `@adze/plugin-sdk`.

## If you hit a wall

That is the contribution the project most wants. The six surfaces were specified
before the registry existed precisely because the extension points cannot be validated
until real plugins run into their edges. Add your finding to
[plugins/FINDINGS.md](../../plugins/FINDINGS.md) or open an issue.

## Where to go next

- [docs/plugins/spec.md](../plugins/spec.md) — the full six-surface reference.
- [plugins/FINDINGS.md](../../plugins/FINDINGS.md) — nine ways the spec and SDK were
  wrong, found by building the eight above.
- [plugins/README.md](../../plugins/README.md) — the directory index. Its install
  command does not exist yet; see the note at the top of this guide.
- [ADR-0008](../architecture/adr/0008-plugin-architecture.md) — six surfaces, and why
  the registry comes last.
