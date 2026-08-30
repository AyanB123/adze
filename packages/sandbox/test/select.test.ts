import { describe, expect, it } from 'vitest';
import { BubblewrapBroker } from '../src/bubblewrap.js';
import { detectCapabilities } from '../src/capabilities.js';
import { DockerBroker } from '../src/docker.js';
import { FallbackBroker } from '../src/fallback.js';
import { SeatbeltBroker } from '../src/seatbelt.js';
import { createSandbox } from '../src/select.js';
import type { WindowsContainmentHelper } from '../src/windows.js';
import { WindowsBroker } from '../src/windows.js';
import { fakeProbe } from './support.js';

const MAC = fakeProbe({ platform: 'darwin', executables: ['/usr/bin/sandbox-exec'] });
const MAC_BARE = fakeProbe({ platform: 'darwin' });
const LINUX = fakeProbe({
  platform: 'linux',
  executables: ['/usr/bin/bwrap', '/usr/bin/docker'],
  files: { '/proc/sys/user/max_user_namespaces': '15000' },
});
const LINUX_NO_USERNS = fakeProbe({
  platform: 'linux',
  executables: ['/usr/bin/bwrap'],
  files: { '/proc/sys/kernel/unprivileged_userns_clone': '0' },
});
const WINDOWS = fakeProbe({
  platform: 'win32',
  executables: ['C:\\Windows\\System32\\taskkill.exe'],
  env: { PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' },
});

const workspace = { mode: 'workspace-write' as const, writableRoots: ['/repo'] };

describe('createSandbox picks the platform mechanism', () => {
  it('uses Seatbelt on macOS', async () => {
    const setup = await createSandbox({ sandbox: workspace, probe: MAC });
    expect(setup.broker).toBeInstanceOf(SeatbeltBroker);
    expect(setup.plan.enforcement).toBe('os-level');
  });

  it('uses bubblewrap on Linux', async () => {
    const setup = await createSandbox({ sandbox: workspace, probe: LINUX });
    expect(setup.broker).toBeInstanceOf(BubblewrapBroker);
    expect(setup.plan.enforcement).toBe('os-level');
  });

  it('uses the partial broker on Windows', async () => {
    const setup = await createSandbox({ sandbox: workspace, probe: WINDOWS });
    expect(setup.broker).toBeInstanceOf(WindowsBroker);
    expect(setup.plan.enforcement).toBe('gate-only');
  });

  it('falls back on a platform it has no story for', async () => {
    const setup = await createSandbox({
      sandbox: workspace,
      probe: fakeProbe({ platform: 'aix' }),
    });
    expect(setup.broker).toBeInstanceOf(FallbackBroker);
    expect(setup.plan.enforcement).toBe('gate-only');
    expect(setup.plan.degradations.some((d) => d.message.includes("'aix'"))).toBe(true);
  });
});

describe('degrading with a clear message rather than crashing', () => {
  it('falls back on macOS without sandbox-exec and keeps the specific reason', async () => {
    const setup = await createSandbox({ sandbox: workspace, probe: MAC_BARE });
    expect(setup.broker).toBeInstanceOf(FallbackBroker);
    expect(setup.plan.degradations.some((d) => d.message.includes('sandbox-exec'))).toBe(true);
  });

  // "No OS-level containment" is not actionable. The sysctl name is.
  it('falls back on Linux without user namespaces and names the sysctl', async () => {
    const setup = await createSandbox({ sandbox: workspace, probe: LINUX_NO_USERNS });
    expect(setup.broker).toBeInstanceOf(FallbackBroker);
    expect(
      setup.plan.degradations.some((d) => d.message.includes('unprivileged_userns_clone')),
    ).toBe(true);
  });

  it('never throws when nothing is available', async () => {
    await expect(
      createSandbox({ sandbox: workspace, probe: fakeProbe({ platform: 'linux' }) }),
    ).resolves.toBeDefined();
  });
});

describe('Docker is opt-in only', () => {
  // Selecting it because it is installed would reintroduce the prerequisite ADR-0007
  // rejected, and would change a user's containment because of an unrelated install.
  it('is not selected merely because it is installed', async () => {
    const setup = await createSandbox({ sandbox: workspace, probe: LINUX });
    expect(setup.broker).not.toBeInstanceOf(DockerBroker);
  });

  it('is selected when enabled with an image', async () => {
    const setup = await createSandbox({
      sandbox: workspace,
      probe: LINUX,
      docker: { enabled: true, image: 'node:22' },
    });
    expect(setup.broker).toBeInstanceOf(DockerBroker);
  });

  it('is not selected when enabled without an image', async () => {
    const setup = await createSandbox({
      sandbox: workspace,
      probe: LINUX,
      docker: { enabled: true, image: '' },
    });
    expect(setup.broker).toBeInstanceOf(BubblewrapBroker);
  });

  it('takes precedence over the platform mechanism when explicitly enabled', async () => {
    const setup = await createSandbox({
      sandbox: workspace,
      probe: MAC,
      docker: { enabled: true, image: 'node:22' },
    });
    expect(setup.broker).toBeInstanceOf(DockerBroker);
  });
});

describe('the Windows helper seam', () => {
  const helper: WindowsContainmentHelper = {
    name: 'sidecar',
    confinesFilesystem: true,
    confinesNetwork: true,
    supportsNetworkAllowlist: false,
    confinesSubprocessTree: true,
    wrap: (_plan, target) => ({ file: 'sidecar.exe', args: [target.file, ...target.args] }),
  };

  it('is the only thing that makes Windows report os-level', async () => {
    const without = await createSandbox({ sandbox: workspace, probe: WINDOWS });
    expect(without.plan.enforcement).toBe('gate-only');

    const withHelper = await createSandbox({
      sandbox: workspace,
      probe: WINDOWS,
      windowsHelper: helper,
    });
    expect(withHelper.plan.enforcement).toBe('os-level');
  });
});

describe('the reported setup', () => {
  it('normalizes the request into the shape core passes to exec', async () => {
    const setup = await createSandbox({
      sandbox: { mode: 'read-only' },
      probe: MAC,
    });
    expect(setup.containment).toEqual({
      mode: 'read-only',
      writableRoots: [],
      allowedNetworkHosts: [],
    });
  });

  it('returns the capability report that produced the choice', async () => {
    const setup = await createSandbox({ sandbox: workspace, probe: LINUX });
    expect(setup.capabilities.platform).toBe('linux');
    expect(setup.capabilities.preferred).toBe('bubblewrap');
  });

  // Two sources of truth for "what is enforced" is how a startup banner ends up
  // disagreeing with reality, so the plan comes from the broker that will run it.
  it('reports the plan from the selected broker, not from the platform', async () => {
    const setup = await createSandbox({ sandbox: workspace, probe: MAC_BARE });
    expect(setup.broker.enforcement('workspace-write')).toBe(setup.plan.enforcement);
  });

  it('accepts pre-computed capabilities so a process probes once', async () => {
    const capabilities = await detectCapabilities(LINUX);
    const setup = await createSandbox({ sandbox: workspace, probe: LINUX, capabilities });
    expect(setup.capabilities).toBe(capabilities);
    expect(setup.broker).toBeInstanceOf(BubblewrapBroker);
  });

  it('denies network by default under workspace-write', async () => {
    const setup = await createSandbox({ sandbox: workspace, probe: LINUX });
    expect(setup.plan.network.policy).toBe('deny');
  });

  it('reports the writable roots it will actually grant', async () => {
    const setup = await createSandbox({
      sandbox: { mode: 'workspace-write', writableRoots: ['/repo', '/repo/packages'] },
      probe: LINUX,
    });
    expect(setup.plan.writableRoots).toEqual(['/repo']);
  });
});
