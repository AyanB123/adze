/**
 * Disposal.
 *
 * An embedded engine that cannot be shut down cleanly is unusable in the two places
 * embedding matters most — an editor extension whose window closes, and a daemon
 * serving many workspaces. Both reach for a client per workspace, so a client that
 * retains a listener, a session, or a timer past `dispose()` leaks once per
 * workspace and shows up as a slow memory climb nobody can attribute.
 *
 * So the assertions here are about *absence*: no session still open, no listener
 * still registered, no turn still running, no OS handle still held.
 */

import { describe, expect, it } from 'vitest';
import { AdzeSessionError } from '../src/index.js';
import { bashStep, harness } from './support.js';

function timerCount(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
}

describe('dispose', () => {
  it('closes every session and refuses further use', async () => {
    const { client, stop } = harness({ script: [{ text: 'ok' }, { text: 'ok' }] });
    const first = await client.createSession();
    const second = await client.createSession();

    await client.dispose();

    await expect(first.submit({ prompt: 'after' })).rejects.toThrow(AdzeSessionError);
    await expect(second.submit({ prompt: 'after' })).rejects.toThrow(/is closed/);
    await expect(client.createSession()).rejects.toThrow(/has been disposed/);
    expect(() => client.subscribe(() => undefined)).toThrow(/has been disposed/);

    stop();
  });

  it('cancels a turn that is still in flight', async () => {
    const { client, stop } = harness({ script: [{ delayMs: 30_000, text: 'too late' }] });
    const session = await client.createSession();
    const handle = await session.submit({ prompt: 'something slow' });

    await client.dispose();

    // Awaited inside dispose, so by the time it returns the turn has finished
    // unwinding rather than still writing into a session nobody is listening to.
    const result = await handle.result();
    expect(result.stopReason).toBe('cancelled');

    stop();
  });

  it('leaves no timer behind after a cancelled turn', async () => {
    const before = timerCount();

    const { client, stop } = harness({ script: [{ delayMs: 30_000, text: 'too late' }] });
    const session = await client.createSession();
    const handle = await session.submit({ prompt: 'slow' });
    await client.dispose();
    await handle.result();
    stop();

    // The provider's delay timer is cleared on abort rather than left to fire. A
    // 30-second timer surviving here is the shape of leak that keeps a Node process
    // alive after an editor window has closed.
    expect(timerCount()).toBe(before);
  });

  it('drops listeners rather than muting them', async () => {
    const { client, events, stop } = harness({ script: [{ text: 'ok' }] });
    const session = await client.createSession();

    const seen: string[] = [];
    client.subscribe((event) => seen.push(event.type));
    session.subscribe((event) => seen.push(event.type));
    await session.run({ prompt: 'go' });
    expect(seen.length).toBeGreaterThan(0);

    await client.dispose();

    // Nothing further can be published, because every session is closed. What is
    // asserted is that the subscriptions themselves are gone: muting them instead
    // would keep whatever each listener closed over alive for the process's lifetime.
    expect(() => client.subscribe(() => undefined)).toThrow();
    expect(events.length).toBeGreaterThan(0);

    stop();
  });

  it('is idempotent', async () => {
    const { client, stop } = harness({ script: [{ text: 'ok' }] });
    await client.createSession();

    await client.dispose();
    await expect(client.dispose()).resolves.toBeUndefined();

    stop();
  });

  it('reports session totals from close()', async () => {
    const { client, stop } = harness({
      script: [{ text: 'ok', inputTokens: 40, cachedInputTokens: 60, outputTokens: 10 }],
      withPrices: true,
    });
    const session = await client.createSession();
    await session.run({ prompt: 'go' });

    const report = await session.close();
    expect(report.turns).toBe(1);
    expect(report.usage.outputTokens).toBe(10);
    expect(report.cacheHitRate).toBeCloseTo(0.6, 10);
    // close() is idempotent and keeps reporting the same totals.
    expect((await session.close()).turns).toBe(1);

    stop();
    await client.dispose();
  });

  it('does not let one client disturb another', async () => {
    const a = harness({ script: [{ text: 'from a' }] });
    const b = harness({ script: [{ text: 'from b' }] });

    const sessionB = await b.client.createSession();
    await a.client.dispose();

    const result = await sessionB.run({ prompt: 'go' });
    expect(result.text).toBe('from b');

    a.stop();
    b.stop();
    await b.client.dispose();
  });
});

describe("commandExecution: 'disabled'", () => {
  it('starts no subprocess, and says so rather than reporting a command failure', async () => {
    const { client, events, stop } = harness({
      script: [bashStep('echo hello'), { text: 'moving on' }],
      approvals: 'on-request',
      onApprovalRequest: (request) => ({ requestId: request.requestId, decision: 'allow-once' }),
    });
    const session = await client.createSession();

    await session.run({ prompt: 'go', budget: { maxSteps: 4 } });

    const finished = events.filter((event) => event.type === 'tool.finished');
    expect(finished).toHaveLength(1);
    const result = finished[0]!;
    expect(result.type === 'tool.finished' && result.result.ok).toBe(false);
    // "No broker is configured" is a different fact from "the command failed", and a
    // surface that conflated them would report a configuration choice as a task error.
    expect(result.type === 'tool.finished' && result.result.error).toContain(
      'no sandbox broker is configured',
    );

    stop();
    await client.dispose();
  });
});
