import { describe, expect, it } from 'vitest';
import type { Wrapped } from '../src/broker-base.js';
import { planFor } from '../src/policy.js';
import type { SeatbeltOptions } from '../src/seatbelt.js';
import { buildSeatbeltProfile, SeatbeltBroker, seatbeltCapability } from '../src/seatbelt.js';
import type { CommandRequest, ContainmentPlan } from '../src/types.js';
import { containmentFor, requestFor } from './support.js';

/** `wrap` is protected because nothing outside a broker should call it in production. */
class ExposedSeatbelt extends SeatbeltBroker {
  expose(request: CommandRequest, plan: ContainmentPlan): Wrapped {
    return this.wrap(request, plan);
  }
}

function planWith(
  mode: 'read-only' | 'workspace-write' | 'full-access',
  roots: readonly string[] = ['/repo'],
  hosts: readonly string[] = [],
): ContainmentPlan {
  return planFor(
    containmentFor(mode, { writableRoots: roots, allowedNetworkHosts: hosts }),
    seatbeltCapability(true, mode),
    'darwin',
  );
}

describe('seatbeltCapability', () => {
  it('claims filesystem, network and whole-tree containment when available', () => {
    const capability = seatbeltCapability(true, 'workspace-write');
    expect(capability.confinesFilesystem).toBe(true);
    expect(capability.confinesNetwork).toBe(true);
    expect(capability.confinesSubprocessTree).toBe(true);
  });

  it('claims nothing when sandbox-exec is absent', () => {
    const capability = seatbeltCapability(false, 'workspace-write');
    expect(capability.confinesFilesystem).toBe(false);
    expect(capability.confinesSubprocessTree).toBe(false);
  });

  it('cannot express a per-host network allowlist', () => {
    expect(seatbeltCapability(true, 'workspace-write').supportsNetworkAllowlist).toBe(false);
  });

  // The profile permits operations by default, so it contains an agent doing damage
  // rather than code trying to escape. Recorded as hardening, so enforcement stays
  // os-level: the filesystem and network claims are still true.
  it('records the unrestricted syscall surface as hardening, not containment', () => {
    const degradation = seatbeltCapability(true, 'workspace-write').degradations.find(
      (d) => d.code === 'syscall-surface-unrestricted',
    );
    expect(degradation?.scope).toBe('hardening');
    expect(planWith('workspace-write').enforcement).toBe('os-level');
  });
});

describe('buildSeatbeltProfile', () => {
  it('denies all writes and all network under read-only', () => {
    const built = buildSeatbeltProfile(planWith('read-only'));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.profile).toContain('(version 1)');
    expect(built.profile).toContain('(deny file-write*)');
    expect(built.profile).toContain('(deny network*)');
    expect(built.profile).not.toContain('(subpath "/repo")');
  });

  it('grants writes to each writable root under workspace-write', () => {
    const built = buildSeatbeltProfile(planWith('workspace-write', ['/repo', '/cache']));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.profile).toContain('(allow file-write* (subpath "/repo"))');
    expect(built.profile).toContain('(allow file-write* (subpath "/cache"))');
  });

  // Order matters: a deny that came after the allows would silently revoke them.
  it('places the blanket deny before the per-root allows', () => {
    const built = buildSeatbeltProfile(planWith('workspace-write'));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.profile.indexOf('(deny file-write*)')).toBeLessThan(
      built.profile.indexOf('(allow file-write* (subpath "/repo"))'),
    );
  });

  it('keeps devices writable in every mode, listed rather than pattern-matched', () => {
    const built = buildSeatbeltProfile(planWith('read-only'));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.profile).toContain('(allow file-write* (literal "/dev/null"))');
    // /dev/disk0 is under the same prefix and writing it destroys the machine.
    expect(built.profile).not.toContain('/dev/disk');
  });

  // read-only means nothing is written. Excepting /tmp so compilers work would make
  // the mode's one sentence of documentation false.
  it('does not make temp writable under read-only', () => {
    const options: SeatbeltOptions = { writableTemp: ['/private/tmp'] };
    const built = buildSeatbeltProfile(planWith('read-only'), options);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.profile).not.toContain('/private/tmp');
  });

  it('makes temp writable under workspace-write when asked', () => {
    const options: SeatbeltOptions = { writableTemp: ['/private/tmp'] };
    const built = buildSeatbeltProfile(planWith('workspace-write'), options);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.profile).toContain('(allow file-write* (subpath "/private/tmp"))');
  });

  it('leaves network alone under full-access', () => {
    const built = buildSeatbeltProfile(planWith('full-access'));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.profile).not.toContain('(deny network*)');
  });

  describe('injection into the profile string', () => {
    it('escapes a quote so it cannot terminate the SBPL string', () => {
      const built = buildSeatbeltProfile(
        planWith('workspace-write', ['/repo/a"))(allow file-write* (subpath "/']),
      );
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      // Exactly one allow rule for a root, not two.
      const allows = built.profile
        .split('\n')
        .filter((line) => line.startsWith('(allow file-write* (subpath'));
      expect(allows).toHaveLength(1);
      expect(built.profile).toContain('\\"');
    });

    it('escapes a backslash', () => {
      const built = buildSeatbeltProfile(planWith('workspace-write', ['/repo/a\\b']));
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.profile).toContain('(allow file-write* (subpath "/repo/a\\\\b"))');
    });

    // A newline cannot be represented safely, so the answer is refusal rather than a
    // best guess at escaping it.
    it('refuses a path containing a newline', () => {
      const built = buildSeatbeltProfile(
        planWith('workspace-write', ['/repo/a\n(allow file-write* (subpath "/"))']),
      );
      expect(built.ok).toBe(false);
      if (built.ok) return;
      expect(built.unsafePath).toContain('\n');
    });

    it('refuses a path containing a NUL', () => {
      const built = buildSeatbeltProfile(planWith('workspace-write', ['/repo/a\u0000b']));
      expect(built.ok).toBe(false);
    });
  });
});

describe('SeatbeltBroker', () => {
  const broker = new ExposedSeatbelt(true, { platform: 'darwin' });

  it('reports os-level for both containment modes when available', () => {
    expect(broker.enforcement('read-only')).toBe('os-level');
    expect(broker.enforcement('workspace-write')).toBe('os-level');
  });

  it('reports not-applicable under full-access', () => {
    expect(broker.enforcement('full-access')).toBe('not-applicable');
  });

  it('reports gate-only when sandbox-exec is missing', () => {
    const absent = new ExposedSeatbelt(false, { platform: 'darwin' });
    expect(absent.enforcement('workspace-write')).toBe('gate-only');
  });

  it('wraps the command in sandbox-exec with the profile as one argument', () => {
    const containment = containmentFor('workspace-write');
    const wrapped = broker.expose(
      requestFor(['bash', '-lc', 'npm test'], containment),
      planWith('workspace-write'),
    );
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(wrapped.file).toBe('sandbox-exec');
    expect(wrapped.args[0]).toBe('-p');
    expect(wrapped.args[1]).toContain('(deny file-write*)');
    expect(wrapped.args.slice(2)).toEqual(['--', 'bash', '-lc', 'npm test']);
  });

  it('does not wrap under full-access', () => {
    const wrapped = broker.expose(
      requestFor(['bash', '-lc', 'ls'], containmentFor('full-access')),
      planWith('full-access'),
    );
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(wrapped.file).toBe('bash');
  });

  it('refuses an empty command', () => {
    const wrapped = broker.expose(
      requestFor([], containmentFor('workspace-write')),
      planWith('workspace-write'),
    );
    expect(wrapped.ok).toBe(false);
    if (wrapped.ok) return;
    expect(wrapped.code).toBe('empty-command');
  });

  // sandbox-exec would absorb a leading-dash program name as its own flag, which
  // could widen the very sandbox being built.
  it('refuses a program name that sandbox-exec would read as an option', () => {
    const wrapped = broker.expose(
      requestFor(['-p', 'evil'], containmentFor('workspace-write')),
      planWith('workspace-write'),
    );
    expect(wrapped.ok).toBe(false);
    if (wrapped.ok) return;
    expect(wrapped.code).toBe('program-name-option-like');
  });

  it('refuses rather than dropping the profile when a path cannot be expressed', () => {
    const wrapped = broker.expose(
      requestFor(['bash'], containmentFor('workspace-write')),
      planWith('workspace-write', ['/repo/a\nb']),
    );
    expect(wrapped.ok).toBe(false);
    if (wrapped.ok) return;
    expect(wrapped.code).toBe('mechanism-unavailable');
    expect(wrapped.reason).toContain('control character');
  });

  it('honours an explicit sandbox-exec path', () => {
    const custom = new ExposedSeatbelt(true, {
      platform: 'darwin',
      sandboxExecPath: '/usr/bin/sandbox-exec',
    });
    const wrapped = custom.expose(
      requestFor(['ls'], containmentFor('read-only')),
      planWith('read-only'),
    );
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(wrapped.file).toBe('/usr/bin/sandbox-exec');
  });
});
