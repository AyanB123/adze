import { describe, expect, it } from 'vitest';
import type { Wrapped } from '../src/broker-base.js';
import { BubblewrapBroker, bubblewrapCapability, buildBubblewrapArgs } from '../src/bubblewrap.js';
import { planFor } from '../src/policy.js';
import type { CommandRequest, ContainmentPlan, SandboxMode } from '../src/types.js';
import { containmentFor, requestFor } from './support.js';

class ExposedBubblewrap extends BubblewrapBroker {
  expose(request: CommandRequest, plan: ContainmentPlan): Wrapped {
    return this.wrap(request, plan);
  }
}

function planWith(mode: SandboxMode, roots: readonly string[] = ['/repo']): ContainmentPlan {
  return planFor(
    containmentFor(mode, { writableRoots: roots }),
    bubblewrapCapability(true, mode),
    'linux',
  );
}

const target = { cwd: '/repo', file: 'bash', args: ['-lc', 'npm test'] };

/** Index of a flag, for the ordering assertions bubblewrap semantics depend on. */
function at(args: readonly string[], flag: string): number {
  return args.indexOf(flag);
}

describe('bubblewrapCapability', () => {
  it('claims filesystem, network and whole-tree containment when usable', () => {
    const capability = bubblewrapCapability(true, 'workspace-write');
    expect(capability.confinesFilesystem).toBe(true);
    expect(capability.confinesNetwork).toBe(true);
    expect(capability.confinesSubprocessTree).toBe(true);
  });

  it('records a containment gap when user namespaces are unavailable', () => {
    const capability = bubblewrapCapability(false, 'workspace-write');
    const gap = capability.degradations.find((d) => d.code === 'userns-unavailable');
    expect(gap?.scope).toBe('containment');
    expect(planFor(containmentFor('workspace-write'), capability, 'linux').enforcement).toBe(
      'gate-only',
    );
  });

  it('records the missing seccomp filter as hardening rather than containment', () => {
    const capability = bubblewrapCapability(true, 'workspace-write');
    const note = capability.degradations.find((d) => d.code === 'syscall-surface-unrestricted');
    expect(note?.scope).toBe('hardening');
    expect(planWith('workspace-write').enforcement).toBe('os-level');
  });

  it('cannot express a per-host allowlist, because a namespace is all-or-nothing', () => {
    expect(bubblewrapCapability(true, 'workspace-write').supportsNetworkAllowlist).toBe(false);
  });
});

describe('buildBubblewrapArgs', () => {
  it('unshares the namespaces that make the boundary inherited', () => {
    const args = buildBubblewrapArgs(planWith('workspace-write'), target);
    for (const flag of [
      '--unshare-user',
      '--unshare-ipc',
      '--unshare-pid',
      '--unshare-uts',
      '--unshare-cgroup',
    ]) {
      expect(args).toContain(flag);
    }
  });

  it('dies with the parent so a killed agent leaves nothing running', () => {
    expect(buildBubblewrapArgs(planWith('read-only'), target)).toContain('--die-with-parent');
  });

  // Blocks TIOCSTI-style injection of keystrokes into the user's shell, which is a
  // real escape from an otherwise sound sandbox.
  it('detaches the controlling terminal', () => {
    expect(buildBubblewrapArgs(planWith('read-only'), target)).toContain('--new-session');
  });

  it('binds the whole filesystem read-only', () => {
    const args = buildBubblewrapArgs(planWith('read-only'), target);
    const index = at(args, '--ro-bind');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(args[index + 1]).toBe('/');
    expect(args[index + 2]).toBe('/');
  });

  // Bubblewrap applies operations in the order given, so a writable bind placed
  // before the read-only root bind would be overwritten by it.
  it('places the writable binds after the read-only root bind', () => {
    const args = buildBubblewrapArgs(planWith('workspace-write'), target);
    expect(at(args, '--ro-bind')).toBeLessThan(at(args, '--bind'));
  });

  it('binds each writable root writable', () => {
    const args = buildBubblewrapArgs(planWith('workspace-write', ['/repo', '/cache']), target);
    const joined = args.join(' ');
    expect(joined).toContain('--bind /repo /repo');
    expect(joined).toContain('--bind /cache /cache');
  });

  it('binds nothing writable under read-only', () => {
    expect(buildBubblewrapArgs(planWith('read-only'), target)).not.toContain('--bind');
  });

  it('removes the network namespace when network is denied', () => {
    expect(buildBubblewrapArgs(planWith('workspace-write'), target)).toContain('--unshare-net');
  });

  it('keeps the network under full-access', () => {
    expect(buildBubblewrapArgs(planWith('full-access'), target)).not.toContain('--unshare-net');
  });

  it('mounts a tmpfs at /tmp under workspace-write by default', () => {
    const args = buildBubblewrapArgs(planWith('workspace-write'), target);
    const index = at(args, '--tmpfs');
    expect(args[index + 1]).toBe('/tmp');
  });

  it('does not mount a writable tmpfs under read-only', () => {
    expect(buildBubblewrapArgs(planWith('read-only'), target)).not.toContain('--tmpfs');
  });

  it('lets a caller turn the tmpfs off', () => {
    const args = buildBubblewrapArgs(planWith('workspace-write'), target, { tmpfs: false });
    expect(args).not.toContain('--tmpfs');
  });

  it('mounts proc and dev, which most toolchains require', () => {
    const args = buildBubblewrapArgs(planWith('read-only'), target);
    expect(args[at(args, '--proc') + 1]).toBe('/proc');
    expect(args[at(args, '--dev') + 1]).toBe('/dev');
  });

  it('passes the working directory and then the command last', () => {
    const args = buildBubblewrapArgs(planWith('workspace-write'), target);
    expect(args[at(args, '--chdir') + 1]).toBe('/repo');
    expect(args.slice(-3)).toEqual(['bash', '-lc', 'npm test']);
  });

  // The payoff of never building a shell string: a directory named `$(rm -rf ~)` is
  // one argv element and needs no escaping at all.
  it('passes a path containing shell metacharacters through as one argument', () => {
    const evil = '/repo/$(rm -rf ~); echo `id` && true';
    const args = buildBubblewrapArgs(planWith('workspace-write', [evil]), target);
    const index = at(args, '--bind');
    expect(args[index + 1]).toBe(evil);
    expect(args[index + 2]).toBe(evil);
  });
});

describe('BubblewrapBroker', () => {
  const broker = new ExposedBubblewrap(true, { platform: 'linux' });

  it('reports os-level for both containment modes when usable', () => {
    expect(broker.enforcement('read-only')).toBe('os-level');
    expect(broker.enforcement('workspace-write')).toBe('os-level');
  });

  it('reports gate-only when bubblewrap is unusable, rather than crashing', () => {
    const absent = new ExposedBubblewrap(false, { platform: 'linux' });
    expect(absent.enforcement('workspace-write')).toBe('gate-only');
    expect(absent.enforcement('read-only')).toBe('gate-only');
  });

  it('wraps the command in bwrap', () => {
    const wrapped = broker.expose(
      requestFor(['bash', '-lc', 'npm test'], containmentFor('workspace-write')),
      planWith('workspace-write'),
    );
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(wrapped.file).toBe('bwrap');
    expect(wrapped.args.slice(-3)).toEqual(['bash', '-lc', 'npm test']);
  });

  it('spawns directly when bubblewrap is unusable', () => {
    const absent = new ExposedBubblewrap(false, { platform: 'linux' });
    const plan = planFor(
      containmentFor('workspace-write'),
      bubblewrapCapability(false, 'workspace-write'),
      'linux',
    );
    const wrapped = absent.expose(
      requestFor(['bash', '-lc', 'ls'], containmentFor('workspace-write')),
      plan,
    );
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(wrapped.file).toBe('bash');
  });

  it('refuses a program name bwrap would read as one of its options', () => {
    const wrapped = broker.expose(
      requestFor(['--bind', '/', '/'], containmentFor('workspace-write')),
      planWith('workspace-write'),
    );
    expect(wrapped.ok).toBe(false);
    if (wrapped.ok) return;
    expect(wrapped.code).toBe('program-name-option-like');
  });

  it('honours an explicit bwrap path', () => {
    const custom = new ExposedBubblewrap(true, { platform: 'linux', bwrapPath: '/usr/bin/bwrap' });
    const wrapped = custom.expose(
      requestFor(['ls'], containmentFor('read-only')),
      planWith('read-only'),
    );
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(wrapped.file).toBe('/usr/bin/bwrap');
  });
});
