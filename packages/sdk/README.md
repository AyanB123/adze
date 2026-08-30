# @adze/sdk

The public embedding API for the Adze engine. Build your own surface — a CLI, an
editor extension, a daemon, a bot — without forking Adze and without asking us.

This package exists because of one line in
[ADR-0001](../../docs/architecture/adr/0001-engine-first-architecture.md): *"`@adze/sdk`
is a supported public API. Third parties can build surfaces without our involvement
or permission."* Until it existed, "engine-first" was an intention rather than a
property of the codebase.

> [!NOTE]
> **Status.** Works today: client and session lifecycle, turns, typed event
> subscription, approvals, budgets, cancellation, usage and cost, disposal. The
> capabilities this build reports as `false` — retrieval without a backend, MCP, an OS
> sandbox — are roadmap items reporting themselves as absent, not bugs. See
> [the roadmap](../../docs/roadmap.md).

## Install

```bash
pnpm add @adze/sdk
```

## Thirty lines that do something

```ts
import { createClient, scriptedProvider } from '@adze/sdk';

const client = createClient({
  workspaceRoot: process.cwd(),
  model: { provider: 'scripted', model: 'offline' },
  provider: scriptedProvider({ script: [{ text: 'Hello from the engine.' }] }),
  approvals: 'on-request',
  onApprovalRequest: (request) => ({
    requestId: request.requestId,
    decision: 'deny',
    note: 'this surface declines everything for now',
  }),
});

for (const warning of client.warnings) {
  // Render these before a user approves anything.
  process.stderr.write(`[${warning.code}] ${warning.message}\n`);
}

const session = await client.createSession();
const unsubscribe = session.subscribe((event) => {
  if (event.type === 'text.delta') process.stdout.write(event.text);
});

const result = await session.run({ prompt: 'Say hello.', budget: { maxSteps: 4 } });
// { stopReason: 'end-turn', text: 'Hello from the engine.', steps: 1, usage, cost, cacheHitRate }

unsubscribe();
await client.dispose();
```

A complete, runnable version is in
[`examples/minimal-surface`](../../examples/minimal-surface) — 80 lines, offline, no
API key.

## Swapping in a real model

`scriptedProvider` is the offline provider. It plays a script, makes no network call,
and costs nothing, which is what lets the example above and this package's own test
suite run in CI and on a fresh clone with no account. Replace it with a real gateway
and nothing else changes:

```ts
import { createGateway } from '@adze/providers';
import { createClient } from '@adze/sdk';

const { gateway, model } = createGateway({ cwd: process.cwd(), modelRef: 'anthropic/claude-sonnet-4-5' });

const client = createClient({
  workspaceRoot: process.cwd(),
  provider: gateway,
  model,
});
```

Credentials are resolved by `@adze/providers` from the environment or
`~/.adze/providers.json`. They never enter model context, tool arguments, or
trajectory logs.

## The API

### `createClient(options): AdzeClient`

Synchronous. It validates the configuration, constructs the engine, and negotiates a
protocol version — no I/O, so nothing to await.

| Option | Meaning |
| --- | --- |
| `workspaceRoot` | Absolute path. Required, and absolute is enforced: the engine may be a sidecar started from an unrelated directory. |
| `provider` | A model gateway. `@adze/providers`, or `scriptedProvider`. |
| `model` | Required, no default. Pin a dated snapshot where the provider offers one. |
| `client` | `{ name, version }` identifying your surface in trajectory logs. |
| `sandbox` | `{ mode, writableRoots, allowedNetworkHosts, commandRules }`. Defaults to `workspace-write`. |
| `approvals` | `untrusted` \| `on-request` \| `never`. Defaults to `on-request`. |
| `onApprovalRequest` | Your decision callback. Omit it and anything needing approval is refused. |
| `budget` | Default `{ maxSteps, maxTokens, maxWallClockMs, maxSpendUsd }` for every turn. |
| `instructions` | Extra system instructions, e.g. assembled from `AGENTS.md`. |
| `tools` | Extra tools — from `@adze/mcp`, or a plugin. Each still passes the gate. |
| `plugins` | Lifecycle hooks from `@adze/plugin-sdk`. A hook may deny a tool call. |
| `retrieval` | A backend from `@adze/retrieval`. Omit it and `glob`/`grep`/`symbols` report themselves unavailable. |
| `limits` | `{ maxResultBytes, timeoutMs }`. Both or neither. |
| `commandExecution` | `subprocess` (default) or `disabled`. |
| `onListenerError` | Where a throwing listener's exception goes. |

Read `client.capabilities` and `client.warnings` before doing anything else, and
render the warnings. On every platform today `osSandbox` is `false` and a
`no-os-sandbox` warning is present: the permission gate decides *whether* a command
runs, and nothing constrains what it touches once it does. A user about to approve a
command needs that fact first, not in a footnote.

### `client.createSession(options?): Promise<AdzeSession>`

`options` may narrow or widen `model`, `sandbox`, `approvals`, and `instructions` for
this session. The returned session reports what is **actually in force**, which can
differ from what you asked for — render `session.sandbox` and `session.approvals`
rather than your own request, because showing the request when the engine narrowed it
is the worst possible lie in a security display.

### `session.submit(input)` and `session.run(input)`

`submit` returns a `TurnHandle` as soon as the turn is running; progress arrives as
events. `run` is `submit` plus `await handle.result()`.

```ts
const handle = await session.submit({ prompt: 'fix the failing test' });
handle.cancel();                       // false if it had already finished — a normal race
const result = await handle.result();  // memoized; safe to call twice
```

`result.stopReason` is one of `end-turn`, `max-steps`, `budget-exhausted`,
`cancelled`, `refused`, `error`. **`refused` is not an error.** It means the gate did
its job, and collapsing the two would make a working safety mechanism
indistinguishable from a crash in anything you compute from these runs.

One turn per session at a time. A second concurrent `submit` throws; use a second
session for concurrency.

### `client.subscribe(listener)` / `session.subscribe(listener)`

Typed `AdzeEvent`s. The client-level subscription sees every session; the
session-level one sees that session and any subagent it spawns.

`event.seq` is monotonic per turn from 0, so you can detect a dropped event instead of
rendering a partial turn — which looks exactly like a model that stopped early.

Both return an idempotent `Unsubscribe`. A listener may unsubscribe from inside its
own callback, which is the ordinary shape of "wait for `turn.completed`". A listener
that throws cannot break the turn; supply `onListenerError` if you want to see the
exception, because this package will not log it for you.

### Approvals

```ts
onApprovalRequest: async (request) => {
  // request: { requestId, kind, summary, reason, command?, paths? }
  const allowed = await yourUi.ask(request.summary, request.reason);
  return { requestId: request.requestId, decision: allowed ? 'allow-once' : 'deny' };
}
```

Decisions: `allow-once`, `allow-session` (remembers this exact effect for the
session), `deny` (the agent may adapt), `abort` (the turn ends as `refused`).

Everything that is not an explicit allow is a denial. A handler that throws, returns
a malformed response, or answers a different `requestId` denies the call — an approval
channel that could produce consent by accident is not an approval channel.

Under `approvals: 'never'` your handler is **not called at all**. That policy refuses
rather than escalating, and the SDK does not consult the handler even if the gate
somehow asked.

There is no way to bypass the gate. There is no `trustEverything` flag and there will
not be one; `sandbox.mode: 'full-access'` is the widest setting available, it is
reported as a `network-unrestricted` warning, and every call still crosses the gate.

### Usage and cost

`result` and `session.usage()` both carry `{ usage, cost, cacheHitRate }`.

The three token counts do not overlap, so prompt size is
`inputTokens + cachedInputTokens`. `cost` is `undefined` when the provider has no
prices for the model — reported as unknown rather than as zero, because a wrong cost
figure is worse than no cost figure. `cacheHitRate` is a cost metric wearing
performance clothes: cache economics move effective cost by more than 10×.

### `client.dispose()`

Closes every session, cancels every turn in flight and waits for it to unwind, and
drops every listener. Idempotent, and required: a client that outlives its window
leaks once per workspace.

## The four rules this package keeps

1. **It renders nothing.** No colour, no escapes, no display-intended markdown,
   nothing written to a stream. You get structured events and you render them. This is
   what lets one engine serve a CLI, an extension, and a daemon without becoming three
   products.
2. **No `@adze/core` type is reachable.** Everything you can name comes from this
   package or from `@adze/protocol`. `@adze/sdk` is semver-strict from 1.0, and that
   guarantee would be worthless if core's refactors were your breaking changes.
3. **Every tool call passes the permission gate**, built-ins included, with no path
   around it.
4. **Nothing leaves the machine.** No code path here makes a network call. Only the
   provider you configure talks to the outside.

Rule 2 is checked rather than asserted. `test/public-api.test.ts` verifies that no
exported name or value is shared with `@adze/core` and that only `src/internal/`
imports it, and the emitted declarations are checkable directly:

```bash
# Nothing on the public type path may import core. Only src/internal/validate.d.ts does.
grep -rE "^\s*(import|export).*@adze/core" dist/*.d.ts dist/internal/client.d.ts
```

## Types that belong in `@adze/protocol`

Being the first consumer to drive the engine through a stability boundary surfaced a
real gap, recorded here rather than worked around silently.

Four configuration seams — `provider`, `tools`, `plugins`, `retrieval` — are typed as
`ModelProviderLike`, `ToolLike`, `PluginLike`, and `RetrievalBackendLike`, which
declare only the fields this package itself reads. They are deliberately not full
descriptions of what an implementor must satisfy, because the real interfaces
(`ModelProvider`, `RegisteredTool`, `RegisteredHook`, `SearchBackend`) are written in
core-internal vocabulary that `@adze/protocol` has no equivalent for:
`ConversationMessage`, `ToolSpec`, `ModelStreamChunk`, `PriceSheet`, `Effect`,
`Grant`. Naming any of them here would re-export a core internal through the boundary
this package exists to draw.

The cost is that a value you pass for one of those four is checked at `createClient`
time by runtime validation rather than by the compiler. The validation names every
missing member at once and points at the package that produces a real one, so a wrong
value is a legible error rather than a mystery — but it is a runtime error, and that
is a worse deal than the rest of this API offers.

Moving the message-history and provider-stream vocabulary into `@adze/protocol` would
close it. A third-party provider is exactly the kind of thing ADR-0001 says should be
possible without our involvement, and today writing one requires reading core.

## Out-of-process engines

This package embeds the engine **in-process**, so an embedder pays no serialization
cost for a transport it does not need. If you want the engine as a sidecar that
outlives its window — what the Adze IDE does — use `@adze/protocol` directly: it
carries the JSON-RPC 2.0 framing, the Zod schemas, and the version negotiation, and
the message set is the same one this package calls in-process.

## Licence

Apache-2.0.
