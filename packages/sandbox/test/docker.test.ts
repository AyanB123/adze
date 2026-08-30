import { describe, expect, it } from 'vitest';
import type { Wrapped } from '../src/broker-base.js';
import type { DockerOptions } from '../src/docker.js';
import { buildDockerArgs, DockerBroker, dockerCapability } from '../src/docker.js';
import { planFor } from '../src/policy.js';
import type { CommandRequest, ContainmentPlan, SandboxMode } from '../src/types.js';
import { containmentFor, requestFor } from './support.js';

class ExposedDocker extends DockerBroker {
  expose(request: CommandRequest, plan: ContainmentPlan): Wrapped {
    return this.wrap(request, plan);
  }
}

const config: DockerOptions = { enabled: true, image: 'node:22', platform: 'linux' };

function planWith(mode: SandboxMode, roots: readonly string[] = ['/repo']): ContainmentPlan {
  return planFor(
    containmentFor(mode, { writableRoots: roots }),
    dockerCapability(true, mode),
    'linux',
  );
}

const target = { cwd: '/repo', file: 'npm', args: ['test'] };

describe('dockerCapability', () => {
  it('claims containment only when configured', () => {
    expect(dockerCapability(true, 'workspace-write').confinesFilesystem).toBe(true);
    expect(dockerCapability(false, 'workspace-write').confinesFilesystem).toBe(false);
  });

  // The decisive difference from every other mechanism: an unmounted path does not
  // exist inside the container rather than merely being unreadable.
  it('reports that only bound paths are visible', () => {
    expect(dockerCapability(true, 'workspace-write').readsOnlyBoundPaths).toBe(true);
    expect(planWith('workspace-write').readsAnywhere).toBe(false);
  });

  it('cannot express a per-host allowlist', () => {
    expect(dockerCapability(true, 'workspace-write').supportsNetworkAllowlist).toBe(false);
  });
});

describe('buildDockerArgs', () => {
  it('removes the container on exit', () => {
    expect(buildDockerArgs(planWith('workspace-write'), target, config)).toContain('--rm');
  });

  it('attaches stdin, so a filter command does not hang', () => {
    expect(buildDockerArgs(planWith('workspace-write'), target, config)).toContain('-i');
  });

  it('drops all capabilities and forbids new privileges', () => {
    const args = buildDockerArgs(planWith('workspace-write'), target, config);
    expect(args.join(' ')).toContain('--cap-drop ALL');
    expect(args.join(' ')).toContain('--security-opt no-new-privileges');
  });

  it('removes the network when the plan denies it', () => {
    expect(buildDockerArgs(planWith('workspace-write'), target, config).join(' ')).toContain(
      '--network none',
    );
  });

  it('keeps a network under full-access', () => {
    expect(buildDockerArgs(planWith('full-access'), target, config).join(' ')).toContain(
      '--network bridge',
    );
  });

  it('makes the container filesystem read-only under read-only', () => {
    expect(buildDockerArgs(planWith('read-only'), target, config)).toContain('--read-only');
    expect(buildDockerArgs(planWith('workspace-write'), target, config)).not.toContain(
      '--read-only',
    );
  });

  it('mounts a writable root read-write and everything else read-only', () => {
    const args = buildDockerArgs(planWith('workspace-write', ['/repo']), target, config);
    expect(args.join(' ')).toContain('-v /repo:/repo');
    expect(args.join(' ')).not.toContain('/repo:/repo:ro');
  });

  it('mounts the declared roots read-only under read-only', () => {
    const args = buildDockerArgs(planWith('read-only', ['/repo']), target, config);
    expect(args.join(' ')).toContain('-v /repo:/repo:ro');
  });

  it('sets the working directory and puts the image before the command', () => {
    const args = buildDockerArgs(planWith('workspace-write'), target, config);
    expect(args[args.indexOf('-w') + 1]).toBe('/repo');
    expect(args.slice(-3)).toEqual(['node:22', 'npm', 'test']);
  });

  it('passes a user mapping when given', () => {
    const args = buildDockerArgs(planWith('workspace-write'), target, {
      ...config,
      user: '1000:1000',
    });
    expect(args.join(' ')).toContain('--user 1000:1000');
  });

  it('omits the user mapping when not given, rather than guessing an id', () => {
    expect(buildDockerArgs(planWith('workspace-write'), target, config)).not.toContain('--user');
  });

  it('inserts extra arguments before the image', () => {
    const args = buildDockerArgs(planWith('workspace-write'), target, {
      ...config,
      extraArgs: ['--memory', '2g'],
    });
    expect(args.indexOf('--memory')).toBeLessThan(args.indexOf('node:22'));
  });
});

describe('DockerBroker', () => {
  it('reports os-level when configured', () => {
    expect(new ExposedDocker(config).enforcement('workspace-write')).toBe('os-level');
  });

  // ADR-0007 keeps Docker an explicit escape hatch. There is no default that turns
  // it on, and a broker constructed without one refuses rather than running loose.
  it('refuses when it was selected without being enabled', () => {
    const broker = new ExposedDocker({ enabled: false, image: 'node:22', platform: 'linux' });
    const wrapped = broker.expose(
      requestFor(['npm', 'test'], containmentFor('workspace-write')),
      planWith('workspace-write'),
    );
    expect(wrapped.ok).toBe(false);
    if (wrapped.ok) return;
    expect(wrapped.code).toBe('mechanism-unavailable');
    expect(wrapped.reason).toContain('escape hatch');
  });

  it('refuses when no image was named', () => {
    const broker = new ExposedDocker({ enabled: true, image: '', platform: 'linux' });
    const wrapped = broker.expose(
      requestFor(['npm', 'test'], containmentFor('workspace-write')),
      planWith('workspace-write'),
    );
    expect(wrapped.ok).toBe(false);
  });

  it('reports gate-only when it is not configured', () => {
    const broker = new ExposedDocker({ enabled: false, image: '', platform: 'linux' });
    expect(broker.enforcement('workspace-write')).toBe('gate-only');
  });

  it('wraps the command in docker run', () => {
    const wrapped = new ExposedDocker(config).expose(
      requestFor(['npm', 'test'], containmentFor('workspace-write')),
      planWith('workspace-write'),
    );
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(wrapped.file).toBe('docker');
    expect(wrapped.args[0]).toBe('run');
  });

  it('accepts a drop-in replacement such as podman', () => {
    const wrapped = new ExposedDocker({ ...config, dockerPath: 'podman' }).expose(
      requestFor(['npm', 'test'], containmentFor('workspace-write')),
      planWith('workspace-write'),
    );
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(wrapped.file).toBe('podman');
  });

  it('refuses a program name docker run would read as an option', () => {
    const wrapped = new ExposedDocker(config).expose(
      requestFor(['--privileged', 'sh'], containmentFor('workspace-write')),
      planWith('workspace-write'),
    );
    expect(wrapped.ok).toBe(false);
    if (wrapped.ok) return;
    expect(wrapped.code).toBe('program-name-option-like');
  });

  // Under Docker a path that was not mounted genuinely does not exist, so this is a
  // refusal rather than a confusing failure inside the container.
  it('refuses a working directory outside every mounted root', async () => {
    const broker = new ExposedDocker(config);
    const outcome = await broker.exec(
      requestFor(['npm', 'test'], containmentFor('workspace-write'), '/elsewhere'),
    );
    expect(outcome.kind).toBe('spawn-failed');
    if (outcome.kind !== 'spawn-failed') return;
    expect(outcome.refusal).toBe('cwd-outside-roots');
  });
});
