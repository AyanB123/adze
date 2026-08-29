import type { ApprovalResponse, SandboxConfig } from '@adze/protocol';
import { describe, expect, it } from 'vitest';
import { NodeSubprocessBroker, NullBroker, type SandboxBroker } from '../src/broker.js';
import { isWithin, MemoryFileSystem } from '../src/fs.js';
import { sequentialIdFactory } from '../src/ids.js';
import { matchCommandRule, PermissionError, PermissionGate } from '../src/permissions.js';
import type { Effect } from '../src/types.js';

const ROOT = '/work/repo';

function sandbox(over: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    mode: 'workspace-write',
    writableRoots: [],
    allowedNetworkHosts: [],
    commandRules: [],
    ...over,
  };
}

/** A broker that claims OS-level containment, to exercise the contained branch. */
class ContainedBroker implements SandboxBroker {
  readonly name = 'contained';
  enforcement(): 'os-level' {
    return 'os-level';
  }
  async exec(): ReturnType<SandboxBroker['exec']> {
    return await Promise.resolve({
      kind: 'completed',
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      cancelled: false,
      outputCapped: false,
      durationMs: 1,
      enforcement: 'os-level',
    });
  }
}

interface GateOver {
  readonly sandbox?: SandboxConfig;
  readonly approvals?: 'untrusted' | 'on-request' | 'never';
  readonly broker?: SandboxBroker;
  readonly platform?: string;
  readonly respond?: (requestId: string) => ApprovalResponse;
  readonly fs?: MemoryFileSystem;
}

function gateFor(over: GateOver = {}): { gate: PermissionGate; prompts: string[] } {
  const prompts: string[] = [];
  const fs = over.fs ?? new MemoryFileSystem();
  fs.seedDirectory(ROOT);
  const gate = new PermissionGate({
    workspaceRoot: ROOT,
    sandbox: over.sandbox ?? sandbox(),
    approvals: over.approvals ?? 'on-request',
    broker: over.broker ?? new NullBroker(),
    fs,
    nextRequestId: sequentialIdFactory().bind(null, 'appr'),
    ...(over.platform === undefined ? {} : { platform: over.platform }),
    ...(over.respond === undefined
      ? {}
      : {
          requestApproval: async (request) => {
            prompts.push(request.summary);
            return await Promise.resolve(
              over.respond?.(request.requestId) ?? {
                requestId: request.requestId,
                decision: 'deny',
              },
            );
          },
        }),
  });
  return { gate, prompts };
}

function req(effects: readonly Effect[]) {
  return { callId: 'c1', toolName: 'test', effects, summary: 'test call' };
}

const allowOnce = (requestId: string): ApprovalResponse => ({ requestId, decision: 'allow-once' });
const allowSession = (requestId: string): ApprovalResponse => ({
  requestId,
  decision: 'allow-session',
});

describe('PermissionGate — `never` refuses rather than escalating', () => {
  it('refuses a write that read-only mode would block', async () => {
    const { gate } = gateFor({ sandbox: sandbox({ mode: 'read-only' }), approvals: 'never' });
    const decision = await gate.authorize(req([{ kind: 'file-write', path: `${ROOT}/a.ts` }]));
    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') return;
    expect(decision.reason).toContain("'never'");
    expect(decision.reason).toContain('refuses rather than escalating');
    expect(decision.abort).toBe(false);
  });

  it('never prompts, even when an approval channel exists', async () => {
    const { gate, prompts } = gateFor({
      sandbox: sandbox({ mode: 'read-only' }),
      approvals: 'never',
      respond: allowOnce,
    });
    const decision = await gate.authorize(req([{ kind: 'file-write', path: `${ROOT}/a.ts` }]));
    expect(decision.outcome).toBe('deny');
    // The whole point: a policy that quietly asked anyway would be granting more
    // than it advertises, which is the failure this test exists to catch.
    expect(prompts).toEqual([]);
  });

  it('still allows what the sandbox permits outright', async () => {
    const { gate } = gateFor({ approvals: 'never' });
    const decision = await gate.authorize(req([{ kind: 'file-write', path: `${ROOT}/a.ts` }]));
    expect(decision.outcome).toBe('allow');
  });
});

describe('PermissionGate — no approval channel means refusal', () => {
  it('refuses rather than allowing when nothing can ask the user', async () => {
    const { gate } = gateFor({ sandbox: sandbox({ mode: 'read-only' }), approvals: 'on-request' });
    const decision = await gate.authorize(req([{ kind: 'file-write', path: `${ROOT}/a.ts` }]));
    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') return;
    expect(decision.reason).toContain('no approval channel');
  });
});

describe('PermissionGate — sandbox modes', () => {
  it('read-only blocks writes anywhere', async () => {
    const { gate } = gateFor({
      sandbox: sandbox({ mode: 'read-only' }),
      approvals: 'on-request',
      respond: allowOnce,
    });
    const decision = await gate.authorize(req([{ kind: 'file-write', path: `${ROOT}/a.ts` }]));
    // Allowed only because the user said so; the mode itself blocked it.
    expect(decision.outcome).toBe('allow');
  });

  it('read-only permits a read inside the workspace with no prompt', async () => {
    const { gate, prompts } = gateFor({
      sandbox: sandbox({ mode: 'read-only' }),
      respond: allowOnce,
    });
    const decision = await gate.authorize(req([{ kind: 'file-read', path: `${ROOT}/a.ts` }]));
    expect(decision.outcome).toBe('allow');
    expect(prompts).toEqual([]);
  });

  it('workspace-write allows a write inside the workspace', async () => {
    const { gate, prompts } = gateFor({ respond: allowOnce });
    const decision = await gate.authorize(req([{ kind: 'file-write', path: `${ROOT}/src/a.ts` }]));
    expect(decision.outcome).toBe('allow');
    expect(prompts).toEqual([]);
  });

  it('workspace-write blocks a write outside the writable roots', async () => {
    const { gate } = gateFor({ approvals: 'never' });
    const decision = await gate.authorize(req([{ kind: 'file-write', path: '/etc/passwd' }]));
    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') return;
    expect(decision.reason).toContain('needs approval');
  });

  it('honours an explicit writableRoots entry outside the workspace', async () => {
    const fs = new MemoryFileSystem();
    fs.seedDirectory('/tmp/scratch');
    const { gate } = gateFor({
      sandbox: sandbox({ writableRoots: [ROOT, '/tmp/scratch'] }),
      approvals: 'never',
      fs,
    });
    const decision = await gate.authorize(req([{ kind: 'file-write', path: '/tmp/scratch/x' }]));
    expect(decision.outcome).toBe('allow');
  });

  it('rejects a sibling directory that merely shares a prefix', async () => {
    // '/work/repo' is a string prefix of '/work/repo-secrets'. A prefix check would
    // authorize the second while claiming to permit only the first.
    const { gate } = gateFor({ approvals: 'never' });
    const decision = await gate.authorize(
      req([{ kind: 'file-write', path: '/work/repo-secrets/k' }]),
    );
    expect(decision.outcome).toBe('deny');
  });

  it('rejects a traversal out of the workspace', async () => {
    const { gate } = gateFor({ approvals: 'never' });
    const decision = await gate.authorize(
      req([{ kind: 'file-write', path: `${ROOT}/../../etc/hosts` }]),
    );
    expect(decision.outcome).toBe('deny');
  });

  it('full-access allows everything without prompting', async () => {
    const { gate, prompts } = gateFor({
      sandbox: sandbox({ mode: 'full-access' }),
      respond: allowOnce,
    });
    const decision = await gate.authorize(
      req([
        { kind: 'file-write', path: '/etc/passwd' },
        { kind: 'network', host: 'example.com' },
        { kind: 'command', command: ['bash', '-lc', 'ls'], cwd: ROOT },
      ]),
    );
    expect(decision.outcome).toBe('allow');
    expect(prompts).toEqual([]);
  });

  it('denies network unless the host is allowlisted', async () => {
    const { gate } = gateFor({ approvals: 'never' });
    expect((await gate.authorize(req([{ kind: 'network', host: 'evil.test' }]))).outcome).toBe(
      'deny',
    );
    const { gate: allowed } = gateFor({
      sandbox: sandbox({ allowedNetworkHosts: ['registry.npmjs.org'] }),
      approvals: 'never',
    });
    expect(
      (await allowed.authorize(req([{ kind: 'network', host: 'registry.npmjs.org' }]))).outcome,
    ).toBe('allow');
  });
});

describe('PermissionGate — command rules', () => {
  it('forbid beats an otherwise-permissive full-access mode', async () => {
    const { gate, prompts } = gateFor({
      sandbox: sandbox({
        mode: 'full-access',
        commandRules: [{ prefix: 'rm -rf', action: 'forbid' }],
      }),
      approvals: 'untrusted',
      respond: allowOnce,
    });
    const decision = await gate.authorize(
      req([{ kind: 'command', command: ['rm -rf /'], cwd: ROOT }]),
    );
    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') return;
    expect(decision.reason).toContain('forbids the prefix');
    // A forbid rule is absolute: offering it for approval would make it advisory.
    expect(prompts).toEqual([]);
  });

  it('allow lets a specific command run without widening the mode', async () => {
    const { gate, prompts } = gateFor({
      sandbox: sandbox({ commandRules: [{ prefix: 'npm test', action: 'allow' }] }),
      approvals: 'never',
    });
    const allowedCall = await gate.authorize(
      req([
        { kind: 'command', command: ['npm test'], cwd: ROOT },
        { kind: 'file-read', path: ROOT },
      ]),
    );
    expect(allowedCall.outcome).toBe('allow');
    expect(prompts).toEqual([]);

    // The mode is unchanged: a different command still needs approval, and `never`
    // refuses it.
    const otherCall = await gate.authorize(
      req([{ kind: 'command', command: ['npm publish'], cwd: ROOT }]),
    );
    expect(otherCall.outcome).toBe('deny');
  });

  it('prompt overrides a mode that would otherwise allow', async () => {
    const { gate, prompts } = gateFor({
      sandbox: sandbox({
        mode: 'full-access',
        commandRules: [{ prefix: 'git push', action: 'prompt' }],
      }),
      respond: allowOnce,
    });
    const decision = await gate.authorize(
      req([{ kind: 'command', command: ['git push origin main'], cwd: ROOT }]),
    );
    expect(decision.outcome).toBe('allow');
    expect(prompts).toHaveLength(1);
  });

  it('matches the longest prefix, not the first declared', () => {
    const rules = [
      { prefix: 'git', action: 'allow' as const },
      { prefix: 'git push', action: 'forbid' as const },
    ];
    expect(matchCommandRule(rules, 'git push origin main')?.action).toBe('forbid');
    expect(matchCommandRule(rules, 'git status')?.action).toBe('allow');
    expect(matchCommandRule(rules, 'ls')).toBeUndefined();
  });
});

describe('PermissionGate — containment decides whether a command is prompted', () => {
  it('prompts for a command when nothing contains it', async () => {
    const { gate, prompts } = gateFor({
      broker: new NodeSubprocessBroker({ env: {} }),
      platform: 'win32',
      respond: allowOnce,
    });
    const decision = await gate.authorize(
      req([{ kind: 'command', command: ['bash', '-lc', 'ls'], cwd: ROOT }]),
    );
    expect(decision.outcome).toBe('allow');
    expect(prompts).toHaveLength(1);
  });

  it('runs a command without prompting when the broker really contains it', async () => {
    const { gate, prompts } = gateFor({
      broker: new ContainedBroker(),
      platform: 'linux',
      respond: allowOnce,
    });
    const decision = await gate.authorize(
      req([{ kind: 'command', command: ['bash', '-lc', 'ls'], cwd: ROOT }]),
    );
    expect(decision.outcome).toBe('allow');
    expect(prompts).toEqual([]);
  });

  it('reports the broker rather than the platform when they disagree', () => {
    // Linux can contain a process; this broker does not. Reporting the platform's
    // capability would claim containment nobody implemented.
    const { gate } = gateFor({ broker: new NodeSubprocessBroker({ env: {} }), platform: 'linux' });
    expect(gate.enforcement()).toBe('gate-only');
  });

  it('emits a no-os-sandbox warning when containment is absent', () => {
    const { gate } = gateFor({ platform: 'win32' });
    const codes = gate.warnings().map((w) => w.code);
    expect(codes).toContain('no-os-sandbox');
  });

  it('emits network-unrestricted for full-access', () => {
    const { gate } = gateFor({ sandbox: sandbox({ mode: 'full-access' }) });
    expect(gate.warnings().map((w) => w.code)).toContain('network-unrestricted');
  });
});

describe('PermissionGate — approval decisions', () => {
  it('allow-session stops asking about the same effect', async () => {
    const { gate, prompts } = gateFor({
      sandbox: sandbox({ mode: 'read-only' }),
      respond: allowSession,
    });
    const effect: Effect = { kind: 'file-write', path: `${ROOT}/a.ts` };
    expect((await gate.authorize(req([effect]))).outcome).toBe('allow');
    expect((await gate.authorize(req([effect]))).outcome).toBe('allow');
    expect(prompts).toHaveLength(1);
  });

  it('allow-once asks again next time', async () => {
    const { gate, prompts } = gateFor({
      sandbox: sandbox({ mode: 'read-only' }),
      respond: allowOnce,
    });
    const effect: Effect = { kind: 'file-write', path: `${ROOT}/a.ts` };
    await gate.authorize(req([effect]));
    await gate.authorize(req([effect]));
    expect(prompts).toHaveLength(2);
  });

  it('abort denies and marks the turn for termination', async () => {
    const { gate } = gateFor({
      sandbox: sandbox({ mode: 'read-only' }),
      respond: (requestId) => ({ requestId, decision: 'abort' }),
    });
    const decision = await gate.authorize(req([{ kind: 'file-write', path: `${ROOT}/a.ts` }]));
    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') return;
    expect(decision.abort).toBe(true);
  });

  it('untrusted asks even about effects the sandbox would allow', async () => {
    const { gate, prompts } = gateFor({ approvals: 'untrusted', respond: allowOnce });
    const decision = await gate.authorize(req([{ kind: 'file-read', path: `${ROOT}/a.ts` }]));
    expect(decision.outcome).toBe('allow');
    expect(prompts).toHaveLength(1);
  });

  it('does not prompt for a call with no effects, even under untrusted', async () => {
    // A deliberate narrowing of "approve every action" to "every action that does
    // something": `todo` and `task` declare nothing, and prompting for them asks the
    // user to decide something with no security content. The call still goes through
    // the gate — it just has nothing to weigh.
    const { gate, prompts } = gateFor({ approvals: 'untrusted', respond: allowOnce });
    const decision = await gate.authorize(req([]));
    expect(decision.outcome).toBe('allow');
    expect(prompts).toEqual([]);
  });
});

describe('Grant — a tool cannot exceed what it declared', () => {
  it('refuses a write the tool did not declare', async () => {
    const { gate } = gateFor();
    const decision = await gate.authorize(req([{ kind: 'file-read', path: `${ROOT}/a.ts` }]));
    expect(decision.outcome).toBe('allow');
    if (decision.outcome !== 'allow') return;
    await expect(decision.grant.writeFile(`${ROOT}/b.ts`, 'x')).rejects.toThrow(PermissionError);
  });

  it('refuses a command the tool did not declare', async () => {
    const { gate } = gateFor({ sandbox: sandbox({ mode: 'full-access' }) });
    const decision = await gate.authorize(req([{ kind: 'command', command: ['ls'], cwd: ROOT }]));
    expect(decision.outcome).toBe('allow');
    if (decision.outcome !== 'allow') return;
    await expect(
      decision.grant.exec(['curl', 'http://evil.test'], {
        cwd: ROOT,
        timeoutMs: 100,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(PermissionError);
  });

  it('allows exactly the declared effects', async () => {
    const fs = new MemoryFileSystem({ [`${ROOT}/a.ts`]: 'contents' });
    const { gate } = gateFor({ fs });
    const decision = await gate.authorize(req([{ kind: 'file-read', path: `${ROOT}/a.ts` }]));
    if (decision.outcome !== 'allow') throw new Error('expected allow');
    await expect(decision.grant.readFile(`${ROOT}/a.ts`)).resolves.toBe('contents');
  });

  it('reports the enforcement level it was minted under', async () => {
    const { gate } = gateFor({ platform: 'win32' });
    const decision = await gate.authorize(req([{ kind: 'file-read', path: ROOT }]));
    if (decision.outcome !== 'allow') throw new Error('expected allow');
    expect(decision.grant.enforcement).toBe('gate-only');
  });
});

describe('isWithin', () => {
  it('accepts the root itself and descendants', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/b/c/d')).toBe(true);
  });

  it('rejects ancestors, siblings, and prefix collisions', () => {
    expect(isWithin('/a/b', '/a')).toBe(false);
    expect(isWithin('/a/b', '/a/c')).toBe(false);
    expect(isWithin('/a/b', '/a/bb')).toBe(false);
  });

  it('resolves traversal before comparing', () => {
    expect(isWithin('/a/b', '/a/b/../c')).toBe(false);
    expect(isWithin('/a/b', '/a/b/c/../d')).toBe(true);
  });
});
