# Decision Record Context

**Exposes this repository's architecture decision records, invariants, benchmark policy,
and governance documents behind `@`-triggers, and drafts a new ADR.**

Surfaces used: **context providers** (five, all declarative), **slash commands**
(`/adr-new`).

## What it does

| Trigger | Pulls in |
| --- | --- |
| `@adr` | `docs/architecture/adr/**/*.md` — every decision record |
| `@invariants` | `docs/architecture/*.md` and `CONTRIBUTING.md` — the package graph and the rules reviews enforce |
| `@bench-policy` | `docs/benchmarks/**/*.md` and ADR-0011 — what may be published as a benchmark claim |
| `@governance` | `GOVERNANCE.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` |
| `@plugin-spec` | `docs/plugins/**/*.md` and ADR-0008 |

`/adr-new` drafts a record in the house format, and first decides whether one is warranted
at all.

## Why it exists

An agent that does not know a project's decisions re-derives them, and re-derives them
differently each time. The specific failures this prevents are the ones that look like
competence: proposing a CLA because it is the conventional way to handle contributor
copyright, when `GOVERNANCE.md` explains at length why this project will never have one;
adding a policy feature to the engine when ADR-0008 says policy belongs in a plugin;
claiming a two-point benchmark lead when `docs/benchmarks/strategy.md` forbids claiming a
win inside three.

None of that is retrievable by keyword. The reasoning lives in prose in a specific set of
files, and `@adr` is how a prompt says "consult it".

## Zero executable code

This plugin is a manifest and one markdown file. That is the claim ADR-0008 makes about
most plugins and it holds here completely — five context providers and a slash command,
no build step, no WASM toolchain, nothing to review for security beyond the globs
themselves.

It is also the reason `permissions.filesystem` is `read` rather than `none`: a glob
provider does read files, and the manifest says so. The loader turns that declaration into
a warning at install time for `workspace-write` and reports network hosts individually, so
a plugin asking for more than it needs is visible at the moment a user decides.

## Trigger collision with the example fixture

`plugins/acme-adr-context` — the fixture that ships with the spec — also claims `@adr`.
When both are loaded, `buildContextProviders` reports a warning and **the first one loaded
wins**; the later provider is inactive.

That is the documented behaviour and it is the right default, since silently merging two
providers' output would make a prompt's meaning depend on load order. It is left in place
rather than worked around because it is a real property a plugin author should know about,
and `plugins/test/adr-context.test.ts` asserts it explicitly.

The same protection does not exist for slash commands or subagents. See
[FINDINGS.md](../FINDINGS.md#5-only-context-provider-triggers-are-checked-for-collisions).

## Byte budgets are deliberate

`@adr` gets 128 KiB; the others get 64 KiB. The default is 64 KiB, and the ADR set is
larger than that — twelve records plus a README.

A provider that exceeds its budget is **truncated, and reports that it was**. It is not an
error and it is not silent. The consequence is worth stating: `@adr` on a repository with
many more records than this one would deliver a prefix of them, sorted by path, so the
lower-numbered records win. Sorting is what makes it deterministic rather than
arbitrary — the same workspace produces the same context every time, which matters because
an unstable provider is a cache miss on every turn.

If you need a specific record, read it by path. `@adr` is for "consult the decisions",
not for "load the corpus".

## Installing

```bash
adze plugin dev ./plugins/adze-adr-context
```

No flags. There is no procedural code, so there is nothing to opt in to — which is the
whole argument for declarative plugins.

## Tests

`plugins/test/adr-context.test.ts` loads the manifest, builds all five providers through
`buildContextProviders`, resolves them against an in-memory filesystem, and checks the
patterns match the paths this repository actually has. It also asserts the truncation
report fires when a provider exceeds its budget, and the trigger-collision warning when
loaded beside the fixture.
