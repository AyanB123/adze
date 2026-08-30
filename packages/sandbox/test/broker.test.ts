import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { programNameRefusal, refusal, splitArgv } from '../src/broker-base.js';
import { FallbackBroker, fallbackCapability, NullBroker } from '../src/fallback.js';
import type { CommandOutcome, CommandRule } from '../src/types.js';
import { containmentFor, requestFor } from './support.js';

const scratch = tmpdir();

function envForNode(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
  };
}

/** A broker that really spawns, so the whole decide-then-run path is exercised. */
function broker(options: {
  approvals?: 'untrusted' | 'on-request' | 'never';
  commandRules?: readonly CommandRule[];
  assumeApproved?: boolean;
  allowEnv?: readonly string[];
  env?: Record<string, string>;
}): FallbackBroker {
  return new FallbackBroker({
    reason: 'no mechanism in this test',
    env: options.env ?? envForNode(),
    ...options,
  });
}

async function runNode(
  instance: FallbackBroker,
  script: string,
  mode: 'read-only' | 'workspace-write' | 'full-access' = 'workspace-write',
): Promise<CommandOutcome> {
  return await instance.exec({
    ...requestFor(
      [process.execPath, '-e', script],
      containmentFor(mode, {
        writableRoots: [scratch],
      }),
      scratch,
    ),
    timeoutMs: 30_000,
  });
}

describe('FallbackBroker', () => {
  it('reports gate-only for both containment modes, on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32', 'aix']) {
      const instance = new FallbackBroker({ platform });
      expect(instance.enforcement('read-only')).toBe('gate-only');
      expect(instance.enforcement('workspace-write')).toBe('gate-only');
    }
  });

  it('reports not-applicable under full-access', () => {
    expect(new FallbackBroker({ platform: 'linux' }).enforcement('full-access')).toBe(
      'not-applicable',
    );
  });

  it('carries the specific reason into the plan', () => {
    const capability = fallbackCapability('workspace-write', 'bwrap is not installed');
    expect(capability.degradations.some((d) => d.message === 'bwrap is not installed')).toBe(true);
  });

  // String arithmetic cannot see through a symlink, and saying so is the difference
  // between a documented limit and a surprise.
  it('admits that path checks do not resolve symlinks', () => {
    const codes = fallbackCapability('workspace-write').degradations.map((d) => d.code);
    expect(codes).toContain('symlink-escape-unchecked');
  });

  it('runs a command when the policy permits it', async () => {
    const outcome = await runNode(broker({}), 'process.stdout.write("ran")');
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.stdout).toBe('ran');
    expect(outcome.enforcement).toBe('gate-only');
  });
});

describe('the broker defends the never policy a second time', () => {
  // Under `never` the gate would already have refused, so reaching the broker means
  // something upstream is wrong. The safe response to a possible gate bug is not to
  // run the command.
  it('refuses even though a gate is assumed to have approved', async () => {
    const outcome = await runNode(broker({ approvals: 'never' }), 'process.stdout.write("ran")');
    expect(outcome.kind).toBe('spawn-failed');
    if (outcome.kind !== 'spawn-failed') return;
    expect(outcome.refusal).toBe('approval-refused');
    expect(outcome.message).toContain("'never'");
  });

  it('still runs an explicitly allowed prefix under never', async () => {
    const rules: CommandRule[] = [{ prefix: process.execPath, action: 'allow' }];
    const outcome = await runNode(
      broker({ approvals: 'never', commandRules: rules }),
      'process.stdout.write("ran")',
    );
    expect(outcome.kind).toBe('completed');
  });

  it('runs under full-access with never, where no approval was needed', async () => {
    const outcome = await runNode(
      broker({ approvals: 'never' }),
      'process.stdout.write("ran")',
      'full-access',
    );
    expect(outcome.kind).toBe('completed');
  });
});

describe('a forbid rule stops the command before it spawns', () => {
  it('refuses regardless of the mode', async () => {
    const rules: CommandRule[] = [{ prefix: process.execPath, action: 'forbid' }];
    for (const mode of ['read-only', 'workspace-write', 'full-access'] as const) {
      const outcome = await runNode(
        broker({ commandRules: rules, approvals: 'on-request' }),
        'process.stdout.write("ran")',
        mode,
      );
      expect(outcome.kind).toBe('spawn-failed');
      if (outcome.kind !== 'spawn-failed') continue;
      expect(outcome.refusal).toBe('command-forbidden');
      // The command genuinely did not run, which is what a refusal has to mean.
      expect(outcome.message).not.toContain('ran');
    }
  });
});

describe('assumeApproved', () => {
  it('defaults to trusting the gate, so an approved command runs', async () => {
    const outcome = await runNode(broker({ approvals: 'on-request' }), 'process.stdout.write("x")');
    expect(outcome.kind).toBe('completed');
  });

  // For a harness or a preview, where nothing asked the user.
  it('refuses what would need approval when no gate is in front', async () => {
    const outcome = await runNode(
      broker({ approvals: 'on-request', assumeApproved: false }),
      'process.stdout.write("x")',
    );
    expect(outcome.kind).toBe('spawn-failed');
    if (outcome.kind !== 'spawn-failed') return;
    expect(outcome.refusal).toBe('approval-unavailable');
  });

  it('still runs an allowed prefix with no gate in front', async () => {
    const rules: CommandRule[] = [{ prefix: process.execPath, action: 'allow' }];
    const outcome = await runNode(
      broker({ approvals: 'on-request', assumeApproved: false, commandRules: rules }),
      'process.stdout.write("x")',
    );
    expect(outcome.kind).toBe('completed');
  });
});

describe('the environment handed to the child', () => {
  it('removes credential-shaped variables', async () => {
    const instance = broker({ env: { ...envForNode(), MY_API_KEY: 'secret-value' } });
    const outcome = await runNode(instance, 'process.stdout.write(String(process.env.MY_API_KEY))');
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.stdout).toBe('undefined');
  });

  it('passes a credential through when it was explicitly allowed', async () => {
    const instance = broker({
      env: { ...envForNode(), MY_API_KEY: 'secret-value' },
      allowEnv: ['MY_API_KEY'],
    });
    const outcome = await runNode(instance, 'process.stdout.write(String(process.env.MY_API_KEY))');
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.stdout).toBe('secret-value');
  });
});

describe('NullBroker', () => {
  // The difference between "the gate denied it" and "it ran and failed" is the whole
  // property under test elsewhere, and a broker that cannot run anything makes the
  // distinction impossible to fake.
  it('runs nothing and says why', async () => {
    const outcome = await new NullBroker({ platform: 'linux' }).exec(
      requestFor(['echo', 'hi'], containmentFor('workspace-write')),
    );
    expect(outcome.kind).toBe('spawn-failed');
    if (outcome.kind !== 'spawn-failed') return;
    expect(outcome.message).toContain('no sandbox broker');
  });

  it('reports gate-only rather than not-applicable for a containment mode', () => {
    const instance = new NullBroker({ platform: 'linux' });
    expect(instance.enforcement('workspace-write')).toBe('gate-only');
    expect(instance.enforcement('full-access')).toBe('not-applicable');
  });
});

describe('broker helpers', () => {
  it('splits an argv and refuses an empty one', () => {
    expect(splitArgv(['a', 'b'])).toEqual({ file: 'a', args: ['b'] });
    expect(splitArgv([])).toBeUndefined();
    expect(splitArgv([''])).toBeUndefined();
  });

  it('flags a program name a wrapper would read as a flag', () => {
    expect(programNameRefusal('--bind', 'bwrap')?.code).toBe('program-name-option-like');
    expect(programNameRefusal('-p', 'sandbox-exec')?.code).toBe('program-name-option-like');
    expect(programNameRefusal('bash', 'bwrap')).toBeUndefined();
    expect(programNameRefusal('./tool', 'bwrap')).toBeUndefined();
  });

  it('shapes a refusal as a spawn failure carrying its code', () => {
    const outcome = refusal('command-forbidden', 'nope', Date.now());
    expect(outcome.kind).toBe('spawn-failed');
    if (outcome.kind !== 'spawn-failed') return;
    expect(outcome.refusal).toBe('command-forbidden');
  });

  it('exposes the plan a surface would explain', () => {
    const instance = new FallbackBroker({ platform: 'linux' });
    const plan = instance.planFor({ containment: containmentFor('workspace-write') });
    expect(plan.enforcement).toBe('gate-only');
    expect(plan.mechanism).toBe('none');
  });
});
