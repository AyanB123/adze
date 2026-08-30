import { describe, expect, it } from 'vitest';
import type { MechanismCapability, SandboxDecision } from '../src/policy.js';
import { decide, matchCommandRule, planFor, readAllowed, writeAllowed } from '../src/policy.js';
import type {
  ApprovalPolicy,
  CommandRule,
  Containment,
  Degradation,
  SandboxMode,
} from '../src/types.js';

const MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'full-access'];
const POLICIES: readonly ApprovalPolicy[] = ['untrusted', 'on-request', 'never'];

/** A mechanism that genuinely contains, like Seatbelt or bubblewrap. */
const CONTAINING: MechanismCapability = {
  mechanism: 'seatbelt',
  confinesFilesystem: true,
  confinesNetwork: true,
  supportsNetworkAllowlist: false,
  confinesSubprocessTree: true,
  degradations: [],
};

/** A mechanism that contains nothing, like Windows today. */
const BARE: MechanismCapability = {
  mechanism: 'none',
  confinesFilesystem: false,
  confinesNetwork: false,
  supportsNetworkAllowlist: false,
  confinesSubprocessTree: false,
  degradations: [],
};

const CAPABILITIES: readonly MechanismCapability[] = [CONTAINING, BARE];

function containment(mode: SandboxMode, overrides: Partial<Containment> = {}): Containment {
  return {
    mode,
    writableRoots: ['/repo'],
    allowedNetworkHosts: [],
    ...overrides,
  };
}

function ask(
  mode: SandboxMode,
  approvals: ApprovalPolicy,
  capability: MechanismCapability,
  extra: { rules?: readonly CommandRule[]; cwd?: string; hosts?: readonly string[] } = {},
): SandboxDecision {
  return decide({
    containment: containment(
      mode,
      extra.hosts === undefined ? {} : { allowedNetworkHosts: extra.hosts },
    ),
    approvals,
    commandRules: extra.rules ?? [],
    command: ['npm', 'test'],
    cwd: extra.cwd ?? '/repo',
    capability,
    platform: 'linux',
  });
}

describe('matchCommandRule', () => {
  it('lets the longest prefix win regardless of declaration order', () => {
    const rules: CommandRule[] = [
      { prefix: 'git', action: 'allow' },
      { prefix: 'git push', action: 'forbid' },
    ];
    expect(matchCommandRule(rules, 'git push origin main')?.action).toBe('forbid');
    expect(matchCommandRule(rules, 'git status')?.action).toBe('allow');
  });

  it('returns undefined when nothing matches', () => {
    expect(matchCommandRule([{ prefix: 'npm', action: 'allow' }], 'cargo build')).toBeUndefined();
  });
});

describe('planFor is independent of the approval policy', () => {
  // The structural guarantee that `never` cannot escalate: the boundary is not a
  // function of the policy, so no policy value can widen it.
  it('produces the same plan for every mode and mechanism', () => {
    for (const mode of MODES) {
      for (const capability of CAPABILITIES) {
        const plans = POLICIES.map((approvals) => {
          const decision = ask(mode, approvals, capability);
          return decision.kind === 'refuse' ? undefined : decision.plan;
        }).filter((plan) => plan !== undefined);
        for (const plan of plans) expect(plan).toEqual(plans[0]);
      }
    }
  });
});

describe('planFor', () => {
  it('grants no writable roots under read-only', () => {
    const plan = planFor(containment('read-only'), CONTAINING, 'linux');
    expect(plan.writableRoots).toEqual([]);
    expect(plan.mode).toBe('read-only');
  });

  it('grants the declared roots under workspace-write', () => {
    const plan = planFor(containment('workspace-write'), CONTAINING, 'linux');
    expect(plan.writableRoots).toEqual(['/repo']);
  });

  it('reports os-level only when the filesystem and the whole tree are contained', () => {
    expect(planFor(containment('workspace-write'), CONTAINING, 'linux').enforcement).toBe(
      'os-level',
    );
    expect(planFor(containment('workspace-write'), BARE, 'linux').enforcement).toBe('gate-only');
  });

  it('reports not-applicable under full-access, where containment was not requested', () => {
    expect(planFor(containment('full-access'), CONTAINING, 'linux').enforcement).toBe(
      'not-applicable',
    );
    expect(planFor(containment('full-access'), BARE, 'linux').enforcement).toBe('not-applicable');
  });

  // A mechanism containing only its direct child contains nothing useful: bash runs
  // npm install runs a postinstall script runs curl.
  it('refuses to claim os-level when the subprocess tree escapes', () => {
    const leaky: MechanismCapability = { ...CONTAINING, confinesSubprocessTree: false };
    expect(planFor(containment('workspace-write'), leaky, 'linux').enforcement).toBe('gate-only');
  });

  // The honesty clamp. A plan cannot admit a containment gap and claim os-level.
  it('cannot claim os-level while carrying a containment-scope degradation', () => {
    const gap: Degradation = {
      code: 'network-unrestricted',
      scope: 'containment',
      message: 'test',
    };
    const admitting: MechanismCapability = { ...CONTAINING, degradations: [gap] };
    expect(planFor(containment('workspace-write'), admitting, 'linux').enforcement).toBe(
      'gate-only',
    );
  });

  it('keeps os-level when the degradation is only hardening', () => {
    const hardening: Degradation = {
      code: 'syscall-surface-unrestricted',
      scope: 'hardening',
      message: 'test',
    };
    const capability: MechanismCapability = { ...CONTAINING, degradations: [hardening] };
    expect(planFor(containment('workspace-write'), capability, 'linux').enforcement).toBe(
      'os-level',
    );
  });

  it('records a containment gap when the mechanism confines nothing', () => {
    const plan = planFor(containment('workspace-write'), BARE, 'linux');
    expect(plan.degradations.map((d) => d.code)).toContain('no-os-containment');
    expect(plan.degradations.some((d) => d.scope === 'containment')).toBe(true);
  });

  it('reports a rejected relative root as a functionality problem, not a security one', () => {
    const plan = planFor(
      containment('workspace-write', { writableRoots: ['./build'] }),
      CONTAINING,
      'linux',
    );
    expect(plan.writableRoots).toEqual([]);
    expect(plan.degradations.some((d) => d.scope === 'functionality')).toBe(true);
    expect(plan.enforcement).toBe('os-level');
  });

  it('uses win32 path rules when the platform is win32', () => {
    const plan = planFor(
      containment('workspace-write', { writableRoots: ['C:\\Work\\Repo'] }),
      CONTAINING,
      'win32',
    );
    expect(plan.writableRoots).toEqual(['c:\\work\\repo']);
  });
});

describe('network policy', () => {
  it('denies network by default under both containment modes', () => {
    for (const mode of ['read-only', 'workspace-write'] as const) {
      expect(planFor(containment(mode), CONTAINING, 'linux').network).toEqual({
        policy: 'deny',
        hosts: [],
        enforced: true,
      });
    }
  });

  it('leaves network unrestricted under full-access', () => {
    expect(planFor(containment('full-access'), CONTAINING, 'linux').network.policy).toBe(
      'unrestricted',
    );
  });

  it('honours an allowlist when the mechanism can express one', () => {
    const filtering: MechanismCapability = { ...CONTAINING, supportsNetworkAllowlist: true };
    const plan = planFor(
      containment('workspace-write', { allowedNetworkHosts: ['registry.npmjs.org'] }),
      filtering,
      'linux',
    );
    expect(plan.network).toEqual({
      policy: 'allowlist',
      hosts: ['registry.npmjs.org'],
      enforced: true,
    });
  });

  // Fails closed: denying more than requested breaks a fetch, which is a bug report.
  // Allowing more than requested is a hole nobody notices.
  it('falls back to denying everything when an allowlist cannot be expressed', () => {
    const plan = planFor(
      containment('workspace-write', { allowedNetworkHosts: ['registry.npmjs.org'] }),
      CONTAINING,
      'linux',
    );
    expect(plan.network.policy).toBe('deny');
    expect(plan.network.enforced).toBe(true);
    expect(plan.degradations.map((d) => d.code)).toContain('network-allowlist-unsupported');
    expect(plan.degradations.find((d) => d.code === 'network-allowlist-unsupported')?.scope).toBe(
      'functionality',
    );
    expect(plan.enforcement).toBe('os-level');
  });

  it('admits a containment gap when network cannot be restricted at all', () => {
    const plan = planFor(containment('workspace-write'), BARE, 'linux');
    expect(plan.network).toEqual({ policy: 'unrestricted', hosts: [], enforced: false });
    expect(plan.degradations.map((d) => d.code)).toContain('network-unrestricted');
  });
});

describe("approval policy 'never' refuses rather than escalating", () => {
  it('never returns requires-approval, across the whole matrix', () => {
    for (const mode of MODES) {
      for (const capability of CAPABILITIES) {
        for (const rules of [
          [],
          [{ prefix: 'npm', action: 'allow' }],
          [{ prefix: 'npm', action: 'prompt' }],
        ] as readonly CommandRule[][]) {
          const decision = ask(mode, 'never', capability, { rules });
          expect(decision.kind).not.toBe('requires-approval');
        }
      }
    }
  });

  it('refuses a command that would otherwise be prompted', () => {
    const decision = ask('workspace-write', 'never', BARE);
    expect(decision.kind).toBe('refuse');
    if (decision.kind !== 'refuse') return;
    expect(decision.code).toBe('approval-refused');
    expect(decision.reason).toContain("'never'");
  });

  it('permits without a prompt when a real sandbox would confine the command', () => {
    expect(ask('workspace-write', 'never', CONTAINING).kind).toBe('permit');
  });

  it('permits an explicitly allowed prefix', () => {
    const rules: CommandRule[] = [{ prefix: 'npm test', action: 'allow' }];
    expect(ask('workspace-write', 'never', BARE, { rules }).kind).toBe('permit');
  });

  it('refuses a prompt rule even when the mode would otherwise allow it', () => {
    const rules: CommandRule[] = [{ prefix: 'npm', action: 'prompt' }];
    const decision = ask('full-access', 'never', CONTAINING, { rules });
    expect(decision.kind).toBe('refuse');
  });

  it('permits under full-access with no matching rule', () => {
    expect(ask('full-access', 'never', BARE).kind).toBe('permit');
  });
});

describe("approval policy 'on-request'", () => {
  it('does not prompt when the sandbox would confine the command', () => {
    expect(ask('workspace-write', 'on-request', CONTAINING).kind).toBe('permit');
  });

  it('prompts when nothing would confine the command', () => {
    const decision = ask('workspace-write', 'on-request', BARE);
    expect(decision.kind).toBe('requires-approval');
    if (decision.kind !== 'requires-approval') return;
    expect(decision.reason).toContain('no OS-level containment');
  });

  it('does not prompt under full-access', () => {
    expect(ask('full-access', 'on-request', BARE).kind).toBe('permit');
  });
});

describe("approval policy 'untrusted'", () => {
  it('prompts even when the sandbox would confine the command', () => {
    expect(ask('workspace-write', 'untrusted', CONTAINING).kind).toBe('requires-approval');
  });

  it('prompts even under full-access', () => {
    expect(ask('full-access', 'untrusted', CONTAINING).kind).toBe('requires-approval');
  });

  it('prompts even for an explicitly allowed prefix', () => {
    const rules: CommandRule[] = [{ prefix: 'npm test', action: 'allow' }];
    expect(ask('workspace-write', 'untrusted', CONTAINING, { rules }).kind).toBe(
      'requires-approval',
    );
  });
});

describe('a forbid rule beats every mode and every policy', () => {
  const rules: CommandRule[] = [{ prefix: 'npm', action: 'forbid' }];

  it('refuses across the whole matrix', () => {
    for (const mode of MODES) {
      for (const approvals of POLICIES) {
        for (const capability of CAPABILITIES) {
          const decision = ask(mode, approvals, capability, { rules });
          expect(decision.kind).toBe('refuse');
          if (decision.kind !== 'refuse') continue;
          expect(decision.code).toBe('command-forbidden');
        }
      }
    }
  });

  it('is not offered for approval', () => {
    const decision = ask('workspace-write', 'untrusted', CONTAINING, { rules });
    expect(decision.kind).toBe('refuse');
  });

  it('does not match a command that merely contains the prefix later', () => {
    expect(
      ask('full-access', 'never', CONTAINING, { rules: [{ prefix: 'rm', action: 'forbid' }] }).kind,
    ).toBe('permit');
  });
});

describe('decide', () => {
  it('refuses an empty command', () => {
    const decision = decide({
      containment: containment('workspace-write'),
      approvals: 'on-request',
      commandRules: [],
      command: [],
      cwd: '/repo',
      capability: CONTAINING,
      platform: 'linux',
    });
    expect(decision.kind).toBe('refuse');
    if (decision.kind !== 'refuse') return;
    expect(decision.code).toBe('empty-command');
  });

  it('refuses a working directory the mechanism cannot see', () => {
    const bound: MechanismCapability = { ...CONTAINING, readsOnlyBoundPaths: true };
    const decision = ask('workspace-write', 'on-request', bound, { cwd: '/elsewhere' });
    expect(decision.kind).toBe('refuse');
    if (decision.kind !== 'refuse') return;
    expect(decision.code).toBe('cwd-outside-roots');
  });

  it('permits a working directory inside a bound root', () => {
    const bound: MechanismCapability = { ...CONTAINING, readsOnlyBoundPaths: true };
    expect(ask('workspace-write', 'on-request', bound, { cwd: '/repo/packages' }).kind).toBe(
      'permit',
    );
  });

  it('does not apply the reachability check when reads are unrestricted', () => {
    expect(ask('workspace-write', 'on-request', CONTAINING, { cwd: '/elsewhere' }).kind).toBe(
      'permit',
    );
  });
});

describe('writeAllowed', () => {
  const readOnly = planFor(containment('read-only'), CONTAINING, 'linux');
  const workspace = planFor(containment('workspace-write'), CONTAINING, 'linux');
  const full = planFor(containment('full-access'), CONTAINING, 'linux');

  it('blocks every write under read-only', () => {
    expect(writeAllowed(readOnly, '/repo/src/a.ts', 'linux')).toBe(false);
    expect(writeAllowed(readOnly, '/repo', 'linux')).toBe(false);
    expect(writeAllowed(readOnly, '/tmp/x', 'linux')).toBe(false);
  });

  it('allows writes inside a writable root under workspace-write', () => {
    expect(writeAllowed(workspace, '/repo/src/a.ts', 'linux')).toBe(true);
    expect(writeAllowed(workspace, '/repo', 'linux')).toBe(true);
  });

  it('blocks writes outside every writable root under workspace-write', () => {
    expect(writeAllowed(workspace, '/etc/passwd', 'linux')).toBe(false);
    expect(writeAllowed(workspace, '/repo-backup/a.ts', 'linux')).toBe(false);
    expect(writeAllowed(workspace, '/repo/../etc/hosts', 'linux')).toBe(false);
  });

  it('allows everything under full-access', () => {
    expect(writeAllowed(full, '/etc/passwd', 'linux')).toBe(true);
  });
});

describe('readAllowed', () => {
  it('permits reads anywhere when the mechanism does not bind the filesystem', () => {
    const plan = planFor(containment('read-only'), CONTAINING, 'linux');
    expect(readAllowed(plan, '/etc/hosts', 'linux')).toBe(true);
  });

  it('restricts reads to bound roots under a container', () => {
    const bound: MechanismCapability = { ...CONTAINING, readsOnlyBoundPaths: true };
    const plan = planFor(containment('workspace-write'), bound, 'linux');
    expect(readAllowed(plan, '/repo/src/a.ts', 'linux')).toBe(true);
    expect(readAllowed(plan, '/etc/hosts', 'linux')).toBe(false);
  });
});
