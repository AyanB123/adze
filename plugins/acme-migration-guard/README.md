# Migration Guard

A plugin with a **deny-capable hook**: it stops the agent from writing a database
migration without human review, and it rewrites `npm run` invocations to `pnpm`.

This is the case ADR-0008 makes for surface 4. The policy is eleven lines in
`hooks/policy.mjs`. Expressing the same rule without hooks would mean either waiting
for Adze to ship a configurable policy engine, or forking Adze.

## It is unsandboxed, and it says so

The manifest declares `"runtime": "js"`, which means the hook is imported into the
Adze process and runs with full privileges. A host must pass `allowUnsandboxedJs` to
load it. `@adze/plugin-sdk` treats a JavaScript hook exactly like a native one for
this purpose, even though `docs/plugins/spec.md` only labels native plugins as
unsandboxed — an in-process ES module has the same exposure, and the spec's silence on
it is one of the gaps reported in `packages/plugin-sdk/README.md`.

A published plugin would compile the same two functions to `wasm32-wasip2` and need no
flag. Adze does not ship a WASM runtime yet, so this plugin uses the path that
actually works and labels it accurately.

## What writing it found

**`approved_by_human` cannot be answered by the engine.** The spec's own `edit.pre`
example branches on `!ctx.approved_by_human`, but hooks fire *before* the permission
gate — deliberately, so a plugin can veto without the user being prompted for
something local policy already forbids. So at `edit.pre` time nobody has approved
anything, and the field can only be supplied by the host from an out-of-band signal.
It defaults to `false`, which is the direction that makes this policy hold.

**`edit.pre` sees the proposed edit, not the applied one.** `@adze/core`'s edit tool
applies and writes inside a single `execute` with no interior hook point, so
`edit.pre` is derived from `tool.pre` at dispatch. This policy only needs the path, so
it is unaffected; a hook wanting the applier's resolved match locations cannot have
them.

**Two hooks in one module is not describable in the spec.** Both entries point at
`hooks/policy.mjs`, and the SDK dispatches on an export name defaulting to the event
name. The spec shows one module per hook and never says how a module offering several
hooks is addressed.
