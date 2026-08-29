import { describe, expect, it } from 'vitest';
import { NodeSubprocessBroker, NullBroker, scrubEnvironment } from '../src/broker.js';

const NODE = process.execPath;

/** Runs the current Node binary, so these tests are portable and touch no network. */
function script(source: string): readonly string[] {
  return [NODE, '-e', source];
}

function request(
  command: readonly string[],
  over: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
  return {
    command,
    cwd: process.cwd(),
    env: {},
    timeoutMs: over.timeoutMs ?? 10_000,
    signal: over.signal ?? new AbortController().signal,
    containment: {
      mode: 'workspace-write' as const,
      writableRoots: [process.cwd()],
      allowedNetworkHosts: [],
    },
  };
}

describe('NodeSubprocessBroker — stateless execution', () => {
  it('captures stdout and a zero exit', async () => {
    const outcome = await new NodeSubprocessBroker({ env: {} }).exec(
      request(script('process.stdout.write("hello")')),
    );
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.stdout).toBe('hello');
    expect(outcome.exitCode).toBe(0);
  });

  it('captures stderr and a non-zero exit', async () => {
    const outcome = await new NodeSubprocessBroker({ env: {} }).exec(
      request(script('process.stderr.write("bad"); process.exit(3)')),
    );
    if (outcome.kind !== 'completed') throw new Error('expected completion');
    expect(outcome.stderr).toBe('bad');
    expect(outcome.exitCode).toBe(3);
  });

  it('shares nothing between calls', async () => {
    // The single largest stability win the reference harness reports. A persistent
    // session would carry the variable across; a fresh subprocess cannot.
    const broker = new NodeSubprocessBroker({ env: {} });
    await broker.exec(request(script('process.env.ADZE_MARK = "set"')));
    const outcome = await broker.exec(
      request(script('process.stdout.write(String(process.env.ADZE_MARK))')),
    );
    if (outcome.kind !== 'completed') throw new Error('expected completion');
    expect(outcome.stdout).toBe('undefined');
  });

  it('reports a spawn failure rather than throwing', async () => {
    const outcome = await new NodeSubprocessBroker({ env: {} }).exec(
      request(['definitely-not-a-real-program-xyzzy']),
    );
    expect(outcome.kind).toBe('spawn-failed');
    if (outcome.kind !== 'spawn-failed') return;
    expect(outcome.message).toContain('definitely-not-a-real-program-xyzzy');
  });

  it('rejects an empty command', async () => {
    const outcome = await new NodeSubprocessBroker({ env: {} }).exec(request([]));
    expect(outcome.kind).toBe('spawn-failed');
  });

  it('kills a command that exceeds its timeout', async () => {
    const outcome = await new NodeSubprocessBroker({ env: {} }).exec(
      request(script('setTimeout(() => {}, 60000)'), { timeoutMs: 150 }),
    );
    if (outcome.kind !== 'completed') throw new Error('expected completion');
    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode).toBeNull();
  });

  it('kills a command when the turn is cancelled', async () => {
    const controller = new AbortController();
    const running = new NodeSubprocessBroker({ env: {} }).exec(
      request(script('setTimeout(() => {}, 60000)'), { signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 100);
    const outcome = await running;
    if (outcome.kind !== 'completed') throw new Error('expected completion');
    expect(outcome.cancelled).toBe(true);
  });

  it('closes stdin so a reading command cannot hang forever', async () => {
    const outcome = await new NodeSubprocessBroker({ env: {} }).exec(
      request(
        script(
          'process.stdin.on("end", () => process.stdout.write("eof")); process.stdin.resume()',
        ),
      ),
    );
    if (outcome.kind !== 'completed') throw new Error('expected completion');
    expect(outcome.stdout).toBe('eof');
  });

  it('pipes stdin when given', async () => {
    const outcome = await new NodeSubprocessBroker({ env: {} }).exec({
      ...request(
        script(
          'let d=""; process.stdin.on("data", c => d += c); process.stdin.on("end", () => process.stdout.write(d.toUpperCase()))',
        ),
      ),
      stdin: 'hey',
    });
    if (outcome.kind !== 'completed') throw new Error('expected completion');
    expect(outcome.stdout).toBe('HEY');
  });

  it('does not interpret the command as a shell string', async () => {
    // `shell: false` is the point, not a default being accepted: the argv the gate
    // authorized is the argv that runs, with no intervening interpretation.
    const outcome = await new NodeSubprocessBroker({ env: {} }).exec(
      request([NODE, '-e', 'process.stdout.write(process.argv.slice(1).join("|"))', 'a b', 'c']),
    );
    if (outcome.kind !== 'completed') throw new Error('expected completion');
    expect(outcome.stdout).toBe('a b|c');
  });
});

describe('NodeSubprocessBroker — honest enforcement reporting', () => {
  it('never claims OS-level containment', () => {
    const broker = new NodeSubprocessBroker({ env: {} });
    expect(broker.enforcement('read-only')).toBe('gate-only');
    expect(broker.enforcement('workspace-write')).toBe('gate-only');
  });

  it('reports not-applicable for full-access', () => {
    // The user asked for no containment and got exactly that, which is a different
    // statement from "containment was requested and is missing".
    expect(new NodeSubprocessBroker({ env: {} }).enforcement('full-access')).toBe('not-applicable');
  });

  it('stamps the enforcement level on every result', async () => {
    const outcome = await new NodeSubprocessBroker({ env: {} }).exec(request(script('')));
    if (outcome.kind !== 'completed') throw new Error('expected completion');
    expect(outcome.enforcement).toBe('gate-only');
  });
});

describe('scrubEnvironment', () => {
  it('removes credential-shaped names', () => {
    const scrubbed = scrubEnvironment({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-secret',
      GITHUB_TOKEN: 'ghp_x',
      AWS_SECRET_ACCESS_KEY: 'x',
      DB_PASSWORD: 'x',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/x.json',
      AUTH_HEADER: 'Bearer x',
    });
    expect(scrubbed).toEqual({ PATH: '/usr/bin' });
  });

  it('keeps ordinary names that merely contain a substring', () => {
    // `MONKEY` contains `KEY` but is not a credential. Substring matching would strip
    // half a developer's environment and make commands fail for no visible reason.
    const scrubbed = scrubEnvironment({ MONKEY: 'yes', KEYBOARD: 'us', TOKENIZER: 'bpe' });
    expect(scrubbed).toEqual({ MONKEY: 'yes', KEYBOARD: 'us', TOKENIZER: 'bpe' });
  });

  it('honours an explicit allow list', () => {
    const scrubbed = scrubEnvironment({ NPM_TOKEN: 'x' }, { allow: ['NPM_TOKEN'] });
    expect(scrubbed).toEqual({ NPM_TOKEN: 'x' });
  });

  it('honours an explicit deny list', () => {
    const scrubbed = scrubEnvironment({ HARMLESS: 'x' }, { deny: ['HARMLESS'] });
    expect(scrubbed).toEqual({});
  });

  it('drops undefined values', () => {
    expect(scrubEnvironment({ A: undefined, B: 'b' })).toEqual({ B: 'b' });
  });
});

describe('NullBroker', () => {
  it('runs nothing and says why', async () => {
    const outcome = await new NullBroker().exec();
    expect(outcome.kind).toBe('spawn-failed');
    if (outcome.kind !== 'spawn-failed') return;
    expect(outcome.message).toContain('no sandbox broker');
  });

  it('claims no containment for a mode that asked for none', () => {
    expect(new NullBroker().enforcement('full-access')).toBe('not-applicable');
  });

  it('reports gate-only for a containment mode', () => {
    // Nothing can run through it, so there is no subprocess to contain — but the mode is
    // still enforced by the gate and by nothing else, and `not-applicable` here would
    // suppress the no-os-sandbox warning for a configuration that has no containment.
    expect(new NullBroker().enforcement('workspace-write')).toBe('gate-only');
    expect(new NullBroker().enforcement('read-only')).toBe('gate-only');
  });
});
