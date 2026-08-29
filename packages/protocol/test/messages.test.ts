import { describe, expect, it } from 'vitest';
import { ADZE_EVENT_TYPES, AdzeEventSchema, isTerminalEvent } from '../src/events.js';
import {
  CLIENT_METHODS,
  ENGINE_METHODS,
  formatIssues,
  InitializeParamsSchema,
  isMethodName,
  METHOD,
  METHOD_SCHEMAS,
  parseParams,
  SessionCreateParamsSchema,
  TurnSubmitParamsSchema,
} from '../src/messages.js';
import {
  ApprovalRequestSchema,
  computeCacheHitRate,
  makeUsage,
  refusesRatherThanPrompts,
  sandboxEnforcement,
  ToolResultSchema,
  toolResultTruncationIsConsistent,
  UsageSchema,
} from '../src/primitives.js';
import { PROTOCOL_VERSION } from '../src/version.js';

describe('method registry', () => {
  it('has a schema entry for every declared method', () => {
    for (const method of Object.values(METHOD)) {
      expect(METHOD_SCHEMAS[method]).toBeDefined();
      expect(isMethodName(method)).toBe(true);
    }
  });

  it('assigns every method to exactly one direction', () => {
    const all = [...CLIENT_METHODS, ...ENGINE_METHODS];
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(Object.values(METHOD)));
  });

  it('rejects an unknown method name', () => {
    expect(isMethodName('session.destroy')).toBe(false);
    expect(isMethodName('__proto__')).toBe(false);
  });

  it('marks only `event` as a notification', () => {
    // `result: null` is the notification marker. A request whose result is merely
    // empty would still be a request, and replying to a notification is a
    // protocol violation rather than a harmless extra message.
    const notifications = Object.values(METHOD).filter((m) => METHOD_SCHEMAS[m].result === null);
    expect(notifications).toEqual([METHOD.Event]);
  });
});

describe('parseParams', () => {
  it('parses valid initialize params', () => {
    const result = parseParams(METHOD.Initialize, {
      protocolVersions: [PROTOCOL_VERSION],
      client: { name: 'adze-cli', version: '0.0.1', platform: 'win32' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.protocolVersions).toEqual([PROTOCOL_VERSION]);
  });

  it('returns issues rather than throwing, so a caller can build InvalidParams', () => {
    const result = parseParams(METHOD.Initialize, { protocolVersions: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(0);
    const lines = formatIssues(result.issues);
    expect(lines.some((l) => l.startsWith('protocolVersions'))).toBe(true);
    expect(lines.some((l) => l.startsWith('client'))).toBe(true);
  });

  it('labels a root-level issue rather than emitting an empty path', () => {
    const result = parseParams(METHOD.SessionClose, 'not-an-object');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(formatIssues(result.issues)[0]).toMatch(/^\(root\): /);
  });

  it('applies declared defaults so a caller need not send empty arrays', () => {
    const result = parseParams(METHOD.TurnSubmit, { sessionId: 's', prompt: 'fix the test' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attachments).toEqual([]);
  });

  it('rejects an empty prompt', () => {
    expect(TurnSubmitParamsSchema.safeParse({ sessionId: 's', prompt: '' }).success).toBe(false);
  });

  it('requires an absolute-ish workspace root to be supplied at all', () => {
    // The engine may be a sidecar started from an unrelated directory, so it must
    // never fall back to its own cwd.
    expect(SessionCreateParamsSchema.safeParse({}).success).toBe(false);
    expect(SessionCreateParamsSchema.safeParse({ workspaceRoot: '/w' }).success).toBe(true);
  });

  it('rejects unknown keys on params', () => {
    expect(
      InitializeParamsSchema.safeParse({
        protocolVersions: [PROTOCOL_VERSION],
        client: { name: 'x', version: '1' },
        capabilities: {},
      }).success,
    ).toBe(false);
  });
});

describe('event stream', () => {
  const base = { sessionId: 's-1', turnId: 't-1', seq: 0 };

  it('round-trips a text delta', () => {
    const event = { type: 'text.delta' as const, ...base, text: 'hello' };
    expect(AdzeEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it('round-trips a refusal, which is a normal event rather than an error', () => {
    const event = {
      type: 'edit.refused' as const,
      ...base,
      refused: {
        editId: 'e-1',
        path: 'src/a.ts',
        reason: 'ambiguous' as const,
        message: 'matched 2 times (lines 4, 9); add context or set occurrence',
        candidates: [{ start: 10, end: 20, line: 4, strategy: 'exact' as const }],
        telemetry: {
          tier: 'search-replace' as const,
          validation: { ok: false, validator: 'structural' as const },
          durationMs: 1.2,
          tiersAttempted: 2,
          editCount: 1,
          bytesChanged: 0,
        },
      },
    };
    const parsed = AdzeEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(parsed).toEqual(event);
  });

  it('lists every event type without a hand-maintained list', () => {
    expect(ADZE_EVENT_TYPES).toContain('turn.started');
    expect(ADZE_EVENT_TYPES).toContain('edit.refused');
    expect(ADZE_EVENT_TYPES).toContain('turn.completed');
    expect(new Set(ADZE_EVENT_TYPES).size).toBe(ADZE_EVENT_TYPES.length);
    expect(ADZE_EVENT_TYPES.length).toBe(11);
  });

  it('identifies exactly one terminal event type', () => {
    const usage = makeUsage({ inputTokens: 10, cachedInputTokens: 90, outputTokens: 5 });
    const completed = AdzeEventSchema.parse({
      type: 'turn.completed',
      ...base,
      stopReason: 'end-turn',
      model: 'test-model',
      usage,
      steps: 2,
    });
    expect(isTerminalEvent(completed)).toBe(true);

    const delta = AdzeEventSchema.parse({ type: 'text.delta', ...base, text: 'x' });
    expect(isTerminalEvent(delta)).toBe(false);
  });

  it('rejects an unknown event type', () => {
    expect(AdzeEventSchema.safeParse({ type: 'text.chunk', ...base, text: 'x' }).success).toBe(
      false,
    );
  });

  it('rejects a negative sequence number', () => {
    expect(
      AdzeEventSchema.safeParse({ type: 'text.delta', ...base, seq: -1, text: 'x' }).success,
    ).toBe(false);
  });

  it('keeps a denied tool distinct from a tool that ran and failed', () => {
    // Conflating them would let a denied action appear in a trajectory log as an
    // execution, which corrupts the artifact benchmark claims are checked against.
    const denied = AdzeEventSchema.parse({
      type: 'tool.denied',
      ...base,
      callId: 'c-1',
      name: 'bash',
      source: 'gate',
      reason: 'approval policy is never; refusing rather than escalating',
    });
    expect(denied.type).toBe('tool.denied');

    const failed = AdzeEventSchema.parse({
      type: 'tool.finished',
      ...base,
      result: { callId: 'c-1', ok: false, content: [], truncated: false },
    });
    expect(failed.type).toBe('tool.finished');
  });
});

describe('usage and cost', () => {
  it('computes the cache hit rate from disjoint buckets', () => {
    // inputTokens and cachedInputTokens do not overlap: the prompt size is their
    // sum. This shape makes the double-counting bug unrepresentable rather than
    // merely discouraged.
    expect(computeCacheHitRate(200, 800)).toBeCloseTo(0.8);
    expect(computeCacheHitRate(1000, 0)).toBe(0);
  });

  it('reports zero rather than a perfect rate for a turn that sent nothing', () => {
    // Returning 1.0 for "nothing missed the cache" would put a perfect hit rate
    // into a report that measured nothing at all.
    expect(computeCacheHitRate(0, 0)).toBe(0);
  });

  it('builds usage with a derived hit rate', () => {
    const usage = makeUsage({ inputTokens: 100, cachedInputTokens: 300, outputTokens: 40 });
    expect(usage.cacheHitRate).toBeCloseTo(0.75);
    expect(UsageSchema.safeParse(usage).success).toBe(true);
  });

  it('omits reasoning tokens rather than defaulting them to zero', () => {
    // Zero reasoning tokens and "the provider does not report reasoning tokens"
    // are different claims, and a report should not conflate them.
    const usage = makeUsage({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 });
    expect(Object.hasOwn(usage, 'reasoningTokens')).toBe(false);
  });

  it('rejects a hit rate outside [0, 1]', () => {
    const usage = makeUsage({ inputTokens: 1, cachedInputTokens: 1, outputTokens: 1 });
    expect(UsageSchema.safeParse({ ...usage, cacheHitRate: 1.5 }).success).toBe(false);
    expect(UsageSchema.safeParse({ ...usage, cacheHitRate: -0.1 }).success).toBe(false);
  });

  it('rejects fractional token counts', () => {
    const usage = makeUsage({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 });
    expect(UsageSchema.safeParse({ ...usage, outputTokens: 1.5 }).success).toBe(false);
  });
});

describe('permissions', () => {
  it('treats only `never` as refuse-rather-than-escalate', () => {
    expect(refusesRatherThanPrompts('never')).toBe(true);
    expect(refusesRatherThanPrompts('on-request')).toBe(false);
    expect(refusesRatherThanPrompts('untrusted')).toBe(false);
  });

  it('reports gate-only enforcement on Windows for both containment modes', () => {
    // ADR-0007: there is no OS-level containment on Windows, in Adze or in any
    // open-source coding agent. A surface must be able to say so.
    expect(sandboxEnforcement('win32', 'workspace-write')).toBe('gate-only');
    expect(sandboxEnforcement('win32', 'read-only')).toBe('gate-only');
  });

  it('reports OS-level enforcement on macOS and Linux', () => {
    expect(sandboxEnforcement('darwin', 'workspace-write')).toBe('os-level');
    expect(sandboxEnforcement('linux', 'read-only')).toBe('os-level');
  });

  it('reports full-access as not-applicable rather than as containment', () => {
    // The user asked for no containment and got it. Calling that "enforced" would
    // be technically true and completely misleading.
    expect(sandboxEnforcement('darwin', 'full-access')).toBe('not-applicable');
    expect(sandboxEnforcement('win32', 'full-access')).toBe('not-applicable');
  });

  it('requires an approval request to carry the mode and policy in force', () => {
    const ok = ApprovalRequestSchema.safeParse({
      requestId: 'a-1',
      kind: 'command',
      summary: 'run the test suite',
      reason: 'workspace-write denies network, and this command fetches',
      command: ['npm', 'test'],
    });
    expect(ok.success).toBe(true);

    // A prompt that cannot explain itself is the one users click through.
    expect(
      ApprovalRequestSchema.safeParse({ requestId: 'a-1', kind: 'command', summary: 'x' }).success,
    ).toBe(false);
  });
});

describe('tool results', () => {
  it('accepts a truncated result carrying its truncation detail', () => {
    const result = ToolResultSchema.parse({
      callId: 'c-1',
      ok: true,
      content: [{ type: 'text', text: 'first 200 lines' }],
      truncated: true,
      truncation: { originalBytes: 90_000, returnedBytes: 4_000, continuation: 'tok' },
    });
    expect(toolResultTruncationIsConsistent(result)).toBe(true);
  });

  it('flags a truncated result with no truncation detail', () => {
    // Kept as a predicate rather than a `.refine()`: JSON Schema cannot express
    // the dependency, and a Zod schema stricter than the published JSON Schema
    // would make the generated artifact a lie about what the wire accepts.
    const result = ToolResultSchema.parse({
      callId: 'c-1',
      ok: true,
      content: [],
      truncated: true,
    });
    expect(toolResultTruncationIsConsistent(result)).toBe(false);
  });

  it('carries images out of tools, not only into them', () => {
    const result = ToolResultSchema.safeParse({
      callId: 'c-1',
      ok: true,
      content: [{ type: 'image', mediaType: 'image/png', data: 'aGk=' }],
      truncated: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an image media type no provider accepts', () => {
    expect(
      ToolResultSchema.safeParse({
        callId: 'c-1',
        ok: true,
        content: [{ type: 'image', mediaType: 'image/tiff', data: 'aGk=' }],
        truncated: false,
      }).success,
    ).toBe(false);
  });
});
