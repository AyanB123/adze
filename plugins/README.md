# Plugins

Eight first-party plugins, plus the two `acme.*` example fixtures that ship with
[the spec](../docs/plugins/spec.md).

A plugin is a directory containing `adze.plugin.json`. That is the whole requirement — six of
the eight below contain no executable code at all.

**Read [FINDINGS.md](FINDINGS.md) first if you are working on the SDK.** It records the places
`docs/plugins/spec.md` or `packages/plugin-sdk` turned out to be wrong, ambiguous, or
insufficient, found by building these. ADR-0008 published the spec before the implementation
for exactly that purpose, and `CONTRIBUTING.md` calls a report like it the feedback the project
most needs.

## The set

| Plugin | Does | Surfaces |
| --- | --- | --- |
| [`adze-secrets-guard`](adze-secrets-guard/) | denies writing anything that looks like a credential; denies unreviewed CI workflow edits | hooks |
| [`adze-commit-conventions`](adze-commit-conventions/) | denies a commit without a DCO sign-off or a Conventional Commit subject; denies history rewrites; drafts the message | hooks, commands |
| [`adze-license-gate`](adze-license-gate/) | denies a dependency under a copyleft or source-available licence, or added outside the version catalog | hooks |
| [`adze-arch-invariants`](adze-arch-invariants/) | denies an import that violates the package dependency graph, or output rendering in the engine | hooks |
| [`adze-adr-context`](adze-adr-context/) | exposes decision records, invariants, benchmark policy, and governance behind `@`-triggers | context providers, commands |
| [`adze-review`](adze-review/) | read-only subagents that audit a diff, an apply failure, or a benchmark report | subagents, commands, UI |
| [`adze-test-first`](adze-test-first/) | write-a-failing-test-then-fix as a first-class workflow; turns a model failure into a permanent case | commands |
| [`adze-docs-sync`](adze-docs-sync/) | finds documentation the code has outgrown, in both directions | commands, subagents |

## Surface coverage

| # | Surface | Covered by | Status |
| --- | --- | --- | --- |
| 1 | Tools (MCP) | — | **deliberately not covered.** [Why](FINDINGS.md#7-surface-1-is-not-exercised-by-any-first-party-plugin-deliberately) |
| 2 | Context providers | `adr-context` | five glob providers, resolved against a filesystem in tests |
| 3 | Slash commands | `commit-conventions`, `test-first`, `review`, `docs-sync`, `adr-context` | eight commands |
| 4 | Hooks | `secrets-guard`, `commit-conventions`, `license-gate`, `arch-invariants` | seven hook registrations across `edit.pre` and `tool.pre`; every denial tested through core's dispatcher |
| 5 | Subagents | `review`, `docs-sync` | four, all read-only, narrowing asserted from the widening direction |
| 6 | UI | `review` | one contribution, **refused by the engine** and available to the surface only — which is the behaviour being demonstrated |

## Installing one

```bash
adze plugin dev ./plugins/adze-secrets-guard
```

The four hook plugins declare `runtime: "js"`, which is **unsandboxed** — an ES module imported
into the Adze process has the engine's full privileges — so a host must opt in with
`allowUnsandboxedJs`. That is not a statement that these plugins are trusted; it is the honest
state of the SDK, which ships the `wasm32-wasip2` host interface and no WASM runtime. A
published build would compile to WebAssembly and need no flag.

The four declarative plugins need no flags at all.

## Running the tests

`plugins/` is deliberately **not** a workspace package. A plugin is a directory containing a
manifest and nothing more, and adding a `package.json` to make an import specifier look tidier
would mean the fixtures were no longer shaped like the thing they test. So the tests import
`@adze/core` and `@adze/plugin-sdk` by path.

From this directory:

```
node ../node_modules/vitest/vitest.mjs run
node ../node_modules/@biomejs/biome/bin/biome check .
```

201 tests across eight files. No test touches the network, spawns a process, or needs a model
key.

Every denial is driven through `dispatchToolCall` from `@adze/core` with a real `HookBus`,
`PermissionGate`, and `ToolRegistry`. The spy tools declare no effects, so the gate has nothing
it could refuse and a `denied` outcome can only have come from the plugin under test. A mock
dispatcher would prove that a hook returns `deny` — the half that cannot be wrong. What needed
proving is that `deny` stops the call, and that is a fact about core's dispatch order.

`test/all-plugins.test.ts` is the sweep: it discovers plugin directories by looking for
`adze.plugin.json`, loads every one, and asserts the properties that should hold across the set
— no network permission, no `workspace-write`, no UI reaching the engine, every hook refused
when the host has not opted in, and every plugin refused against an engine version outside its
declared range. A ninth plugin added later is covered the moment it exists.

## Writing your own

Start from `docs/plugins/spec.md`, then read `packages/plugin-sdk/src/manifest.ts` — the spec
shows a comment where four of the six contribution shapes should be, so the implementation is
where they actually are. `FINDINGS.md` lists the walls the eight above ran into.

If you hit one that is not there, that is the bug report the project most wants.
