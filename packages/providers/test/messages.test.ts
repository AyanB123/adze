import type { ConversationMessage, ToolSpec } from '@adze/core';
import { describe, expect, it } from 'vitest';
import { toModelMessages, toToolSet } from '../src/messages.js';

function system(text: string): ConversationMessage {
  return { role: 'system', origin: 'engine', content: [{ type: 'text', text }] };
}
function user(text: string): ConversationMessage {
  return { role: 'user', origin: 'user', content: [{ type: 'text', text }] };
}

/** The one-pixel PNG the protocol's base64 attachment shape expects. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAMBAQAY3Y2wAAAAAElFTkSuQmCC';

describe('the cache breakpoint', () => {
  it('marks the last message of the prefix', () => {
    // Anthropic caches only where a marker is placed. Without it a byte-identical prefix
    // is re-billed at the full input rate on every step, and the whole epoch design —
    // frozen baseline, ordered mid-conversation additions, rolls only on a structural
    // change — buys nothing at all.
    const messages = toModelMessages([system('baseline'), user('a'), user('b')], 1);

    expect(messages[0]?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
    expect(messages[1]?.providerOptions).toBeUndefined();
    expect(messages[2]?.providerOptions).toBeUndefined();
  });

  it('marks the boundary when the prefix is more than one message', () => {
    const messages = toModelMessages([system('a'), system('b'), user('c')], 2);

    expect(messages[0]?.providerOptions).toBeUndefined();
    expect(messages[1]?.providerOptions).toBeDefined();
  });

  it('places no marker when there is no prefix', () => {
    const messages = toModelMessages([user('a')], 0);

    expect(messages[0]?.providerOptions).toBeUndefined();
  });

  it('clamps a prefix longer than the history instead of losing the marker', () => {
    // An out-of-range index would put the marker nowhere and silently disable caching for
    // the whole run — the failure this function exists to prevent, and one visible only
    // as a bill.
    const messages = toModelMessages([system('a'), user('b')], 99);

    expect(messages[messages.length - 1]?.providerOptions).toBeDefined();
  });

  it('scopes the marker to Anthropic', () => {
    // OpenAI caches by prefix hash and rejects unknown top-level fields, so a shared key
    // would turn a cost optimisation into a failed request.
    const messages = toModelMessages([system('a'), user('b')], 1);

    expect(Object.keys(messages[0]?.providerOptions ?? {})).toEqual(['anthropic']);
  });

  it('produces a byte-identical array for a byte-identical prefix', () => {
    // The assertion the epoch design actually makes. Comparing object graphs would pass
    // for a prefix rebuilt with a new timestamp in a field the comparison ignored.
    const history = [system('baseline'), user('a')];
    const first = JSON.stringify(toModelMessages(history, 1));
    const second = JSON.stringify(toModelMessages([...history, user('b')], 1).slice(0, 1));

    expect(second).toBe(JSON.stringify(JSON.parse(first).slice(0, 1)));
  });
});

describe('history conversion', () => {
  it('carries tool calls as native calls, never as a JSON string', () => {
    // ADR-0004: the JSON-in-a-string transport carries a measured ~7.3% invalid-JSON
    // rejection rate on open-weight rollouts. There is no code path here that produces
    // one, and this test is what keeps it that way.
    const messages = toModelMessages(
      [
        {
          role: 'assistant',
          origin: 'model',
          content: [{ type: 'text', text: 'running it' }],
          toolCalls: [{ callId: 'c1', name: 'bash', arguments: { command: 'pnpm test' } }],
        },
      ],
      0,
    );

    const content = messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) return;
    const call = content.find((part) => part.type === 'tool-call');
    expect(call).toMatchObject({
      type: 'tool-call',
      toolCallId: 'c1',
      toolName: 'bash',
      input: { command: 'pnpm test' },
    });
  });

  it('omits an empty assistant text part rather than sending a blank one', () => {
    const messages = toModelMessages(
      [
        {
          role: 'assistant',
          origin: 'model',
          content: [],
          toolCalls: [{ callId: 'c1', name: 'bash', arguments: {} }],
        },
      ],
      0,
    );

    const content = messages[0]?.content;
    if (!Array.isArray(content)) throw new Error('expected parts');
    expect(content.filter((part) => part.type === 'text')).toHaveLength(0);
  });

  it('marks a failed tool result as an error rather than as ordinary content', () => {
    // The model has to be able to tell a refusal from output. Sending a denial as plain
    // text makes it guess.
    const messages = toModelMessages(
      [
        {
          role: 'tool',
          origin: 'tool',
          callId: 'c1',
          name: 'bash',
          ok: false,
          content: [{ type: 'text', text: 'denied: needs approval' }],
        },
      ],
      0,
    );

    const content = messages[0]?.content;
    if (!Array.isArray(content)) throw new Error('expected parts');
    expect(content[0]).toMatchObject({
      type: 'tool-result',
      output: { type: 'error-text', value: 'denied: needs approval' },
    });
  });

  it('keeps an image a tool returned', () => {
    // ADR-0004 requires images to flow out of tools as well as in; a screenshot tool that
    // could only return text would defeat the point.
    const messages = toModelMessages(
      [
        {
          role: 'tool',
          origin: 'tool',
          callId: 'c1',
          name: 'screenshot',
          ok: true,
          content: [{ type: 'image', mediaType: 'image/png', data: PNG }],
        },
      ],
      0,
    );

    const content = messages[0]?.content;
    if (!Array.isArray(content)) throw new Error('expected parts');
    expect(content[0]).toMatchObject({
      output: { type: 'content', value: [{ type: 'file', mediaType: 'image/png' }] },
    });
  });

  it('carries a user image without re-encoding it', () => {
    const messages = toModelMessages(
      [
        {
          role: 'user',
          origin: 'user',
          content: [
            { type: 'text', text: 'what is wrong here' },
            { type: 'image', mediaType: 'image/png', data: PNG },
          ],
        },
      ],
      0,
    );

    const content = messages[0]?.content;
    if (!Array.isArray(content)) throw new Error('expected parts');
    expect(content[1]).toEqual({ type: 'image', image: PNG, mediaType: 'image/png' });
  });

  it('flattens a system message to text', () => {
    expect(toModelMessages([system('one\ntwo')], 0)[0]).toMatchObject({
      role: 'system',
      content: 'one\ntwo',
    });
  });

  it('preserves order, because the trajectory is the prompt', () => {
    const messages = toModelMessages([system('s'), user('u1'), user('u2')], 0);

    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'user']);
  });
});

describe('tool conversion', () => {
  const specs: readonly ToolSpec[] = [
    {
      name: 'bash',
      description: 'run a command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
    { name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } },
  ];

  it('carries the registry name, description, and JSON Schema', () => {
    const tools = toToolSet(specs);

    expect(Object.keys(tools)).toEqual(['bash', 'read']);
    expect(tools.bash?.description).toBe('run a command');
  });

  it('declares no execute, so the SDK cannot run a tool around the gate', () => {
    // The single most important line in this file. A tool the SDK could execute would be
    // a tool that never passed the permission gate, and that invariant has no exceptions.
    for (const tool of Object.values(toToolSet(specs))) {
      expect('execute' in tool && tool.execute !== undefined).toBe(false);
    }
  });

  it('preserves the order the registry supplied, which is part of the cached prefix', () => {
    // The registry sorts by name because the tool list is cached with the prefix for most
    // providers. Reordering it is a cache miss on every step of every turn.
    expect(Object.keys(toToolSet([...specs].reverse()))).toEqual(['read', 'bash']);
  });
});
