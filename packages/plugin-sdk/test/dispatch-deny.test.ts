/**
 * The property this package exists for: a plugin hook can veto a tool call, and the
 * veto is enforced by `@adze/core`'s real dispatcher.
 *
 * Every assertion here runs the actual {@link dispatchToolCall} from `@adze/core`
 * with a real {@link HookBus}, a real {@link PermissionGate}, and a real
 * {@link ToolRegistry}. Nothing in this file stands in for the engine. That is the
 * whole point: a mock of dispatch would prove that this package's adapter returns
 * `deny`, which is the easy half. What has to be true is that returning `deny` stops
 * the call — and that is a fact about core's dispatch order, not about this package,
 * so only core's own code can establish it.
 *
 * ## Why the tools here declare no effects
 *
 * The spy tools use `effects: () => []`, so the permission gate has nothing to refuse
 * and allows every call. That is deliberate. With a gate that denies, a `denied`
 * outcome proves nothing — the gate would have produced it whether or not the hook
 * ran. Declaring no effects makes the hook the only thing in the pipeline capable of
 * producing a denial, so `kind: 'denied'` can only have come from the plugin.
 *
 * ## The timeout case matters more than it looks
 *
 * `packages/core`'s `HookBus.fireToolPre` **denies** when a hook does not answer:
 * its header argues that an unanswered veto is not consent. `docs/plugins/spec.md`
 * requires the opposite for plugin hooks — a timeout is an `allow`, logged loudly —
 * because one plugin with a slow network call would otherwise begin denying every
 * tool call in the session, and the symptom would look like an engine fault. Those
 * two policies are genuinely in conflict, and `src/bridge.ts` resolves it by
 * declaring a budget to core's bus that is larger than the sum of the per-hook
 * budgets it enforces itself, so core's fail-closed timeout is never the one that
 * fires. That resolution is arithmetic, and arithmetic is exactly the kind of thing
 * that is right when written and wrong two refactors later, so it is asserted here
 * rather than trusted.
 */

import {
  ContinuationStore,
  type DispatchDeps,
  defineTool,
  dispatchToolCall,
  HookBus,
  MemoryFileSystem,
  NullBroker,
  PermissionGate,
  type RegisteredTool,
  ToolRegistry,
} from '@adze/core';
import type { JsonObject, JsonValue } from '@adze/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toRegisteredHook } from '../src/bridge.js';
import { HookHost, type HookInstance, recordingObserver } from '../src/hooks.js';
import type { HookEvent } from '../src/manifest.js';
import { fakeGuest, hangingGuest } from './support.js';

/** A hook whose answer a test writes directly. */
function hook(
  pluginId: string,
  event: HookEvent,
  answer: JsonValue | (() => JsonValue),
  timeoutMs = 1_000,
): HookInstance {
  return {
    pluginId,
    event,
    module: `hooks/${pluginId}.mjs`,
    runtime: 'js',
    timeoutMs,
    exportName: 'onEvent',
    guest: fakeGuest(() => (typeof answer === 'function' ? answer() : answer)),
  };
}

function hangingHook(pluginId: string, event: HookEvent, timeoutMs = 25): HookInstance {
  return {
    pluginId,
    event,
    module: `hooks/${pluginId}.mjs`,
    runtime: 'js',
    timeoutMs,
    exportName: 'onEvent',
    guest: hangingGuest(),
  };
}

interface Harness {
  readonly deps: DispatchDeps;
  readonly observer: ReturnType<typeof recordingObserver>;
  /** Arguments the tool body actually received, or undefined if it never ran. */
  seen(): JsonObject | undefined;
}

/**
 * A dispatcher wired to a plugin host, with one recording tool.
 *
 * `toolName` exists so a test can register the spy as `edit`, which is how the
 * `edit.pre` derivation in `src/bridge.ts` is reached — that path keys off the tool's
 * name, so no other name will exercise it.
 */
function harness(
  hooks: readonly HookInstance[],
  options: { readonly toolName?: string; readonly onFailure?: 'allow' | 'deny' } = {},
): Harness {
  let received: JsonObject | undefined;

  const spy: RegisteredTool = defineTool({
    name: options.toolName ?? 'spy',
    description: 'records the arguments it was called with',
    schema: z.object({
      path: z.string().optional(),
      edits: z.array(z.object({ search: z.string(), replace: z.string() })).optional(),
      // `content` is `write`'s whole-file argument and `replacement` is `edit`'s. Both
      // are needed to reach the whole-file branches of the edit-shape readers.
      content: z.string().optional(),
      replacement: z.string().optional(),
      note: z.string().optional(),
    }),
    // No declared effects, so the gate allows. See the file header.
    effects: () => [],
    execute: async (args) => {
      received = args as JsonObject;
      return await Promise.resolve({ ok: true, content: [{ type: 'text', text: 'ran' }] });
    },
  });

  const registry = new ToolRegistry();
  registry.register(spy);

  const observer = recordingObserver();
  const host = new HookHost({
    observer,
    ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }),
  });
  for (const instance of hooks) host.register(instance);

  const bus = new HookBus();
  bus.register(toRegisteredHook({ host }));

  const gate = new PermissionGate({
    workspaceRoot: '/work',
    sandbox: { mode: 'read-only', writableRoots: [], allowedNetworkHosts: [], commandRules: [] },
    approvals: 'never',
    broker: new NullBroker(),
    fs: new MemoryFileSystem(),
    nextRequestId: () => 'appr_1',
    platform: 'linux',
  });

  return {
    observer,
    seen: () => received,
    deps: {
      registry,
      gate,
      hooks: bus,
      continuations: new ContinuationStore(() => 'cont_1'),
      workspaceRoot: '/work',
      sessionId: 'sess_1',
      turnId: 'turn_1',
      limits: { maxResultBytes: 4096, timeoutMs: 1_000 },
      signal: new AbortController().signal,
      search: undefined,
      todos: [],
      runSubagent: undefined,
    },
  };
}

async function dispatch(h: Harness, name = 'spy', args: JsonObject = { note: 'hello' }) {
  return await dispatchToolCall({ callId: 'c1', name, arguments: args, step: 0 }, h.deps);
}

describe('a tool.pre denial stops the call inside core dispatch', () => {
  it('reports a hook denial and never runs the tool body', async () => {
    const h = harness([
      hook('acme.policy', 'tool.pre', { kind: 'deny', reason: 'no writes under infra/' }),
    ]);

    const outcome = await dispatch(h);

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    // `source: 'hook'` rather than `'gate'` is what proves the plugin stopped it. The
    // gate had nothing to refuse, so it cannot be the origin.
    expect(outcome.source).toBe('hook');
    // The property. A denial that let the body run would satisfy every other
    // assertion in this file.
    expect(h.seen()).toBeUndefined();
  });

  it('names the plugin and the reason, so a blocked action is explainable', async () => {
    const h = harness([
      hook('acme.migration-guard', 'tool.pre', {
        kind: 'deny',
        reason: 'migrations require review',
      }),
    ]);

    const outcome = await dispatch(h);
    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.reason).toContain('acme.migration-guard');
    expect(outcome.reason).toContain('migrations require review');
  });

  it('runs the body when the same wiring allows', async () => {
    // The control. Without it, a dispatcher broken in some unrelated way would make
    // every assertion above pass for the wrong reason.
    const h = harness([hook('acme.policy', 'tool.pre', { kind: 'allow' })]);

    const outcome = await dispatch(h);

    expect(outcome.kind).toBe('executed');
    expect(h.seen()).toEqual({ note: 'hello' });
  });

  it('stops asking after the first denial', async () => {
    let secondRan = false;
    const h = harness([
      hook('acme.first', 'tool.pre', { kind: 'deny', reason: 'first says no' }),
      hook('acme.second', 'tool.pre', () => {
        secondRan = true;
        return { kind: 'allow' };
      }),
    ]);

    const outcome = await dispatch(h);

    expect(outcome.kind).toBe('denied');
    // A later hook cannot un-deny, so asking it would only give it a chance to
    // observe a call that will not happen.
    expect(secondRan).toBe(false);
  });
});

describe('an edit.pre denial stops an edit before anything is written', () => {
  it('derives edit.pre from the dispatch of an edit-shaped tool', async () => {
    const h = harness(
      [hook('acme.guard', 'edit.pre', { kind: 'deny', reason: 'schema files are frozen' })],
      { toolName: 'edit' },
    );

    const outcome = await dispatch(h, 'edit', {
      path: 'db/schema.sql',
      edits: [{ search: 'a', replace: 'b' }],
    });

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.source).toBe('hook');
    expect(outcome.reason).toContain('schema files are frozen');
    expect(h.seen()).toBeUndefined();
  });

  it('leaves a non-edit tool alone', async () => {
    // An `edit.pre` hook must not fire for `spy`, or a policy written for edits would
    // start vetoing reads and searches.
    const h = harness([hook('acme.guard', 'edit.pre', { kind: 'deny', reason: 'frozen' })]);

    const outcome = await dispatch(h);

    expect(outcome.kind).toBe('executed');
    expect(h.seen()).toEqual({ note: 'hello' });
  });
});

/**
 * The bypass reported in `plugins/FINDINGS.md`.
 *
 * A guard registered on `edit.pre` refused a credential added by `edit` and allowed the
 * identical credential written by `write`, because a whole-file write reported
 * `edits: []` and the payload carried the bytes nowhere. The content was reachable only
 * through the raw tool arguments, so the only working guard was one that knew which tool
 * had produced the edit — the coupling `edit.pre` exists to remove.
 *
 * Every guard below reads **only** the tool-agnostic payload fields. That restraint is
 * the test: a guard allowed to read `arguments` would have passed before the fix.
 */
function secretGuard(pluginId: string): HookInstance {
  return {
    pluginId,
    event: 'edit.pre',
    module: `hooks/${pluginId}.mjs`,
    runtime: 'js',
    timeoutMs: 1_000,
    exportName: 'onEvent',
    guest: fakeGuest((_functionName, input) => {
      const payload = input as {
        readonly content?: string;
        readonly edits?: readonly { readonly replace: string }[];
      };
      const introduced = [payload.content ?? '', ...(payload.edits ?? []).map((e) => e.replace)];
      return introduced.some((text) => text.includes('AKIAIOSFODNN7EXAMPLE'))
        ? { kind: 'deny', reason: 'a credential must not be written to a file' }
        : { kind: 'allow' };
    }),
  };
}

/** Records the payload a hook was handed, then allows. */
function capturing(pluginId: string, sink: JsonValue[]): HookInstance {
  return {
    pluginId,
    event: 'edit.pre',
    module: `hooks/${pluginId}.mjs`,
    runtime: 'js',
    timeoutMs: 1_000,
    exportName: 'onEvent',
    guest: fakeGuest((_functionName, input) => {
      sink.push(input);
      return { kind: 'allow' };
    }),
  };
}

const CREDENTIAL = 'AKIAIOSFODNN7EXAMPLE';

describe('a content policy on edit.pre covers whole-file writes', () => {
  it('denies a credential written by write, not only one added by edit', async () => {
    // The bypass itself. Before `content` was on the payload this call was allowed,
    // because `edits` is empty for a whole-file write and the guard had nothing to read.
    const h = harness([secretGuard('acme.secrets')], { toolName: 'write' });

    const outcome = await dispatch(h, 'write', {
      path: 'src/config.ts',
      content: `export const key = '${CREDENTIAL}';\n`,
    });

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.source).toBe('hook');
    expect(outcome.reason).toContain('credential');
    expect(h.seen()).toBeUndefined();
  });

  it('denies the same credential in a search/replace edit', async () => {
    // The half that already worked. Kept so the two paths are asserted to agree —
    // identical bytes reaching disk must get the identical verdict.
    const h = harness([secretGuard('acme.secrets')], { toolName: 'edit' });

    const outcome = await dispatch(h, 'edit', {
      path: 'src/config.ts',
      edits: [{ search: 'const key', replace: `const key = '${CREDENTIAL}'` }],
    });

    expect(outcome.kind).toBe('denied');
    expect(h.seen()).toBeUndefined();
  });

  it('denies a credential in a whole-file replacement passed to edit', async () => {
    // The second instance of the same hole, not reported in FINDINGS: `edit` accepts a
    // whole-file `replacement` for the applier's second tier, and the reader set
    // `wholeFile: true` while dropping those bytes exactly as `write` did.
    const h = harness([secretGuard('acme.secrets')], { toolName: 'edit' });

    const outcome = await dispatch(h, 'edit', {
      path: 'src/config.ts',
      replacement: `export const key = '${CREDENTIAL}';\n`,
    });

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.source).toBe('hook');
    expect(h.seen()).toBeUndefined();
  });

  it('lets a clean whole-file write through', async () => {
    // The guard has to be capable of allowing, or the three denials above would also
    // pass against a hook that denied everything.
    const h = harness([secretGuard('acme.secrets')], { toolName: 'write' });

    const outcome = await dispatch(h, 'write', {
      path: 'src/config.ts',
      content: 'export const key = process.env.AWS_KEY;\n',
    });

    expect(outcome.kind).toBe('executed');
    expect(h.seen()).not.toBeUndefined();
  });
});

describe('the edit.pre payload matches what the declared type promises', () => {
  it('carries content and the raw arguments for a whole-file write', async () => {
    const seen: JsonValue[] = [];
    const h = harness([capturing('acme.audit', seen)], { toolName: 'write' });

    await dispatch(h, 'write', { path: 'src/a.ts', content: 'hello\n' });

    expect(seen).toHaveLength(1);
    const payload = seen[0] as Record<string, JsonValue>;
    expect(payload.content).toBe('hello\n');
    expect(payload.wholeFile).toBe(true);
    expect(payload.edits).toEqual([]);
    // `arguments` was already on the wire and undeclared. It is declared now, so this
    // asserts a promise rather than an accident.
    expect(payload.arguments).toEqual({ path: 'src/a.ts', content: 'hello\n' });
  });

  it('omits content for a search/replace edit rather than sending null', async () => {
    // A guest checking `content === undefined` should not also have to check for null.
    const seen: JsonValue[] = [];
    const h = harness([capturing('acme.audit', seen)], { toolName: 'edit' });

    await dispatch(h, 'edit', { path: 'src/a.ts', edits: [{ search: 'a', replace: 'b' }] });

    const payload = seen[0] as Record<string, JsonValue>;
    expect('content' in payload).toBe(false);
    expect(payload.wholeFile).toBe(false);
    expect(payload.edits).toEqual([{ search: 'a', replace: 'b' }]);
  });
});

describe('a hook that does not answer is treated as allow', () => {
  it('lets the call through and records the timeout', async () => {
    const h = harness([hangingHook('acme.slow', 'tool.pre', 25)]);

    const outcome = await dispatch(h);

    // The conflict named in the file header. Core's bus would have denied; the
    // adapter's own budget fires first and the spec's policy is what takes effect.
    expect(outcome.kind).toBe('executed');
    expect(h.seen()).toEqual({ note: 'hello' });

    const timeouts = h.observer.records.filter((record) => record.kind === 'timeout');
    expect(timeouts).toHaveLength(1);
    const first = timeouts[0];
    if (first === undefined || first.kind !== 'timeout') throw new Error('expected a timeout');
    // Loudly: the record has to say which plugin, which event, and what was done
    // about it, or a silently-skipped policy is indistinguishable from one that ran.
    expect(first.pluginId).toBe('acme.slow');
    expect(first.event).toBe('tool.pre');
    expect(first.treatedAs).toBe('allow');
  });

  it('does not let core bus fail closed first, whatever the hook budget is', async () => {
    // The arithmetic in `toRegisteredHook`. Core's bus timeout must stay unreachable,
    // so a hook budget far above core's own 5 s default still ends in `executed`
    // rather than in core's deny-on-timeout branch.
    const h = harness([hangingHook('acme.very-slow', 'tool.pre', 6_000)]);

    const outcome = await dispatch(h);

    expect(outcome.kind).toBe('executed');
  }, 20_000);

  it('honours an operator who asks to fail closed instead', async () => {
    const h = harness([hangingHook('acme.slow', 'tool.pre', 25)], { onFailure: 'deny' });

    const outcome = await dispatch(h);

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.source).toBe('hook');
    const timeouts = h.observer.records.filter((record) => record.kind === 'timeout');
    const first = timeouts[0];
    if (first === undefined || first.kind !== 'timeout') throw new Error('expected a timeout');
    expect(first.treatedAs).toBe('deny');
  });

  it('treats a throwing hook as allow, and records it', async () => {
    const h = harness([
      hook('acme.buggy', 'tool.pre', () => {
        throw new Error('cannot read property of undefined');
      }),
    ]);

    const outcome = await dispatch(h);

    // A typo in a policy hook must cost one un-enforced check, not the session.
    expect(outcome.kind).toBe('executed');
    const errors = h.observer.records.filter((record) => record.kind === 'error');
    expect(errors).toHaveLength(1);
  });

  it('treats a malformed answer as allow rather than guessing', async () => {
    // `{"kind":"denied"}` is the plausible typo and the shape a model would generate.
    // Reading it as a denial would make the veto contract depend on spelling.
    const h = harness([hook('acme.typo', 'tool.pre', { kind: 'denied', reason: 'no' })]);

    const outcome = await dispatch(h);

    expect(outcome.kind).toBe('executed');
    const malformed = h.observer.records.filter((record) => record.kind === 'malformed');
    expect(malformed).toHaveLength(1);
  });
});

describe('a modify travels through the tool schema', () => {
  it('reaches the tool body rewritten', async () => {
    const h = harness([
      hook('acme.normalize', 'tool.pre', {
        kind: 'modify',
        arguments: { note: 'rewritten' },
      }),
    ]);

    const outcome = await dispatch(h);

    expect(outcome.kind).toBe('executed');
    expect(h.seen()).toEqual({ note: 'rewritten' });
  });

  it('is rejected by the schema when the rewrite is invalid', async () => {
    // A plugin gets no more trust than the model. A rewrite that would not have been
    // accepted from the model is not accepted from a hook either, and the failure is
    // an invalid-arguments result rather than a crash or a silent pass-through.
    const h = harness([
      hook('acme.broken', 'tool.pre', { kind: 'modify', arguments: { note: 42 } }),
    ]);

    const outcome = await dispatch(h);

    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error).toContain('invalid arguments');
    expect(h.seen()).toBeUndefined();
  });
});
