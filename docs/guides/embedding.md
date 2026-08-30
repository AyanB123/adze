# Embedding the engine

Adze's central bet is that **the engine is the product and the surfaces are
distribution**. `@adze/sdk` is what makes that a property of the codebase rather than
an intention: it is a supported public API, and a third party can build a CLI, an
editor extension, a daemon, or a bot on the engine without forking Adze and without
asking anyone.

That claim comes from
[ADR-0001](../architecture/adr/0001-engine-first-architecture.md), which names
"someone outside the project builds a real surface" as its own success signal. This
guide walks the example that answers it, then shows the five things any surface has to
do.

The full API reference is [`packages/sdk/README.md`](../../packages/sdk/README.md).
This guide is the tour; that is the manual.

## Why this matters more than it looks

Every project in the open-source AI coding graveyard was either a single surface — an
editor fork, or an extension — or it bet its business on owning a plugin registry.
Every survivor separated the agent engine from the thing you look at and shipped the
engine everywhere.

Separating them has a concrete consequence you can check: **the engine renders
nothing.** No colour, no terminal escapes, no display-intended markdown, nothing
written to a stream. It emits structured events and has no opinion about how they are
drawn. That is what lets one engine serve a CLI, an extension, and a daemon without
becoming three products that drift apart.

The SDK enforces two other properties. No `@adze/core` type is reachable through it,
so core's refactors are not your breaking changes — and that is checked by a test
rather than asserted, plus verifiable directly against the emitted declarations:

```bash
grep -rE "^\s*(import|export).*@adze/core" dist/*.d.ts dist/internal/client.d.ts
```

And no code path in the SDK makes a network call. Only the provider you configure
talks to the outside.

## Run the example

`examples/minimal-surface` is a complete surface in one file. It imports `@adze/sdk`
and nothing else, renders the event stream itself, and sets its own approval policy.
It runs **offline** — no API key, no network call, no cost — so it works on a fresh
clone.

```bash
pnpm --filter @adze/example-minimal-surface build
pnpm --filter @adze/example-minimal-surface start
```

Or, if the workspace is already built, run the output directly:

```bash
node examples/minimal-surface/dist/main.js
```

Real output from that command on Windows:

```console
$ node examples/minimal-surface/dist/main.js
engine @adze/core@0.0.1 · protocol 0.1
! [no-os-sandbox] broker 'null' provides no OS-level containment on win32. The permission gate and approval policy still apply, but an approved command runs unconfined.

> turn turn_mtg0j04u22znzp · offline-demo · cache epoch 0
  ~ 0 of 800 prompt tokens cached
  + todo {"items":[{"id":"1","content":"Remove build/","status":"in-progress"}]}
  · [in-progress] Remove build/
  = ok
  ~ 800 of 1660 prompt tokens cached

  ? bash — run: bash -lc rm -rf build; read: ...\examples\minimal-surface
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

Exit code is `0`, because the turn reached `end-turn`.

Five things in that transcript are properties of the architecture rather than of the
example file.

**The warning comes first.** `no-os-sandbox` prints before the turn, not after. A user
about to approve a command needs to know nothing will confine it *before* deciding,
not in a footnote afterwards.

**The approval request is actionable.** It carries a one-line summary, the rule that
triggered it, and the **exact argv** that would run — not the string the model wrote. A
surface that displayed the model's string would be asking for consent to something
else.

**A denial is not a failure.** `tool.denied` is a distinct event from `tool.finished`
with `ok: false`. The turn continues, the model adapts, and the run still ends
`end-turn`. Conflating the two would let a denied action appear in a trajectory as an
execution.

**The cache split is reported as a first-class number.** The counts here are scripted,
not measured, but their shape is the point: a cold first step, then the frozen epoch
prefix served from cache. Cache economics move effective cost by more than 10×, which
is why the hit rate is not something a surface has to derive.

**Nothing can touch the machine.** `commandExecution: 'disabled'` means no subprocess
can start, and the scripted provider makes no network call — which is exactly why this
example is safe to run before you have decided to trust anything.

## What the client reports before you do anything

Read `client.capabilities` and `client.warnings` first, and render the warnings.
Verified against this build:

```console
engine:       @adze/core@0.0.1
protocol:     0.1
capabilities: {
  "turns": true,
  "edits": true,
  "retrieval": false,
  "nativeToolCalling": true,
  "vision": true,
  "mcpClient": false,
  "mcpServer": false,
  "osSandbox": false
}
warning: no-os-sandbox - broker 'null' provides no OS-level containment on win32. ...
session sandbox:   {"mode":"workspace-write","writableRoots":[],"allowedNetworkHosts":[],"commandRules":[]}
session approvals: on-request
```

The `false` values are roadmap items reporting themselves as absent, not bugs.
`retrieval` is `false` because no backend was passed — supply one from
`@adze/retrieval` and `glob`, `grep`, and `symbols` become available; omit it and they
report themselves unavailable rather than silently doing nothing. `mcpClient` and
`mcpServer` are milestone M2. `osSandbox` is `false` on every platform today.

Note the last two lines. **Render `session.sandbox` and `session.approvals`, not your
own request.** A session may narrow what you asked for, and displaying the request
when the engine narrowed it is the worst possible lie in a security display.

## The five pieces of a surface

Read `examples/minimal-surface/src/main.ts` top to bottom — it is about eighty lines
and it is the whole thing. The shape is:

### 1. Configure a client

`createClient` is synchronous. It validates configuration, constructs the engine, and
negotiates a protocol version; there is no I/O, so there is nothing to await.

```ts
import { createClient, scriptedProvider } from '@adze/sdk';

const client = createClient({
  workspaceRoot: process.cwd(),        // absolute; enforced
  model: { provider: 'scripted', model: 'offline-demo' },
  provider: scriptedProvider({ script: [{ text: 'Hello from the engine.' }] }),
  sandbox: { mode: 'read-only' },
  approvals: 'on-request',
  onApprovalRequest: decide,
  commandExecution: 'disabled',
});
```

`workspaceRoot` must be absolute, and that is enforced rather than resolved for you:
the engine may run as a sidecar started from an unrelated directory, so a relative
path has no defensible meaning.

This is also where `writableRoots` and `allowedNetworkHosts` become reachable. The CLI
hardcodes both to empty (see [configuration.md](configuration.md)), so an embedder is
currently the only way to widen writes without widening the mode:

```ts
sandbox: {
  mode: 'workspace-write',
  writableRoots: ['/abs/path/to/repo', '/abs/path/to/build-output'],
  allowedNetworkHosts: ['registry.npmjs.org'],
  commandRules: [{ prefix: 'pnpm test', action: 'allow' }],
}
```

Every root must be absolute; `@adze/sdk` validates that and names the offending index
(`sandbox.writableRoots[1]`) rather than failing vaguely.

### 2. Render the warnings, before anything else happens

```ts
for (const warning of client.warnings) {
  process.stderr.write(`[${warning.code}] ${warning.message}\n`);
}
```

### 3. Subscribe to the event stream

The `switch` over `AdzeEvent` is a surface's real job.

```ts
const session = await client.createSession();
const unsubscribe = session.subscribe((event) => {
  switch (event.type) {
    case 'text.delta':    process.stdout.write(event.text); break;
    case 'tool.started':  /* ... */ break;
    case 'tool.denied':   /* not the same as a tool that ran and failed */ break;
    case 'turn.completed': /* ... */ break;
    default: break;
  }
});
```

Three things about subscriptions:

- `event.seq` is monotonic per turn from 0, so you can detect a dropped event instead
  of rendering a partial turn — which looks exactly like a model that stopped early.
- A client-level subscription sees every session; a session-level one sees that
  session and any subagent it spawns.
- A listener that throws cannot break the turn. Pass `onListenerError` if you want to
  see the exception, because the SDK will not log it for you.

### 4. Run a turn

```ts
const result = await session.run({ prompt: 'fix the failing test', budget: { maxSteps: 6 } });
```

`run` is `submit` plus awaiting the result. Use `submit` when you need a handle:

```ts
const handle = await session.submit({ prompt: 'fix the failing test' });
handle.cancel();                       // false if it had already finished — a normal race
const result = await handle.result();  // memoized; safe to call twice
```

`result.stopReason` is one of `end-turn`, `max-steps`, `budget-exhausted`,
`cancelled`, `refused`, `error`. **`refused` is not an error.** It means the permission
gate did its job. Collapsing the two would make a working safety mechanism
indistinguishable from a crash in anything you compute from these runs — including
benchmark numbers.

One turn per session at a time. A second concurrent `submit` throws; create a second
session for concurrency.

### 5. Dispose

```ts
await client.dispose();
```

Closes every session, cancels every turn in flight and waits for it to unwind, and
drops every listener. Idempotent, and required: a client that outlives its window
leaks once per workspace.

## Handling approvals

```ts
onApprovalRequest: async (request) => {
  // { requestId, kind, summary, reason, command?, paths? }
  const allowed = await yourUi.ask(request.summary, request.reason);
  return { requestId: request.requestId, decision: allowed ? 'allow-once' : 'deny' };
}
```

Decisions are `allow-once`, `allow-session` (remembers this exact effect for the
session), `deny` (the agent may adapt), and `abort` (the turn ends as `refused`).

**Everything that is not an explicit allow is a denial.** A handler that throws,
returns a malformed response, or answers a different `requestId` denies the call. An
approval channel that could produce consent by accident is not an approval channel.

Omitting `onApprovalRequest` entirely is safe rather than permissive: no channel means
no approval, which means refusal. And under `approvals: 'never'` your handler is not
called at all, because that policy refuses rather than escalating.

There is no way to bypass the gate. There is no `trustEverything` flag and there will
not be one. `sandbox.mode: 'full-access'` is the widest setting available, it is
reported as a `network-unrestricted` warning, and every call still crosses the gate.

## Swapping in a real model

`scriptedProvider` is the offline provider: it plays a script, makes no network call,
and costs nothing, which is what lets the example and the SDK's own test suite run in
CI and on a fresh clone with no account. Replacing it changes nothing else:

```ts
import { createGateway } from '@adze/providers';
import { createClient } from '@adze/sdk';

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
  // and drop commandExecution: 'disabled', so commands can actually run
});
```

Credentials resolve through `@adze/providers` from the environment or
`.adze/providers.json` — see [configuration.md](configuration.md). They never enter
model context, tool arguments, or trajectory logs.

Before you drop `commandExecution: 'disabled'`, read your own `decide()`. The
example's denies everything. Returning `allow-once` lets the model run the command it
asked for, and with no OS sandbox on any platform, an approval is equivalent to
running that command yourself.

## Usage and cost

`result` and `session.usage()` both carry `{ usage, cost, cacheHitRate }`.

The three token counts do not overlap, so prompt size is
`inputTokens + cachedInputTokens`. `cost` is `undefined` when the provider has no
prices for the model — reported as unknown rather than as zero, because a wrong cost
figure is worse than no cost figure. Every local and OpenAI-compatible endpoint is
unpriced, so `undefined` is the normal case against Ollama.

## Known rough edge, stated rather than worked around

Four configuration seams — `provider`, `tools`, `plugins`, `retrieval` — are typed as
`ModelProviderLike`, `ToolLike`, `PluginLike`, and `RetrievalBackendLike`, which
declare only the fields the SDK itself reads. They are deliberately not full
descriptions of what an implementor must satisfy, because the real interfaces are
written in core-internal vocabulary (`ConversationMessage`, `ToolSpec`,
`ModelStreamChunk`, `PriceSheet`, `Effect`, `Grant`) that `@adze/protocol` has no
equivalent for, and naming any of them would re-export a core internal through the
boundary the SDK exists to draw.

The cost: a value you pass for one of those four is checked at `createClient` time by
runtime validation rather than by the compiler. The validation names every missing
member at once and points at the package that produces a real one, so a wrong value is
a legible error rather than a mystery — but it is a runtime error, and that is a worse
deal than the rest of the API offers.

Writing a third-party provider is exactly the kind of thing ADR-0001 says should be
possible without our involvement, and today it requires reading core. Moving the
message-history and provider-stream vocabulary into `@adze/protocol` would close it.

## Out-of-process engines

`@adze/sdk` embeds the engine **in-process**, so an embedder pays no serialization cost
or startup latency for a transport it does not need. The CLI works this way.

If you want the engine as a sidecar that outlives its window — what the Adze IDE is
planned to do, so that closing a window does not kill a running agent — use
`@adze/protocol` directly. It carries the JSON-RPC 2.0 framing, the Zod schemas, and
version negotiation, and the message set is the same one the SDK calls in-process.

Note that this is the only supported way for a surface to reach the engine. If your
surface can do something the CLI cannot, the protocol is missing a message — add the
message. A private back channel is what turns three surfaces into three products.

## Where to go next

- [`packages/sdk/README.md`](../../packages/sdk/README.md) — the full API reference.
- [`examples/minimal-surface`](../../examples/minimal-surface) — the runnable
  eighty-line surface.
- [configuration.md](configuration.md) — sandbox modes, approval policies, budgets,
  and provider configuration.
- [ADR-0001](../architecture/adr/0001-engine-first-architecture.md) — why the engine
  is the product and surfaces are distribution.
