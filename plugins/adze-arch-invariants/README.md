# Architecture Invariants

**Denies an edit that would violate the package dependency graph or make the engine render
output.**

Surfaces used: **hooks** (`edit.pre`, `tool.pre`).

## What it does

`docs/architecture/README.md` draws this graph and `CONTRIBUTING.md` lists the rules a
review will enforce:

```
protocol → core → sdk → surfaces
providers, apply, retrieval, sandbox, mcp, plugin-sdk → core
```

Each rule below is one of those, restated as a check on an import specifier in added text.

| Rule | Denies |
| --- | --- |
| The engine renders nothing | `packages/core` or `packages/protocol` importing `@adze/cli`, `@adze/vscode`, `@adze/ide`, or `@adze/hub` |
| The graph runs one way | `packages/core` importing `@adze/sdk` |
| A contract has no dependencies | `packages/protocol` importing anything but `zod`, `node:*`, or a relative path |
| Services stay swappable | `providers`, `apply`, `retrieval`, `sandbox`, `mcp` importing each other |
| Benchmarks do not influence the product | anything outside `bench/` importing from `bench/` |
| The SDK is for surfaces | `@adze/sdk` imported from anywhere but `apps/`, `examples/`, `packages/cli`, `packages/ide`, or `packages/sdk` itself |
| The engine emits no display output | `packages/core` or `packages/protocol` importing `chalk`, `picocolors`, `kleur`, `ansi-colors`, `colorette`, or `cli-color`, or adding a terminal escape sequence |

## Why it exists

This is the most mechanical policy in this directory and the one whose violations are
hardest to catch at review. A single wrong import compiles, passes every test, and is only
visible to someone holding the whole dependency graph in their head. Three months later the
graph in the architecture document and the graph in the code have diverged, and nobody can
say when.

It is also a direct demonstration of what ADR-0008 claims a deny-capable hook is for. None
of these rules is something `@adze/core` should know about — they are this project's
architecture, not the engine's. A different project embedding the engine has a different
graph and would write a different version of this file.

## Why a hook and not a lint rule

A lint rule would be better in most ways, and it runs after the edit.

This runs before it, which matters for one specific reason. When a model discovers it needs
something from a package it is not allowed to import, the useful moment to intervene is
while it is still deciding how to get it. A denial at that point — naming the rule and the
correct route, which is usually "add a message to `@adze/protocol`" or "put the shared thing
in core" — is one round of feedback. A lint failure ten minutes later is a debugging session
against code that has already been written around the wrong import, and the cheapest fix at
that point is usually to suppress the rule.

The two are complementary rather than alternatives. A lint rule catches what is in the tree;
this catches what is about to enter it.

## Scope: added text only

The hook receives the `replace` side of an edit, so it judges what is being added. A
violation already in the file is invisible to it.

That is the correct scope for a pre-edit gate. Refusing an edit because of a line the edit
does not touch would make a file unmaintainable until someone fixed an unrelated problem
first, and the person hitting the denial is rarely the person who introduced the violation.

Only source files are checked (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`,
`.cjs`). A markdown file containing `import { Engine } from '@adze/cli'` is documentation,
and this repository's documentation quotes forbidden imports in order to explain why they
are forbidden.

## What it does not catch

- **A violation reached through a re-export.** If `@adze/core` imports `@adze/apply` and
  `@adze/apply` re-exports something from a surface, the specifier in core's file is
  permitted. Checking that needs the module graph, which a hook seeing one edit does not
  have.
- **`console.log` in the engine.** Biome's `noConsole` rule already covers it, and
  duplicating a lint rule inside a policy hook means two places to update when the rule
  changes.
- **A dynamic specifier.** `import(someVariable)` is not a string literal and is not
  matched.
- **Whether a new package belongs in the graph at all.** That is an ADR question.

## Installing

```bash
adze plugin dev ./plugins/adze-arch-invariants
```

`runtime: "js"`, therefore **unsandboxed**; the host must pass `allowUnsandboxedJs`.

## Tests

`plugins/test/arch-invariants.test.ts` drives each rule through `dispatchToolCall` from
`@adze/core`, including the cases that must not deny: a relative import inside the
protocol, a service importing core, a markdown file quoting a forbidden import, and
`packages/cli` importing the SDK legitimately.
