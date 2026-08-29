# @adze/core

The headless Adze engine: the turn machine, the tool registry, the permission gate,
and the context assembler.

**It renders nothing.** It imports no surface package, emits no terminal escapes, no
HTML, and no display-intended markdown. Everything a surface needs arrives as a
structured `@adze/protocol` event. That is the whole product thesis — the engine is
the product and surfaces are distribution — and it is enforced in review
([ADR-0001](../../docs/architecture/adr/0001-engine-first-architecture.md)).

## The loop is deliberately boring

```
submit(prompt)
  → fire session.turnStart hooks
  → assemble context for the current cache epoch
  → loop until stop | budget exhausted | max steps:
      stream model response (native tool calling)
      for each tool call:
        fire tool.pre hooks        (may deny or rewrite args)
        authorize via permission gate
        execute in sandbox         (stateless: one subprocess per call)
        truncate + structure result
        fire tool.post hooks
      append to a strictly linear history
  → fire session.turnEnd hooks
  → report usage, cost, cache hit rate
```

That is not minimalism for its own sake. Controlled experiments holding the model
fixed and swapping the harness found aggregate score differences that were **not
statistically significant**, while the minimal reference harness — bash-only, linear
history, one subprocess per action — scores at or above elaborate ones. Elaborate
scaffolding buys perhaps 10–15 points against a *bad* baseline and close to nothing
against a good one.

So there is no tree search, no planner/executor split, and no reflection layer, and
the complexity budget goes to the applier, the gate, and the context assembler
instead. Anyone who wants those builds them through the `task` tool or as a plugin
([ADR-0003](../../docs/architecture/adr/0003-agent-loop.md)).

The one thing the evidence *does* justify spending on is the execute-observe-retry
loop: a single round of test feedback moved pass rate from 52.0% to 88.0% on a
public edit benchmark. `src/test-feedback.ts` is that finding in code — failing
output comes back with the diagnosis extracted and the tail preserved, rather than
as a wall of stdout with the answer truncated off the end.

## Usage

```ts
import { Engine, EventLog, NodeSubprocessBroker, ScriptedProvider } from '@adze/core';

const log = new EventLog();
const engine = new Engine({
  provider: new ScriptedProvider({
    script: [
      { toolCalls: [{ name: 'bash', arguments: { command: 'pnpm test' } }] },
      { text: 'Tests pass.' },
    ],
  }),
  broker: new NodeSubprocessBroker(),
  sink: log.sink,
});

engine.initialize({
  protocolVersions: ['0.1'],
  client: { name: 'my-surface', version: '1.0.0', platform: process.platform },
});

const { sessionId } = await engine.sessionCreate({
  workspaceRoot: process.cwd(),
  model: { provider: 'scripted', model: 'test' },
});

const { turnId } = await engine.turnSubmit({
  sessionId,
  prompt: 'Run the tests.',
  attachments: [],
  budget: { maxSteps: 8, maxWallClockMs: 120_000 },
});

const outcome = await engine.awaitTurn(turnId);
//  -> { stopReason: 'end-turn', usage, steps, text }
```

## What works, and what is an interface waiting for its package

Being precise about this is a project rule, not politeness.

**Working:** the turn machine; all four budgets, enforced and reported; the
permission gate with both axes and command-prefix rules; the epoch-based context
assembler; the tool registry; the hook bus; stateless subprocess execution; and the
`bash`, `read`, `write`, `edit`, `todo`, and `task` tools.

**Seams with no implementation here, by design:**

| Seam | Owner | Behaviour today |
| --- | --- | --- |
| `ModelProvider` | `@adze/providers` | `ScriptedProvider` only. No network call anywhere in this package, including tests. |
| `SearchBackend` | `@adze/retrieval` | `glob`, `grep`, and `symbols` report themselves **unavailable**. Not empty — a model reading an empty result concludes the symbol does not exist. |
| OS containment inside `SandboxBroker` | `@adze/sandbox` | `NodeSubprocessBroker` runs stateless subprocesses and reports `gate-only` enforcement, because that is what it has. |

`fetch` is named in [ADR-0004](../../docs/architecture/adr/0004-tool-surface.md) and
is **not implemented**: it is the one tool that makes an outbound network call, and
it needs the host policy the broker cannot yet enforce. Shipping it against a broker
that cannot restrict hosts would let a URL bypass the policy it exists to cross.

See [the roadmap](../../docs/roadmap.md) for when each lands.

## The permission gate

Two orthogonal axes, because collapsing them into one "safety level" dial is what
produces approval fatigue — the only way to reduce prompts becomes reducing
containment
([ADR-0007](../../docs/architecture/adr/0007-sandbox-and-permissions.md)).

| Sandbox mode | Filesystem | Network |
| --- | --- | --- |
| `read-only` | read within the workspace, write nothing | denied |
| `workspace-write` | write within `writableRoots` | denied unless allowlisted |
| `full-access` | unrestricted | unrestricted |

| Approval policy | Behaviour |
| --- | --- |
| `untrusted` | approve every action with an effect |
| `on-request` | approve only what the sandbox would block *(default)* |
| `never` | never prompt; **refuse** rather than escalate |

Plus command-prefix rules (`allow` / `prompt` / `forbid`), so `npm test` can be
permitted without widening the boundary. `forbid` beats every mode, including
`full-access`.

Three behaviours are worth calling out because they are the ones a reader is most
likely to assume otherwise:

- **`never` refuses.** It does not quietly widen the sandbox. A policy that granted
  more than it advertised would make the whole model untrustworthy.
- **No approval channel also means refusal.** A missing surface callback must not
  become an undeclared full-access mode.
- **A command is prompted when nothing is containing it.** With `os-level`
  enforcement, `on-request` lets commands run because the sandbox is what would stop
  them. With `gate-only` — every platform today, and Windows for the foreseeable
  future — the gate is all there is, so the command is prompted. That is deliberately
  more conservative on Windows, and command-prefix `allow` rules are the intended
  remedy.

### Every tool call passes the gate, structurally

Architecture invariant 4 says there is no code path around the gate. Four mechanisms
hold it, not one convention:

1. A tool's `execute` requires a `Grant`, and `Grant` is branded with a symbol
   `permissions.ts` does not export. Nothing else can produce one.
2. `PermissionGate.authorize` is the only function that mints a `Grant`.
3. Arguments reach `execute` only through `prepare`, so schema validation is not a
   step anyone can forget.
4. `test/gate-coverage.test.ts` asserts the shape of the code: `.execute(` appears in
   exactly two files, no tool imports `node:child_process` or `node:fs`, and a denying
   gate stops every effectful built-in — table-driven across the whole registry, so a
   tool added next year is covered the day it is registered.

The grant also re-checks each operation against the effects that were approved, so a
tool that declared a read of `a.ts` and attempts a write to `b.ts` gets an error
rather than a silent success.

**Where containment is absent, this package says so** rather than implying
protection: `NodeSubprocessBroker` never reports `os-level`, and the engine emits a
`no-os-sandbox` warning through `initialize`, `session.create`, and every
`turn.started`.

## Cache epochs

Provider prompt caching only pays if the prefix is **byte-identical**. Reassembling
a system prompt each step — refreshing a timestamp, re-sorting a file list,
re-ranking retrieval — invalidates the cache on every step, and cache economics move
effective cost by more than 10×.

So the baseline system context is frozen for a cache epoch. Within an epoch that
prefix is immutable, and new information arrives as ordered mid-conversation
messages. An epoch rolls only on a structural change: model switch, compaction,
permission-mode change, tool-set change, or an instructions change. The tool catalog
is in that list because tools are part of the cached prefix for most providers.

`test/context.test.ts` asserts the prefix is byte-identical across ten steps and
that each structural change rolls the epoch. That test is the point of the design;
without it the design is a comment.

## Layout

| File | Responsibility |
| --- | --- |
| `turn.ts` | The loop. ADR-0003 in code. |
| `dispatch.ts` | The only path from a tool call to execution. |
| `permissions.ts` | The gate, the `Grant` capability, command rules. |
| `broker.ts` | Subprocess seam; stateless local implementation. |
| `context.ts` | Epoch-based assembly and the frozen baseline. |
| `registry.ts` | Tool registration, erasure, narrowing. |
| `tools/` | The built-ins, one file per concern. |
| `provider.ts` | Model gateway seam plus the scripted provider. |
| `hooks.ts` | Deny-capable lifecycle hooks. |
| `budget.ts`, `cost.ts` | Four ceilings; cache-aware pricing. |
| `truncate.ts` | Result budgets and continuations. |
| `test-feedback.ts` | Structured failure extraction. |
| `session.ts` | Linear history and the thread store. |
| `engine.ts` | The protocol-facing facade. |

## Development

```bash
pnpm --filter @adze/core typecheck
pnpm --filter @adze/core test
pnpm --filter @adze/core build
```

Design rationale:
[ADR-0003](../../docs/architecture/adr/0003-agent-loop.md) (the loop),
[ADR-0004](../../docs/architecture/adr/0004-tool-surface.md) (the tools),
[ADR-0007](../../docs/architecture/adr/0007-sandbox-and-permissions.md) (the gate).
