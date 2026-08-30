import { describe, expect, it } from 'vitest';
import type { Wrapped } from '../src/broker-base.js';
import { planFor } from '../src/policy.js';
import type { CommandRequest, ContainmentPlan, SandboxMode } from '../src/types.js';
import type { WindowsContainmentHelper } from '../src/windows.js';
import { buildWindowsSandboxConfig, WindowsBroker, windowsCapability } from '../src/windows.js';
import { containmentFor, requestFor } from './support.js';

class ExposedWindows extends WindowsBroker {
  expose(request: CommandRequest, plan: ContainmentPlan): Wrapped {
    return this.wrap(request, plan);
  }
}

function planWith(mode: SandboxMode, helper?: WindowsContainmentHelper): ContainmentPlan {
  return planFor(
    containmentFor(mode, { writableRoots: ['C:\\repo'] }),
    windowsCapability(helper === undefined ? {} : { helper }, mode),
    'win32',
  );
}

/** What a Rust sidecar would look like from this side of the seam. */
const fakeHelper: WindowsContainmentHelper = {
  name: 'adze-win-broker',
  confinesFilesystem: true,
  confinesNetwork: true,
  supportsNetworkAllowlist: false,
  confinesSubprocessTree: true,
  wrap: (_plan, target) => ({
    file: 'adze-win-broker.exe',
    args: ['--exec', target.file, ...target.args],
  }),
};

describe('windowsCapability without a helper', () => {
  it('claims no containment of any kind', () => {
    const capability = windowsCapability({}, 'workspace-write');
    expect(capability.confinesFilesystem).toBe(false);
    expect(capability.confinesNetwork).toBe(false);
    expect(capability.confinesSubprocessTree).toBe(false);
    expect(capability.supportsNetworkAllowlist).toBe(false);
  });

  it('names each missing mechanism separately rather than saying "no sandbox"', () => {
    const codes = windowsCapability({}, 'workspace-write').degradations.map((d) => d.code);
    expect(codes).toContain('windows-no-restricted-token');
    expect(codes).toContain('windows-no-job-object');
    expect(codes).toContain('windows-no-appcontainer');
  });

  it('marks all three as containment gaps', () => {
    for (const degradation of windowsCapability({}, 'workspace-write').degradations) {
      expect(degradation.scope).toBe('containment');
    }
  });

  it('says descendants are killed when taskkill is present', () => {
    const job = windowsCapability(
      { processTreeTeardown: true },
      'workspace-write',
    ).degradations.find((d) => d.code === 'windows-no-job-object');
    expect(job?.message).toContain('taskkill');
    expect(job?.message).toContain('lifetime only');
  });

  it('says descendants may survive when taskkill is missing', () => {
    const job = windowsCapability(
      { processTreeTeardown: false },
      'workspace-write',
    ).degradations.find((d) => d.code === 'windows-no-job-object');
    expect(job?.message).toContain('may survive');
  });

  it('adds no degradations under full-access, where containment was not requested', () => {
    expect(windowsCapability({}, 'full-access').degradations).toEqual([]);
  });
});

describe('WindowsBroker enforcement honesty', () => {
  const broker = new ExposedWindows({ platform: 'win32', processTreeTeardown: true });

  // The claim ADR-0007 makes about Windows, asserted rather than documented.
  it('reports gate-only for both containment modes', () => {
    expect(broker.enforcement('read-only')).toBe('gate-only');
    expect(broker.enforcement('workspace-write')).toBe('gate-only');
  });

  it('reports not-applicable under full-access', () => {
    expect(broker.enforcement('full-access')).toBe('not-applicable');
  });

  it('cannot be made to report os-level by any combination of plan inputs', () => {
    for (const mode of ['read-only', 'workspace-write'] as const) {
      for (const hosts of [[], ['registry.npmjs.org']]) {
        const plan = planFor(
          containmentFor(mode, { writableRoots: ['C:\\repo'], allowedNetworkHosts: hosts }),
          windowsCapability({ processTreeTeardown: true }, mode),
          'win32',
        );
        expect(plan.enforcement).toBe('gate-only');
      }
    }
  });

  it('names itself as partial so a log line cannot imply more', () => {
    expect(broker.name).toBe('windows-partial');
  });

  it('spawns directly, with an argument array and no wrapper', () => {
    const wrapped = broker.expose(
      requestFor(['node', '-e', 'x'], containmentFor('workspace-write')),
      planWith('workspace-write'),
    );
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(wrapped.file).toBe('node');
    expect(wrapped.args).toEqual(['-e', 'x']);
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
});

describe('the native helper seam', () => {
  const broker = new ExposedWindows({ platform: 'win32', helper: fakeHelper });

  // The only thing that will ever make Windows report os-level, and the claim comes
  // from the helper's own declaration rather than from this package.
  it('reports os-level when a helper declares real containment', () => {
    expect(broker.enforcement('workspace-write')).toBe('os-level');
  });

  it('drops the Windows-specific degradations once a helper is present', () => {
    expect(windowsCapability({ helper: fakeHelper }, 'workspace-write').degradations).toEqual([]);
  });

  it('carries the helper name so an outcome says which boundary was in force', () => {
    expect(broker.name).toBe('windows-adze-win-broker');
  });

  it('wraps the command through the helper', () => {
    const wrapped = broker.expose(
      requestFor(['node', '-e', 'x'], containmentFor('workspace-write')),
      planWith('workspace-write', fakeHelper),
    );
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(wrapped.file).toBe('adze-win-broker.exe');
    expect(wrapped.args).toEqual(['--exec', 'node', '-e', 'x']);
  });

  it('refuses rather than running unwrapped when the helper cannot apply the plan', () => {
    const failing: WindowsContainmentHelper = {
      ...fakeHelper,
      wrap: () => ({ error: 'AppContainer profile could not be created' }),
    };
    const strict = new ExposedWindows({ platform: 'win32', helper: failing });
    const wrapped = strict.expose(
      requestFor(['node'], containmentFor('workspace-write')),
      planWith('workspace-write', failing),
    );
    expect(wrapped.ok).toBe(false);
    if (wrapped.ok) return;
    expect(wrapped.code).toBe('mechanism-unavailable');
    expect(wrapped.reason).toContain('AppContainer profile could not be created');
  });

  it('refuses a program name the helper would read as an option', () => {
    const wrapped = broker.expose(
      requestFor(['--exec', 'evil'], containmentFor('workspace-write')),
      planWith('workspace-write', fakeHelper),
    );
    expect(wrapped.ok).toBe(false);
    if (wrapped.ok) return;
    expect(wrapped.code).toBe('program-name-option-like');
  });

  it('bypasses the helper under full-access, where nothing was requested', () => {
    const wrapped = broker.expose(
      requestFor(['node'], containmentFor('full-access')),
      planWith('full-access', fakeHelper),
    );
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(wrapped.file).toBe('node');
  });
});

describe('buildWindowsSandboxConfig', () => {
  it('disables networking unless the mode is full-access', () => {
    const built = buildWindowsSandboxConfig(planWith('workspace-write'), ['C:\\repo']);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.xml).toContain('<Networking>Disable</Networking>');
  });

  // Found while writing this suite. Reading plan.network here generated a config that
  // ENABLED networking exactly when the user asked for it off: on Windows with no
  // helper the plan honestly reports network as unrestricted, because the selected
  // mechanism cannot restrict it. Windows Sandbox is a different mechanism and can, so
  // the requested mode is what this generator must honour.
  it('disables networking even though the Windows plan reports it unrestricted', () => {
    const plan = planWith('workspace-write');
    expect(plan.network.policy).toBe('unrestricted');
    const built = buildWindowsSandboxConfig(plan, ['C:\\repo']);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.xml).toContain('<Networking>Disable</Networking>');
  });

  it('enables networking under full-access', () => {
    const built = buildWindowsSandboxConfig(planWith('full-access'), ['C:\\repo']);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.xml).toContain('<Networking>Enable</Networking>');
  });

  it('maps a writable root writable under workspace-write', () => {
    const built = buildWindowsSandboxConfig(planWith('workspace-write'), ['c:\\repo']);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.xml).toContain('<ReadOnly>false</ReadOnly>');
  });

  it('maps every folder read-only under read-only', () => {
    const built = buildWindowsSandboxConfig(planWith('read-only'), ['c:\\repo']);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.xml).toContain('<ReadOnly>true</ReadOnly>');
  });

  it('escapes XML so a path cannot close a tag early', () => {
    const built = buildWindowsSandboxConfig(planWith('read-only'), [
      'C:\\a</HostFolder><ReadOnly>false</ReadOnly>',
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.xml).toContain('&lt;/HostFolder&gt;');
    expect(built.xml).not.toContain('<ReadOnly>false</ReadOnly>');
  });

  it('escapes an ampersand before the other entities, so nothing double-escapes', () => {
    const built = buildWindowsSandboxConfig(planWith('read-only'), ['C:\\a&b']);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.xml).toContain('C:\\a&amp;b');
    expect(built.xml).not.toContain('&amp;amp;');
  });

  it('refuses a path containing a control character', () => {
    const built = buildWindowsSandboxConfig(planWith('read-only'), ['C:\\a\u0000b']);
    expect(built.ok).toBe(false);
  });
});
