import type { AdzeEvent, ApplyTelemetry } from '@adze/protocol';
import { makeUsage } from '@adze/protocol';
import { describe, expect, it } from 'vitest';
import { INITIAL_VIEW_MODEL, reduce, reduceAll } from '../src/chat/view-model.js';

const SESSION = 'sess_1';
const TURN = 'turn_1';

let sequence = 0;

function base(): { sessionId: string; turnId: string; seq: number } {
  const seq = sequence;
  sequence += 1;
  return { sessionId: SESSION, turnId: TURN, seq };
}

function telemetry(overrides: Partial<ApplyTelemetry> = {}): ApplyTelemetry {
  return {
    tier: 'search-replace',
    strategy: 'exact',
    validation: { ok: true, validator: 'tree-sitter' },
    durationMs: 2,
    tiersAttempted: 1,
    editCount: 1,
    bytesChanged: 12,
    ...overrides,
  };
}

function started(): AdzeEvent {
  return { type: 'turn.started', ...base(), model: 'anthropic/x', cacheEpoch: 0, warnings: [] };
}

describe('reduce', () => {
  it('concatenates text deltas rather than replacing them', () => {
    sequence = 0;
    const state = reduceAll([
      started(),
      { type: 'text.delta', ...base(), text: 'Hello, ' },
      { type: 'text.delta', ...base(), text: 'world' },
    ]);
    expect(state.assistantText).toBe('Hello, world');
    expect(state.status).toBe('running');
  });

  it('resets accumulated turn state when a new turn starts', () => {
    sequence = 0;
    const first = reduceAll([started(), { type: 'text.delta', ...base(), text: 'old' }]);
    const second = reduce(first, {
      type: 'turn.started',
      sessionId: SESSION,
      turnId: 'turn_2',
      seq: 0,
      model: 'anthropic/x',
      cacheEpoch: 1,
      warnings: [],
    });
    expect(second.assistantText).toBe('');
    expect(second.turnId).toBe('turn_2');
    expect(second.cacheEpoch).toBe(1);
  });

  it('keeps a denial distinct from a tool that ran and failed', () => {
    sequence = 0;
    const state = reduceAll([
      started(),
      {
        type: 'tool.started',
        ...base(),
        call: { callId: 'c1', name: 'bash', arguments: {} },
        step: 0,
      },
      {
        type: 'tool.denied',
        ...base(),
        callId: 'c1',
        name: 'bash',
        source: 'gate',
        reason: 'writes outside the workspace',
      },
      {
        type: 'tool.started',
        ...base(),
        call: { callId: 'c2', name: 'read', arguments: {} },
        step: 1,
      },
      {
        type: 'tool.finished',
        ...base(),
        result: { callId: 'c2', ok: false, content: [], truncated: false, error: 'ENOENT' },
      },
    ]);

    const denied = state.tools.find((tool) => tool.callId === 'c1');
    const failed = state.tools.find((tool) => tool.callId === 'c2');
    expect(denied?.state).toBe('denied');
    expect(denied?.detail).toBe('gate: writes outside the workspace');
    expect(failed?.state).toBe('failed');
    // The two must not be the same state, or a working gate reads as a broken tool.
    expect(denied?.state).not.toBe(failed?.state);
  });

  it('preserves the tool name from tool.started when the result carries only an id', () => {
    sequence = 0;
    const state = reduceAll([
      started(),
      {
        type: 'tool.started',
        ...base(),
        call: { callId: 'c1', name: 'edit', arguments: { path: 'a.ts' } },
        step: 0,
      },
      {
        type: 'tool.finished',
        ...base(),
        result: { callId: 'c1', ok: true, content: [], truncated: true },
      },
    ]);
    expect(state.tools[0]?.name).toBe('edit');
    expect(state.tools[0]?.truncated).toBe(true);
  });

  it('reports the validator level that ran, without widening it', () => {
    sequence = 0;
    const state = reduceAll([
      started(),
      {
        type: 'edit.proposed',
        ...base(),
        proposal: { editId: 'e1', path: 'a.ts', edits: [{ search: 'a', replace: 'b' }] },
      },
      {
        type: 'edit.applied',
        ...base(),
        applied: {
          editId: 'e1',
          path: 'a.ts',
          telemetry: telemetry({ validation: { ok: true, validator: 'structural' } }),
          locations: [],
        },
      },
    ]);
    expect(state.edits).toHaveLength(1);
    expect(state.edits[0]?.state).toBe('applied');
    expect(state.edits[0]?.validator).toBe('structural');
  });

  it('renders a refusal as its own state and keeps the applier message', () => {
    sequence = 0;
    const state = reduceAll([
      started(),
      {
        type: 'edit.proposed',
        ...base(),
        proposal: { editId: 'e1', path: 'a.ts', edits: [{ search: 'a', replace: 'b' }] },
      },
      {
        type: 'edit.refused',
        ...base(),
        refused: {
          editId: 'e1',
          path: 'a.ts',
          reason: 'ambiguous',
          message: 'found 3 candidates at lines 4, 9, 21',
          telemetry: telemetry(),
        },
      },
    ]);
    expect(state.edits[0]?.state).toBe('refused');
    expect(state.edits[0]?.reason).toBe('ambiguous');
    expect(state.edits[0]?.message).toContain('3 candidates');
  });

  it('replaces the todo list rather than merging it', () => {
    sequence = 0;
    const state = reduceAll([
      started(),
      {
        type: 'todo.updated',
        ...base(),
        items: [
          { id: '1', content: 'first', status: 'completed' },
          { id: '2', content: 'second', status: 'pending' },
        ],
      },
      {
        type: 'todo.updated',
        ...base(),
        items: [{ id: '3', content: 'third', status: 'pending' }],
      },
    ]);
    expect(state.todos).toHaveLength(1);
    expect(state.todos[0]?.id).toBe('3');
  });

  it('counts a gap in seq so a partial transcript cannot look complete', () => {
    const state = reduceAll([
      {
        type: 'turn.started',
        sessionId: SESSION,
        turnId: TURN,
        seq: 0,
        model: 'm',
        cacheEpoch: 0,
        warnings: [],
      },
      { type: 'text.delta', sessionId: SESSION, turnId: TURN, seq: 1, text: 'a' },
      // seq 2 and 3 never arrived: a gap of two.
      { type: 'text.delta', sessionId: SESSION, turnId: TURN, seq: 4, text: 'b' },
    ]);
    expect(state.droppedEvents).toBe(2);
    expect(state.assistantText).toBe('ab');
  });

  it('does not count the previous turn as dropped when a new turn begins', () => {
    const first = reduceAll([
      {
        type: 'turn.started',
        sessionId: SESSION,
        turnId: TURN,
        seq: 0,
        model: 'm',
        cacheEpoch: 0,
        warnings: [],
      },
      { type: 'text.delta', sessionId: SESSION, turnId: TURN, seq: 9, text: 'a' },
    ]);
    // seq 1 through 8 never arrived.
    expect(first.droppedEvents).toBe(8);
    const second = reduce(first, {
      type: 'turn.started',
      sessionId: SESSION,
      turnId: 'turn_2',
      seq: 0,
      model: 'm',
      cacheEpoch: 0,
      warnings: [],
    });
    expect(second.droppedEvents).toBe(0);
  });

  it('carries usage, steps, and stop reason off the terminal event', () => {
    sequence = 0;
    const usage = makeUsage({ inputTokens: 100, cachedInputTokens: 900, outputTokens: 50 });
    const state = reduceAll([
      started(),
      { type: 'usage.updated', ...base(), model: 'm', usage, steps: 2 },
      {
        type: 'turn.completed',
        ...base(),
        stopReason: 'refused',
        model: 'm',
        usage,
        steps: 3,
        message: 'the applier refused',
      },
    ]);
    expect(state.status).toBe('finished');
    expect(state.stopReason).toBe('refused');
    expect(state.steps).toBe(3);
    expect(state.usage?.cacheHitRate).toBeCloseTo(0.9);
    expect(state.message).toBe('the applier refused');
  });

  it('starts from an inert state', () => {
    expect(INITIAL_VIEW_MODEL.status).toBe('idle');
    expect(INITIAL_VIEW_MODEL.droppedEvents).toBe(0);
    expect(INITIAL_VIEW_MODEL.assistantText).toBe('');
  });
});
