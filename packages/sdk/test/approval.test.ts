/**
 * The approval channel.
 *
 * The property under test throughout is that **consent is only ever inferred from an
 * explicit allow**. Every other outcome — a `never` policy, a missing handler, a
 * handler that throws, a handler that answers the wrong request — lands on a denial.
 * That direction is not a defensive style choice: an approval channel that could
 * produce consent by accident is not an approval channel, and this is the file where
 * that claim is checkable.
 *
 * The SDK never prompts, reads stdin, or writes to a stream. Deciding is the surface's
 * job, and a library that prompted would be unusable from a GUI, a daemon, or CI.
 */

import { describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '../src/index.js';
import { createClient, scriptedProvider } from '../src/index.js';
import { bashStep, eventsOfType, harness, WORKSPACE } from './support.js';

const MODEL = { provider: 'scripted', model: 'offline-2026-08-29' } as const;

describe('the approval handler', () => {
  it('is called with a request a human could act on, and allow-once is honoured', async () => {
    const seen: ApprovalRequest[] = [];
    const { client, events, stop } = harness({
      script: [bashStep('pnpm test'), { text: 'Tests ran.' }],
      approvals: 'on-request',
      onApprovalRequest: (request) => {
        seen.push(request);
        return { requestId: request.requestId, decision: 'allow-once' };
      },
    });
    const session = await client.createSession();

    const result = await session.run({ prompt: 'run the tests', budget: { maxSteps: 4 } });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.kind).toBe('command');
    // The argv as it would actually run, not the string the model wrote. A surface
    // that showed the latter would be asking for consent to something else.
    expect(seen[0]!.command).toEqual(['bash', '-lc', 'pnpm test']);
    // Written for someone deciding in under two seconds, and it says which rule or mode
    // stopped here rather than only that something did.
    expect(seen[0]!.summary.length).toBeGreaterThan(0);
    expect(seen[0]!.reason).toContain('needs approval');

    // `tool.started` is emitted only after authorization succeeds, so its presence is
    // the proof that the allow was honoured rather than merely recorded.
    expect(eventsOfType(events, 'tool.started').map((e) => e.call.name)).toEqual(['bash']);
    expect(eventsOfType(events, 'tool.denied')).toHaveLength(0);
    expect(result.stopReason).toBe('end-turn');

    stop();
    await client.dispose();
  });

  it('honours deny by stopping the call and letting the agent adapt', async () => {
    const { client, events, stop } = harness({
      script: [bashStep('curl example.com'), { text: 'I will not run that.' }],
      approvals: 'on-request',
      onApprovalRequest: (request) => ({
        requestId: request.requestId,
        decision: 'deny',
        note: 'not on this machine',
      }),
    });
    const session = await client.createSession();

    const result = await session.run({ prompt: 'fetch something', budget: { maxSteps: 4 } });

    const denied = eventsOfType(events, 'tool.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]!.source).toBe('gate');
    expect(denied[0]!.reason).toContain('the user denied this action');
    // The note is surfaced back to the model so it can choose another route.
    expect(denied[0]!.reason).toContain('not on this machine');
    expect(eventsOfType(events, 'tool.started')).toHaveLength(0);

    // `deny` is not `abort`: the turn continues and the model adapts.
    expect(result.stopReason).toBe('end-turn');
    expect(result.text).toBe('I will not run that.');

    stop();
    await client.dispose();
  });

  it('honours abort by ending the turn as refused', async () => {
    const { client, events, stop } = harness({
      script: [bashStep('shutdown now'), { text: 'never reached' }],
      approvals: 'on-request',
      onApprovalRequest: (request) => ({ requestId: request.requestId, decision: 'abort' }),
    });
    const session = await client.createSession();

    const result = await session.run({ prompt: 'go', budget: { maxSteps: 4 } });

    expect(result.stopReason).toBe('refused');
    expect(eventsOfType(events, 'tool.started')).toHaveLength(0);

    stop();
    await client.dispose();
  });

  it('remembers allow-session, so the same effect is asked about once', async () => {
    let calls = 0;
    const { client, events, stop } = harness({
      script: [bashStep('pnpm test'), bashStep('pnpm test'), { text: 'twice.' }],
      approvals: 'on-request',
      onApprovalRequest: (request) => {
        calls += 1;
        return { requestId: request.requestId, decision: 'allow-session' };
      },
    });
    const session = await client.createSession();

    await session.run({ prompt: 'run it twice', budget: { maxSteps: 6 } });

    expect(calls).toBe(1);
    expect(eventsOfType(events, 'tool.started')).toHaveLength(2);

    stop();
    await client.dispose();
  });

  it('is asked about an effect-free call under untrusted only if it has effects', async () => {
    let calls = 0;
    const { client, events, stop } = harness({
      script: [
        {
          toolCalls: [
            { name: 'todo', arguments: { items: [{ id: '1', content: 'x', status: 'pending' }] } },
          ],
        },
        { text: 'planned' },
      ],
      approvals: 'untrusted',
      onApprovalRequest: (request) => {
        calls += 1;
        return { requestId: request.requestId, decision: 'allow-once' };
      },
    });
    const session = await client.createSession();

    await session.run({ prompt: 'plan', budget: { maxSteps: 4 } });

    // `untrusted` means "approve every action", narrowed to every action that *does*
    // something. Manufacturing a prompt nobody can act on is how approval fatigue
    // starts, which ADR-0007 names as worse than not prompting.
    expect(calls).toBe(0);
    expect(eventsOfType(events, 'tool.started')).toHaveLength(1);

    stop();
    await client.dispose();
  });

  it('treats a handler that throws as a denial', async () => {
    const { client, events, stop } = harness({
      script: [bashStep('pnpm test'), { text: 'moving on' }],
      approvals: 'on-request',
      onApprovalRequest: () => {
        throw new Error('the UI went away');
      },
    });
    const session = await client.createSession();

    await session.run({ prompt: 'go', budget: { maxSteps: 4 } });

    const denied = eventsOfType(events, 'tool.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]!.reason).toContain('the approval handler threw');
    expect(eventsOfType(events, 'tool.started')).toHaveLength(0);

    stop();
    await client.dispose();
  });

  it('treats a malformed response as a denial', async () => {
    const { client, events, stop } = harness({
      script: [bashStep('pnpm test'), { text: 'moving on' }],
      approvals: 'on-request',
      // A decision the protocol does not define. Coercing it to the nearest valid
      // value would be guessing at consent.
      onApprovalRequest: (request) =>
        ({ requestId: request.requestId, decision: 'sure-why-not' }) as never,
    });
    const session = await client.createSession();

    await session.run({ prompt: 'go', budget: { maxSteps: 4 } });

    const denied = eventsOfType(events, 'tool.denied');
    expect(denied[0]!.reason).toContain('malformed response');
    expect(eventsOfType(events, 'tool.started')).toHaveLength(0);

    stop();
    await client.dispose();
  });

  it('treats an answer to a different request as a denial', async () => {
    const { client, events, stop } = harness({
      script: [bashStep('pnpm test'), { text: 'moving on' }],
      approvals: 'on-request',
      onApprovalRequest: () => ({ requestId: 'some-other-request', decision: 'allow-once' }),
    });
    const session = await client.createSession();

    await session.run({ prompt: 'go', budget: { maxSteps: 4 } });

    const denied = eventsOfType(events, 'tool.denied');
    expect(denied[0]!.reason).toContain('answered a different request');
    expect(eventsOfType(events, 'tool.started')).toHaveLength(0);

    stop();
    await client.dispose();
  });
});

describe("the 'never' policy", () => {
  it('refuses rather than escalating, and never consults the handler', async () => {
    let calls = 0;
    const { client, events, stop } = harness({
      script: [bashStep('pnpm test'), { text: 'I could not run that.' }],
      approvals: 'never',
      onApprovalRequest: (request) => {
        calls += 1;
        return { requestId: request.requestId, decision: 'allow-session' };
      },
    });
    const session = await client.createSession();

    const result = await session.run({ prompt: 'run the tests', budget: { maxSteps: 4 } });

    // The handler would have allowed it. It is never asked, because the policy forbids
    // asking — and a policy that silently granted more than it advertised would make
    // the whole permission model untrustworthy.
    expect(calls).toBe(0);

    const denied = eventsOfType(events, 'tool.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]!.source).toBe('gate');
    expect(denied[0]!.reason).toContain("'never'");
    expect(denied[0]!.reason).toContain('refuses rather than escalating');
    // Actionable: it names what would make this permitted instead of only refusing.
    expect(denied[0]!.reason).toMatch(/sandbox mode|command rule/);

    expect(eventsOfType(events, 'tool.started')).toHaveLength(0);
    expect(result.stopReason).toBe('end-turn');

    stop();
    await client.dispose();
  });

  it('still refuses when a turn narrows the policy to never mid-session', async () => {
    let calls = 0;
    const { client, events, stop } = harness({
      script: [bashStep('pnpm test'), { text: 'done' }],
      approvals: 'on-request',
      onApprovalRequest: (request) => {
        calls += 1;
        return { requestId: request.requestId, decision: 'allow-once' };
      },
    });
    const session = await client.createSession();

    await session.run({ prompt: 'go', approvals: 'never', budget: { maxSteps: 4 } });

    expect(calls).toBe(0);
    expect(eventsOfType(events, 'tool.denied')[0]!.reason).toContain("'never'");
    // The accessor reports the override, because a security display showing the
    // session's original setting while a different one was active would be stale in
    // the one place staleness matters.
    expect(session.approvals).toBe('never');

    stop();
    await client.dispose();
  });
});

describe('no approval channel at all', () => {
  it('refuses, because a missing handler is not an undeclared full-access mode', async () => {
    const client = createClient({
      workspaceRoot: WORKSPACE,
      model: MODEL,
      commandExecution: 'disabled',
      approvals: 'on-request',
      provider: scriptedProvider({ script: [bashStep('pnpm test'), { text: 'moving on' }] }),
    });
    const events: string[] = [];
    const reasons: string[] = [];
    const off = client.subscribe((event) => {
      events.push(event.type);
      if (event.type === 'tool.denied') reasons.push(event.reason);
    });
    const session = await client.createSession();

    await session.run({ prompt: 'go', budget: { maxSteps: 4 } });

    expect(reasons[0]).toContain('no approval channel is connected');
    expect(events).not.toContain('tool.started');

    off();
    await client.dispose();
  });
});
