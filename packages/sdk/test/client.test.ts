/**
 * Client construction and configuration validation.
 *
 * Everything asserted here is refused *before* anything runs. That placement is the
 * point: a `workspaceRoot` that resolves against the wrong directory, a spend ceiling
 * that cannot be priced, or an object that is not a provider all fail much later and
 * much less legibly if they are allowed through — inside the turn machine, with a
 * message about the loop rather than about the configuration the embedder wrote.
 *
 * The seam handles (`provider`, `tools`, `plugins`, `retrieval`) are the reason a
 * whole file of runtime shape checks exists at all. Their real interfaces live in
 * `@adze/core` vocabulary that `@adze/protocol` has no equivalent for, so this
 * package cannot name them in a public type position without re-exporting a core
 * internal. The compiler therefore cannot check them and these tests must.
 */

import { describe, expect, it } from 'vitest';
import { AdzeConfigError, createClient, scriptedProvider } from '../src/index.js';
import { harness, PRICES, WORKSPACE } from './support.js';

const MODEL = { provider: 'scripted', model: 'offline-2026-08-29' } as const;

function provider() {
  return scriptedProvider({ script: [{ text: 'ok' }] });
}

describe('createClient', () => {
  it('negotiates a protocol version and reports honest capabilities', () => {
    const { client, stop } = harness({ script: [{ text: 'ok' }] });

    expect(client.protocolVersion).toBe('0.1');
    expect(client.engine.name).toBe('@adze/core');
    expect(client.capabilities.turns).toBe(true);
    expect(client.capabilities.nativeToolCalling).toBe(true);
    // Every false below is a roadmap item reporting itself as absent. A surface that
    // reads `retrieval: false` degrades on purpose; one that discovered it by calling
    // `grep` and getting nothing degrades by accident.
    expect(client.capabilities.retrieval).toBe(false);
    expect(client.capabilities.mcpClient).toBe(false);
    expect(client.capabilities.osSandbox).toBe(false);

    stop();
  });

  it('surfaces the no-os-sandbox warning at construction, before any approval', () => {
    const { client, stop } = harness({ script: [{ text: 'ok' }] });

    const codes = client.warnings.map((warning) => warning.code);
    expect(codes).toContain('no-os-sandbox');
    // Reported before a turn rather than after: a user about to approve a command
    // needs to know there is no containment first.
    expect(client.warnings.find((w) => w.code === 'no-os-sandbox')?.reference).toContain('0007');

    stop();
  });

  it('reports a provider without native tool calling as degraded', () => {
    const client = createClient({
      workspaceRoot: WORKSPACE,
      model: MODEL,
      commandExecution: 'disabled',
      provider: scriptedProvider({ script: [{ text: 'ok' }], nativeToolCalling: false }),
    });

    expect(client.capabilities.nativeToolCalling).toBe(false);
    expect(client.warnings.map((w) => w.code)).toContain('degraded-provider');
  });

  it('refuses a relative workspaceRoot', () => {
    expect(() =>
      createClient({ workspaceRoot: './repo', model: MODEL, provider: provider() }),
    ).toThrow(AdzeConfigError);
    expect(() =>
      createClient({ workspaceRoot: './repo', model: MODEL, provider: provider() }),
    ).toThrow(/absolute path/);
  });

  it('refuses an empty workspaceRoot', () => {
    expect(() => createClient({ workspaceRoot: '', model: MODEL, provider: provider() })).toThrow(
      /must not be empty/,
    );
  });

  it('refuses a relative writableRoot, naming the index', () => {
    expect(() =>
      createClient({
        workspaceRoot: WORKSPACE,
        model: MODEL,
        provider: provider(),
        sandbox: { mode: 'workspace-write', writableRoots: ['/tmp/ok', 'relative/bad'] },
      }),
    ).toThrow(/sandbox\.writableRoots\[1\]/);
  });

  it('refuses a value that is not a model provider, listing every missing member', () => {
    let thrown: unknown;
    try {
      createClient({
        workspaceRoot: WORKSPACE,
        model: MODEL,
        // The seam the compiler cannot check. `ModelProviderLike` declares only the
        // two fields the SDK reads, so this compiles and must fail at runtime.
        provider: { name: 'fake', nativeToolCalling: true },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AdzeConfigError);
    const message = (thrown as Error).message;
    expect(message).toContain('stream (expected function)');
    expect(message).toContain('priceFor (expected function)');
    expect(message).toContain('@adze/providers');
  });

  it('refuses a model selection the protocol rejects', () => {
    expect(() =>
      createClient({
        workspaceRoot: WORKSPACE,
        provider: provider(),
        // Temperature is bounded at 2 by the protocol schema.
        model: { provider: 'scripted', model: 'offline', temperature: 9 },
      }),
    ).toThrow(/invalid model/);
  });

  it('refuses maxSpendUsd when the provider cannot price the model', () => {
    let thrown: unknown;
    try {
      createClient({
        workspaceRoot: WORKSPACE,
        model: MODEL,
        provider: provider(),
        budget: { maxSpendUsd: 0.5 },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AdzeConfigError);
    // An accepted-but-unenforced ceiling is the money-shaped version of a permission
    // policy that grants more than it advertises.
    expect((thrown as Error).message).toContain('an unenforced budget is a suggestion');
  });

  it('accepts maxSpendUsd once the provider has prices', () => {
    expect(() =>
      createClient({
        workspaceRoot: WORKSPACE,
        model: MODEL,
        provider: scriptedProvider({ script: [{ text: 'ok' }], prices: PRICES }),
        budget: { maxSpendUsd: 0.5 },
      }),
    ).not.toThrow();
  });

  it('refuses a budget the protocol rejects', () => {
    expect(() =>
      createClient({
        workspaceRoot: WORKSPACE,
        model: MODEL,
        provider: provider(),
        budget: { maxSteps: 0 },
      }),
    ).toThrow(/invalid budget/);
  });

  it('refuses a half-specified limits object rather than inventing the other half', () => {
    expect(() =>
      createClient({
        workspaceRoot: WORKSPACE,
        model: MODEL,
        provider: provider(),
        limits: { maxResultBytes: 1024 },
      }),
    ).toThrow(/requires both/);
  });

  it('refuses a tool that cannot receive arguments through a schema', () => {
    expect(() =>
      createClient({
        workspaceRoot: WORKSPACE,
        model: MODEL,
        provider: provider(),
        tools: [{ name: 'x', description: 'x', parameters: {} }],
      }),
    ).toThrow(/tools\[0\].*prepare \(expected function\)/s);
  });

  it('refuses a retrieval backend missing a signal', () => {
    expect(() =>
      createClient({
        workspaceRoot: WORKSPACE,
        model: MODEL,
        provider: provider(),
        retrieval: { name: 'half' },
      }),
    ).toThrow(/retrieval is not a search backend/);
  });
});

describe('sessions', () => {
  it('reports the settings actually in force, not the ones requested', async () => {
    const { client, stop } = harness({ script: [{ text: 'ok' }] });
    const session = await client.createSession({
      sandbox: { mode: 'read-only' },
      approvals: 'never',
    });

    expect(session.sandbox.mode).toBe('read-only');
    expect(session.approvals).toBe('never');
    expect(session.model.model).toBe('offline-2026-08-29');
    expect(session.warnings.map((w) => w.code)).toContain('no-os-sandbox');

    stop();
    await client.dispose();
  });

  it('carries the client defaults into a session created with no options', async () => {
    const { client, stop } = harness({ script: [{ text: 'ok' }], approvals: 'untrusted' });
    const session = await client.createSession();

    expect(session.approvals).toBe('untrusted');
    expect(session.sandbox.mode).toBe('workspace-write');

    stop();
    await client.dispose();
  });

  it('refuses an empty prompt', async () => {
    const { client, stop } = harness({ script: [{ text: 'ok' }] });
    const session = await client.createSession();

    await expect(session.submit({ prompt: '   ' })).rejects.toThrow(AdzeConfigError);

    stop();
    await client.dispose();
  });

  it('refuses a second concurrent turn with an actionable message', async () => {
    const { client, stop } = harness({ script: [{ delayMs: 200, text: 'slow' }] });
    const session = await client.createSession();
    const first = await session.submit({ prompt: 'one' });

    await expect(session.submit({ prompt: 'two' })).rejects.toThrow(/already has a turn in flight/);

    first.cancel();
    await first.result();
    stop();
    await client.dispose();
  });
});
