import { describe, expect, it } from 'vitest';
import { capability, detectCapabilities } from '../src/capabilities.js';
import { whichExecutable } from '../src/which.js';
import { fakeProbe } from './support.js';

const MAC = { platform: 'darwin', executables: ['/usr/bin/sandbox-exec'] };
const LINUX = {
  platform: 'linux',
  executables: ['/usr/bin/bwrap'],
  files: { '/proc/sys/user/max_user_namespaces': '15000\n' },
};
const WINDOWS = {
  platform: 'win32',
  executables: ['C:\\Windows\\System32\\taskkill.exe'],
  env: { PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' },
};

describe('whichExecutable', () => {
  it('finds a binary on PATH', async () => {
    expect(await whichExecutable('bwrap', fakeProbe(LINUX))).toBe('/usr/bin/bwrap');
  });

  it('returns undefined when it is absent', async () => {
    expect(await whichExecutable('bwrap', fakeProbe({ platform: 'linux' }))).toBeUndefined();
  });

  it('walks PATH entries in order', async () => {
    const probe = fakeProbe({
      platform: 'linux',
      executables: ['/usr/bin/tool', '/opt/bin/tool'],
      env: { PATH: '/opt/bin:/usr/bin' },
    });
    expect(await whichExecutable('tool', probe)).toBe('/opt/bin/tool');
  });

  // A stripped environment - which this package hands to subprocesses on purpose -
  // has no PATHEXT, and reporting taskkill as missing there would make every Windows
  // report wrong.
  it('applies the default PATHEXT on win32 when the variable is unset', async () => {
    expect(await whichExecutable('taskkill', fakeProbe(WINDOWS))).toBe(
      'C:\\Windows\\System32\\taskkill.exe',
    );
  });

  it('honours an explicit PATHEXT', async () => {
    const probe = fakeProbe({
      platform: 'win32',
      executables: ['C:\\bin\\tool.ps1'],
      env: { PATH: 'C:\\bin', PATHEXT: '.PS1' },
    });
    expect(await whichExecutable('tool', probe)).toBe('C:\\bin\\tool.ps1');
  });

  it('bypasses the PATH walk for an absolute name', async () => {
    const probe = fakeProbe({ platform: 'linux', executables: ['/opt/custom/bwrap'] });
    expect(await whichExecutable('/opt/custom/bwrap', probe)).toBe('/opt/custom/bwrap');
    expect(await whichExecutable('/opt/missing/bwrap', probe)).toBeUndefined();
  });

  it('reads Path as well as PATH, which Windows uses interchangeably', async () => {
    const probe = fakeProbe({
      platform: 'win32',
      executables: ['C:\\bin\\tool.exe'],
      env: { Path: 'C:\\bin' },
    });
    expect(await whichExecutable('tool', probe)).toBe('C:\\bin\\tool.exe');
  });
});

describe('detectCapabilities on macOS', () => {
  it('finds Seatbelt and prefers it', async () => {
    const caps = await detectCapabilities(fakeProbe(MAC));
    expect(capability(caps, 'seatbelt').available).toBe(true);
    expect(caps.preferred).toBe('seatbelt');
  });

  it('explains an absent sandbox-exec instead of just saying false', async () => {
    const caps = await detectCapabilities(fakeProbe({ platform: 'darwin' }));
    const seatbelt = capability(caps, 'seatbelt');
    expect(seatbelt.available).toBe(false);
    expect(seatbelt.detail).toContain('PATH');
    expect(caps.preferred).toBe('none');
  });

  it('reports bubblewrap as not applicable rather than missing', async () => {
    const detail = capability(await detectCapabilities(fakeProbe(MAC)), 'bubblewrap').detail;
    expect(detail).toContain('Linux-only');
  });
});

describe('detectCapabilities on Linux', () => {
  it('finds bubblewrap when user namespaces are available', async () => {
    const caps = await detectCapabilities(fakeProbe(LINUX));
    expect(capability(caps, 'bubblewrap').available).toBe(true);
    expect(caps.preferred).toBe('bubblewrap');
  });

  // Saying "bwrap is installed" while it cannot create a namespace is the exact false
  // claim this package exists to avoid.
  it('reports bubblewrap unusable when unprivileged_userns_clone is 0', async () => {
    const caps = await detectCapabilities(
      fakeProbe({ ...LINUX, files: { '/proc/sys/kernel/unprivileged_userns_clone': '0' } }),
    );
    const bwrap = capability(caps, 'bubblewrap');
    expect(bwrap.available).toBe(false);
    expect(bwrap.detail).toContain('unprivileged_userns_clone');
    // The binary was still found, and saying so is what makes the message actionable.
    expect(bwrap.path).toBe('/usr/bin/bwrap');
    expect(caps.preferred).toBe('none');
  });

  it('reports bubblewrap unusable when max_user_namespaces is 0', async () => {
    const caps = await detectCapabilities(
      fakeProbe({ ...LINUX, files: { '/proc/sys/user/max_user_namespaces': '0' } }),
    );
    expect(capability(caps, 'bubblewrap').available).toBe(false);
    expect(capability(caps, 'bubblewrap').detail).toContain('max_user_namespaces');
  });

  // The known Ubuntu 23.10+ friction. Stated as a caveat, because a packaged bwrap
  // has an AppArmor profile and works while a self-built one does not, and we cannot
  // tell which this host has without running it.
  it('notes the AppArmor restriction as a caveat rather than a verdict', async () => {
    const caps = await detectCapabilities(
      fakeProbe({
        ...LINUX,
        files: {
          '/proc/sys/user/max_user_namespaces': '15000',
          '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1',
        },
      }),
    );
    const bwrap = capability(caps, 'bubblewrap');
    expect(bwrap.available).toBe(true);
    expect(bwrap.verified).toBe(false);
    expect(bwrap.detail).toContain('AppArmor');
  });

  it('explains an absent bwrap with the package to install', async () => {
    const caps = await detectCapabilities(fakeProbe({ platform: 'linux' }));
    expect(capability(caps, 'bubblewrap').detail).toContain('bubblewrap package');
  });
});

describe('detectCapabilities on Windows', () => {
  it('finds taskkill and prefers the partial broker', async () => {
    const caps = await detectCapabilities(fakeProbe(WINDOWS));
    expect(capability(caps, 'windows-process-tree').available).toBe(true);
    expect(caps.preferred).toBe('windows-partial');
  });

  it('says taskkill bounds lifetime and not privileges', async () => {
    const caps = await detectCapabilities(fakeProbe(WINDOWS));
    expect(capability(caps, 'windows-process-tree').detail).toContain('not privileges');
  });

  // The three mechanisms that would make Windows containment real, and the reason
  // each is out of reach from TypeScript.
  it('reports the restricted token, job object and AppContainer as needing native code', async () => {
    const caps = await detectCapabilities(fakeProbe(WINDOWS));
    for (const id of [
      'windows-restricted-token',
      'windows-job-object',
      'windows-appcontainer',
    ] as const) {
      const mechanism = capability(caps, id);
      expect(mechanism.available).toBe(false);
      expect(mechanism.requiresNativeHelper).toBe(true);
      expect(mechanism.detail.length).toBeGreaterThan(40);
    }
  });

  it('names the specific Win32 calls that have no Node binding', async () => {
    const caps = await detectCapabilities(fakeProbe(WINDOWS));
    expect(capability(caps, 'windows-restricted-token').detail).toContain('CreateRestrictedToken');
    expect(capability(caps, 'windows-job-object').detail).toContain('AssignProcessToJobObject');
    expect(capability(caps, 'windows-appcontainer').detail).toContain('STARTUPINFOEX');
  });

  // A real VM-backed boundary that cannot serve an agent loop, because it hands back
  // no exit code, stdout or stderr.
  it('finds Windows Sandbox and marks it unusable for exec', async () => {
    const caps = await detectCapabilities(
      fakeProbe({
        ...WINDOWS,
        executables: [
          'C:\\Windows\\System32\\taskkill.exe',
          'C:\\Windows\\System32\\WindowsSandbox.exe',
        ],
      }),
    );
    const wsb = capability(caps, 'windows-sandbox');
    expect(wsb.available).toBe(true);
    expect(wsb.unusableForExec).toBe(true);
    expect(wsb.detail).toContain('exit code');
  });

  it('explains what enables Windows Sandbox when it is absent', async () => {
    const caps = await detectCapabilities(fakeProbe(WINDOWS));
    expect(capability(caps, 'windows-sandbox').detail).toContain('optional feature');
  });

  it('warns that descendants may survive when taskkill is missing', async () => {
    const caps = await detectCapabilities(fakeProbe({ platform: 'win32' }));
    expect(capability(caps, 'windows-process-tree').available).toBe(false);
    expect(caps.preferred).toBe('none');
  });
});

describe('escape hatches', () => {
  it('never prefers docker even when it is installed', async () => {
    const caps = await detectCapabilities(
      fakeProbe({ platform: 'linux', executables: ['/usr/bin/docker'] }),
    );
    expect(capability(caps, 'docker').available).toBe(true);
    expect(caps.preferred).toBe('none');
  });

  it('says why docker is never automatic', async () => {
    const caps = await detectCapabilities(
      fakeProbe({ platform: 'linux', executables: ['/usr/bin/docker'] }),
    );
    expect(capability(caps, 'docker').detail).toContain('escape hatch');
  });

  it('treats an absent docker as unremarkable', async () => {
    const caps = await detectCapabilities(fakeProbe({ platform: 'linux' }));
    expect(capability(caps, 'docker').detail).toContain('not a problem');
  });

  it('reports git for worktrees and says it is not a security boundary', async () => {
    const caps = await detectCapabilities(
      fakeProbe({ platform: 'linux', executables: ['/usr/bin/git'] }),
    );
    expect(capability(caps, 'git-worktree').available).toBe(true);
    expect(capability(caps, 'git-worktree').detail).toContain('not a security boundary');
  });
});

describe('verification', () => {
  // Found is not the same as works. Static detection leaves verified false, always.
  it('leaves verified false without an explicit probe', async () => {
    const caps = await detectCapabilities(fakeProbe(LINUX));
    for (const mechanism of caps.mechanisms) expect(mechanism.verified).toBe(false);
  });

  it('sets verified when a probe succeeds', async () => {
    const caps = await detectCapabilities(fakeProbe(LINUX), { verify: async () => true });
    const bwrap = capability(caps, 'bubblewrap');
    expect(bwrap.verified).toBe(true);
    expect(bwrap.detail).toContain('verified by running it');
  });

  it('marks a mechanism unavailable when the probe fails', async () => {
    const caps = await detectCapabilities(fakeProbe(LINUX), { verify: async () => false });
    const bwrap = capability(caps, 'bubblewrap');
    expect(bwrap.available).toBe(false);
    expect(bwrap.verified).toBe(false);
    expect(bwrap.detail).toContain('running it failed');
    expect(caps.preferred).toBe('none');
  });

  it('does not probe a mechanism that was already absent', async () => {
    const probed: string[] = [];
    await detectCapabilities(fakeProbe({ platform: 'linux' }), {
      verify: async (id) => {
        probed.push(id);
        return true;
      },
    });
    expect(probed).not.toContain('bubblewrap');
  });
});

describe('capability lookup', () => {
  it('returns a definite negative for a mechanism that was not probed', async () => {
    const caps = await detectCapabilities(fakeProbe({ platform: 'sunos' }));
    const seatbelt = capability(caps, 'seatbelt');
    expect(seatbelt.available).toBe(false);
    expect(caps.preferred).toBe('none');
  });
});
