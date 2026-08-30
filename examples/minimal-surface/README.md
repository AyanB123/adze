# minimal-surface

A complete Adze surface in one file, built on `@adze/sdk` and nothing else.

This example exists to answer a specific question that
[ADR-0001](../../docs/architecture/adr/0001-engine-first-architecture.md) stakes the
whole project on: *can someone outside the project build a real surface on the engine?*
The ADR names that as its success signal. So this file imports only `@adze/sdk`,
renders the event stream itself, and sets its own approval policy — it reaches into no
engine internal and needed no cooperation from us to exist.

It runs **offline**: no API key, no network call, no cost.

## Run it

```bash
pnpm install          # once, from the repository root
pnpm --filter @adze/example-minimal-surface build
pnpm --filter @adze/example-minimal-surface start
```

Or from this directory: `pnpm build && pnpm start`.

## What you will see

```
engine @adze/core@0.0.1 · protocol 0.1
! [no-os-sandbox] broker 'null' provides no OS-level containment on win32. The permission gate and approval policy still apply, but an approved command runs unconfined.

> turn turn_mtfbfd5826x2wu · offline-demo · cache epoch 0
  ~ 0 of 800 prompt tokens cached
  + todo {"items":[{"id":"1","content":"Remove build/","status":"in-progress"}]}
  · [in-progress] Remove build/
  = ok
  ~ 800 of 1660 prompt tokens cached

  ? bash — run: bash -lc rm -rf build; read: /path/to/examples/minimal-surface
    why:  running a command needs approval: sandbox mode 'read-only' has no OS-level containment on this platform, so nothing would confine it
    argv: ["bash","-lc","rm -rf build"]
    ->    deny (read-only surface; return 'allow-once' to permit it)
  x denied by gate: the user denied this action (read-only surface)
I was not allowed to run that, so the plan stands.
  ~ 1600 of 2550 prompt tokens cached
< end-turn after 3 step(s)
  tokens: 950 in / 1600 cached / 60 out
  cache hit rate: 62.7%
  cost: 0.004230 USD
```

Exit code is `0` only when the turn reached `end-turn`.

Five things in that transcript are worth pointing at, because each is a property of
the architecture rather than of this file.

**The warning comes first.** `no-os-sandbox` is printed before the turn, not after. On
every platform today there is no OS-level containment: the permission gate decides
*whether* a command runs and nothing constrains what it touches once it does. A user
about to approve a command needs that fact before deciding, not in a footnote.

**The approval request is actionable.** It carries a one-line summary, the rule that
triggered it, and the exact argv that would run — not the string the model wrote. A
surface that displayed the model's string would be asking for consent to something
else.

**A denial is not a failure.** `tool.denied` is a distinct event from `tool.finished`
with `ok: false`. The turn continues, the model adapts, and the run ends `end-turn`.
Conflating the two would let a denied action appear in a trajectory as an execution.

**The cache split is reported.** The token counts here are scripted, not measured, but
their shape is the point: a cold first step, then the frozen epoch prefix served from
cache. Cache economics move effective cost by more than 10×, which is why the hit rate
is a first-class number rather than something a surface derives.

**Nothing can touch your machine.** `commandExecution: 'disabled'` means no subprocess
can start, and the scripted provider makes no network call.

## The five pieces of a surface

Read `src/main.ts` top to bottom; it is the whole thing.

1. **Configure a client** — `createClient({ workspaceRoot, provider, model, sandbox, approvals, onApprovalRequest })`. Synchronous.
2. **Render the warnings** — `client.warnings`, before anything else happens.
3. **Subscribe** — `session.subscribe(render)`. The `switch` over `AdzeEvent` is the
   surface's real job. The engine emits structured data and has no opinion about
   display, which is what lets one engine serve a CLI, an editor extension, and a
   daemon without becoming three products.
4. **Run a turn** — `session.run({ prompt, budget })`, or `session.submit()` for a
   handle you can `cancel()`.
5. **Dispose** — `client.dispose()` closes sessions, cancels turns in flight, and drops
   listeners.

## Using a real model

Two changes. Add `@adze/providers` and swap the provider:

```ts
import { createGateway } from '@adze/providers';

const { gateway, model } = createGateway({
  cwd: process.cwd(),
  modelRef: 'anthropic/claude-sonnet-4-5',
});

const client = createClient({
  workspaceRoot: process.cwd(),
  provider: gateway,
  model,
  sandbox: { mode: 'workspace-write' },
  approvals: 'on-request',
  onApprovalRequest: decide,
  // Removed, so commands actually run.
});
```

Then set a credential — `ANTHROPIC_API_KEY`, or `~/.adze/providers.json` — and drop
`commandExecution: 'disabled'`.

Read `decide()` before you do. It denies everything. Returning
`{ decision: 'allow-once' }` lets the model run the command it asked for, and with no
OS sandbox on any platform yet, an approval should be treated as equivalent to running
the command yourself.

## Where to go next

- [`packages/sdk/README.md`](../../packages/sdk/README.md) — the full API, and the list
  of types that arguably belong in `@adze/protocol`.
- [ADR-0001](../../docs/architecture/adr/0001-engine-first-architecture.md) — why the
  engine is the product and surfaces are distribution.
- [ADR-0007](../../docs/architecture/adr/0007-sandbox-and-permissions.md) — the two-axis
  permission model, and what is and is not enforced today.
