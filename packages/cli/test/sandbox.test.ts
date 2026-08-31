/**
 * Tests for the OS sandbox wiring.
 *
 * These exist because of a specific defect: `@adze/sandbox` shipped roughly 2,965 lines
 * of Seatbelt, bubblewrap and Docker containment with 291 passing tests, and **no package
 * declared a dependency on it.** The CLI built `NodeSubprocessBroker` from `@adze/core`,
 * which core itself documents as "always `gate-only` for a containment mode, on every
 * platform", while `docs/roadmap.md` told a reader that macOS and Linux reported
 * `os-level`. The package's own tests all passed the whole time, because they tested the
 * package. Nothing tested whether it was reachable.
 *
 * So each test below is written to fail against that wiring rather than to describe the
 * new one:
 *
 * - the broker the CLI selects is never core's `node-subprocess` or a null broker;
 * - the broker the CLI selects is the one core's permission gate authorizes against,
 *   asserted through `initialize()`'s `osSandbox` capability, which reads
 *   `broker.enforcement('workspace-write') === 'os-level'`;
 * - `doctor` reports the plan's own enforcement and its complete degradation list, rather
 *   than `sandboxEnforcement(platform, mode)` — a function that answers a question about
 *   the *platform*, and said `os-level` on macOS and Linux regardless of what ran.
 *
 * ### What cannot be verified here
 *
 * **Nothing below proves that a write outside the writable roots is actually blocked.**
 * That needs a host with `sandbox-exec` or a usable `bwrap`, and it is asserted in
 * `packages/sandbox/test/platform.test.ts`, which skips on Windows. The fake
 * {@link HostProbe} makes every *report* reachable from every runner; it cannot make a
 * kernel boundary reachable, and a test implying otherwise would be worse than no test.
 * CI runs the real thing on the macOS and Ubuntu runners.
 */

import type { SandboxMode } from '@adze/protocol';
import type { ResolveOptions } from '@adze/providers';
import type {
  CommandOutcome,
  ContainmentPlan,
  HostProbe,
  SandboxBroker,
  SandboxEnforcement,
} from '@adze/sandbox';
import { describe, expect, it } from 'vitest';
import { denyingChannel, type LineReader } from '../src/agent/approval.js';
import {
  type CliSandbox,
  containmentJson,
  containmentLine,
  createCliSandbox,
  degradationLines,
  mechanismName,
} from '../src/agent/sandbox.js';
import { buildAgent } from '../src/agent/setup.js';
import { runChat } from '../src/commands/chat.js';
import { runDoctor } from '../src/commands/doctor.js';
import { EXIT, type Io } from '../src/output.js';

function capture(): Io & { readonly stdout: () => string; readonly stderr: () => string } {
  let out = '';
  let err = '';
  return {
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    stdout: () => out,
    stderr: () => err,
  };
}

/**
 * A configured provider that needs no credential and is never called.
 *
 * `env: {}` and `ignoreConfigFiles: true` are not decoration: without them these tests
 * would report whether the machine running them happens to export `OPENAI_API_KEY`. The
 * endpoint is never reached, because every test here stops before a model request.
 */
function localEndpoint(): ResolveOptions {
  return {
    env: {},
    ignoreConfigFiles: true,
    providers: {
      local: {
        kind: 'openai-compatible',
        baseURL: 'http://127.0.0.1:8790/v1',
        defaultModel: 'glm-5.2',
      },
    },
  };
}

/** A reader at end of input, so `chat` prints its banner and leaves without a turn. */
function endedReader(): LineReader {
  return { read: async () => undefined, close: () => undefined };
}

/**
 * A host with a fixed platform and a controllable set of binaries on `PATH`.
 *
 * The point of injecting this rather than reading `process`: three of the four platform
 * branches are unreachable from any single machine, so without it the Windows report is
 * only ever checked on Windows and the Seatbelt report only ever on macOS — which means
 * neither is checked on the machine where it was written.
 */
function fakeHost(platform: string, present: readonly string[] = []): HostProbe {
  const windows = platform === 'win32';
  const dir = windows ? 'C:\\Windows\\System32' : '/usr/bin';
  const separator = windows ? '\\' : '/';
  const runnable = present.map((name) => `${dir}${separator}${name}`.toLowerCase());
  return {
    platform,
    env: { PATH: dir, SystemRoot: 'C:\\Windows' },
    isExecutable: async (path: string) =>
      runnable.some((prefix) => path.toLowerCase().startsWith(prefix)),
    // Every sysctl reads as absent, which is the ordinary state: neither
    // `unprivileged_userns_clone` nor `max_user_namespaces` is 0, so user namespaces are
    // treated as available and `bwrap`'s presence decides the answer.
    readText: async () => undefined,
  };
}

/** A broker that claims a boundary. Runs nothing; only its claim is under test. */
function contrivedBroker(name: string, enforcement: SandboxEnforcement): SandboxBroker {
  return {
    name,
    enforcement: (mode: SandboxMode) => (mode === 'full-access' ? 'not-applicable' : enforcement),
    exec: async (): Promise<CommandOutcome> => ({
      kind: 'spawn-failed',
      message: 'this broker exists to be asked about its boundary, not to run anything',
      durationMs: 0,
    }),
  };
}

/** A plan for the contrived-broker tests, which assert on the broker rather than on it. */
function contrivedPlan(enforcement: SandboxEnforcement): ContainmentPlan {
  return {
    mode: 'workspace-write',
    mechanism: 'none',
    readableRoots: [],
    readsAnywhere: true,
    writableRoots: [],
    network: { policy: 'deny', hosts: [], enforced: true },
    enforcement,
    degradations:
      enforcement === 'os-level'
        ? []
        : [{ code: 'no-os-containment', scope: 'containment', message: 'contrived' }],
  };
}

async function sandboxFor(platform: string, present: readonly string[] = []): Promise<CliSandbox> {
  return await createCliSandbox({
    mode: 'workspace-write',
    writableRoots: [platform === 'win32' ? 'C:\\work' : '/work'],
    approvals: 'on-request',
    commandRules: [],
    probe: fakeHost(platform, present),
  });
}

describe('the CLI selects a broker from @adze/sandbox', () => {
  it('never hands the engine one of core\u2019s gate-only brokers', async () => {
    // The defect, stated as an assertion. `node-subprocess` and `null` are the two brokers
    // `@adze/core` ships, and both report `gate-only` in every containment mode by
    // construction; selecting either is how the product had no containment anywhere.
    const { broker } = await createCliSandbox({
      mode: 'workspace-write',
      writableRoots: [process.cwd()],
      approvals: 'on-request',
      commandRules: [],
    });

    expect(broker.name).not.toBe('node-subprocess');
    expect(broker.name).not.toBe('null');
  });

  it('picks the mechanism that belongs to the host, and no other', async () => {
    expect((await sandboxFor('darwin', ['sandbox-exec'])).plan.mechanism).toBe('seatbelt');
    expect((await sandboxFor('linux', ['bwrap'])).plan.mechanism).toBe('bubblewrap');
    expect((await sandboxFor('win32', ['taskkill'])).plan.mechanism).toBe('windows-partial');
    // A platform this package has no story for degrades rather than guessing.
    expect((await sandboxFor('freebsd')).plan.mechanism).toBe('none');
  });

  it('reaches os-level only where the mechanism is genuinely available', async () => {
    expect((await sandboxFor('darwin', ['sandbox-exec'])).plan.enforcement).toBe('os-level');
    expect((await sandboxFor('linux', ['bwrap'])).plan.enforcement).toBe('os-level');
    // Absent is absent. A macOS host with a stripped PATH gets `gate-only` — which is
    // exactly what `sandboxEnforcement('darwin', mode)` would have called `os-level`.
    expect((await sandboxFor('darwin')).plan.enforcement).toBe('gate-only');
    expect((await sandboxFor('linux')).plan.enforcement).toBe('gate-only');
  });

  it('never reports os-level on Windows, with or without taskkill', async () => {
    for (const present of [[], ['taskkill']]) {
      const { plan } = await sandboxFor('win32', present);
      expect(plan.enforcement).toBe('gate-only');
      expect(containmentLine(plan)).not.toContain('os-level');
    }
  });

  it('names the three Windows mechanisms that are not applied', async () => {
    // Three separate degradations rather than one "no sandbox" line, because each names a
    // different missing mechanism and a different piece of work. ADR-0007 accepts the gap
    // only on the condition that it is stated, and this is that statement as data.
    const { plan } = await sandboxFor('win32', ['taskkill']);
    const codes = plan.degradations.map((gap) => gap.code);

    expect(codes).toContain('windows-no-restricted-token');
    expect(codes).toContain('windows-no-job-object');
    expect(codes).toContain('windows-no-appcontainer');
  });

  it('reports the unrestricted syscall surface even where enforcement is os-level', async () => {
    // The one claim that is weaker than "os-level" sounds. These mechanisms contain an
    // agent doing damage; they are not a boundary against code trying to escape.
    for (const [platform, binary] of [
      ['darwin', 'sandbox-exec'],
      ['linux', 'bwrap'],
    ] as const) {
      const { plan } = await sandboxFor(platform, [binary]);
      expect(plan.enforcement).toBe('os-level');
      expect(plan.degradations.map((gap) => gap.code)).toContain('syscall-surface-unrestricted');
      expect(degradationLines(plan).join('\n')).toContain('syscall');
    }
  });

  it('keeps every degradation in the rendered list, worst first', async () => {
    const { plan } = await sandboxFor('win32', ['taskkill']);
    const lines = degradationLines(plan);

    // Nothing filtered: the rendered count is the plan's count. A surface that trimmed
    // this for brevity would leave a user believing in a boundary that is not there.
    expect(lines).toHaveLength(plan.degradations.length);
    const rendered = containmentJson(plan).degradations as readonly { scope: string }[];
    expect(rendered[0]?.scope).toBe('containment');
  });
});

describe('the selected broker reaches the permission gate', () => {
  function agentWith(containment: CliSandbox) {
    return buildAgent({
      workspaceRoot: process.cwd(),
      sandboxMode: 'workspace-write',
      approvals: 'on-request',
      commandRules: [],
      sink: () => undefined,
      approvalChannel: denyingChannel('not consulted in this test'),
      containment,
      resolve: localEndpoint(),
    });
  }

  function initialize(containment: CliSandbox) {
    return agentWith(containment).engine.initialize({
      protocolVersions: ['0.1'],
      client: { name: 'test', version: '0', platform: process.platform },
    });
  }

  it('reports osSandbox from the wired broker rather than from core\u2019s default', () => {
    // This is the assertion that fails against the old wiring. `initialize()` derives
    // `osSandbox` from `broker.enforcement('workspace-write') === 'os-level'`, and
    // `NodeSubprocessBroker` — which the CLI hardcoded — can never return that. A
    // contained broker reaching the gate is observable, and its absence was too.
    const init = initialize({
      broker: contrivedBroker('contrived-contained', 'os-level'),
      plan: contrivedPlan('os-level'),
    });

    expect(init.capabilities.osSandbox).toBe(true);
    expect(init.warnings.map((warning) => warning.code)).not.toContain('no-os-sandbox');
  });

  it('still warns, and names the broker, when the wired broker confines nothing', () => {
    const init = initialize({
      broker: contrivedBroker('contrived-uncontained', 'gate-only'),
      plan: contrivedPlan('gate-only'),
    });

    expect(init.capabilities.osSandbox).toBe(false);
    // Naming the broker is what makes the warning checkable: the sentence changed the
    // moment the wiring did, from `broker 'node-subprocess'` to the real mechanism.
    const warning = init.warnings.find((entry) => entry.code === 'no-os-sandbox');
    expect(warning?.message).toContain("broker 'contrived-uncontained'");
  });

  it('returns the plan so a surface renders the boundary in force, not the request', async () => {
    const agent = agentWith(await sandboxFor('win32', ['taskkill']));

    // `agent.sandbox` is what was asked for; `agent.containment` is what will happen.
    expect(agent.sandbox.mode).toBe('workspace-write');
    expect(agent.containment.enforcement).toBe('gate-only');
    expect(agent.containment.degradations.length).toBeGreaterThan(0);
  });
});

describe('adze chat reports the plan before the first prompt', () => {
  it('names the containment and every gap, from the real host', async () => {
    // Drives the shipped path: no `containment` hook, so this is the broker a user gets.
    // `chat` rather than `run` because an ended reader leaves the REPL before any model
    // request, which makes the preamble observable with no network at all.
    const io = capture();

    const code = await runChat(
      { __testHooks: { resolve: localEndpoint(), reader: endedReader() } },
      io,
    );
    const out = io.stdout();

    expect(code).toBe(EXIT.Ok);
    expect(out).toContain('containment:');
    // The old banner said nothing about containment, and the engine warning beneath it
    // named `broker 'node-subprocess'`. Neither can appear now.
    expect(out).not.toContain('node-subprocess');
    // Whatever the enforcement, the gaps are listed rather than counted.
    expect(out).toContain('not enforced');

    if (process.platform === 'win32') {
      expect(out).toContain('gate-only');
      expect(out).toContain('windows-no-appcontainer');
    } else {
      // On macOS and Linux the answer depends on the host, which is the point: a stripped
      // PATH or a disabled sysctl means `gate-only`, and the banner says so.
      expect(out).toMatch(/containment: (os-level|gate-only)/);
    }
  });
});

describe('adze doctor reports the plan, not the platform', () => {
  function doctorOn(platform: string, present: readonly string[] = []) {
    return {
      __testHooks: {
        resolve: localEndpoint(),
        probe: fakeHost(platform, present),
        // Stubbed so these assertions do not also pay for a real `bash -lc exit 0` on every
        // call. The shell is unrelated to the sandbox report, and probing it seven times to
        // check one paragraph is how a suite gets a timeout instead of a result.
        probeShell: async () => ({ ok: true, value: '/usr/bin/bash', detail: undefined }),
      },
    };
  }

  it('reports os-level on a macOS host that has sandbox-exec', async () => {
    const io = capture();
    const code = await runDoctor(doctorOn('darwin', ['sandbox-exec']), io);
    const out = io.stdout();

    expect(code).toBe(EXIT.Ok);
    expect(out).toContain('Seatbelt');
    expect(out).toContain('os-level');
    // Even here: the syscall surface is not restricted, and the report says so.
    expect(out).toContain('syscall-surface-unrestricted');
  });

  it('reports gate-only on a macOS host that does not, and says why', async () => {
    // The case `sandboxEnforcement('darwin', mode)` got wrong, and would still get wrong.
    const io = capture();
    await runDoctor(doctorOn('darwin'), io);
    const out = io.stdout();

    expect(out).toContain('gate-only');
    expect(out).not.toContain('os-level');
    expect(out).toContain('sandbox-exec');
  });

  it('reports os-level on a Linux host with usable bubblewrap', async () => {
    const io = capture();
    await runDoctor(doctorOn('linux', ['bwrap']), io);

    expect(io.stdout()).toContain('bubblewrap');
    expect(io.stdout()).toContain('os-level');
  });

  it('names the missing bubblewrap package on a Linux host without it', async () => {
    const io = capture();
    await runDoctor(doctorOn('linux'), io);

    expect(io.stdout()).toContain('gate-only');
    // "No OS-level containment" is not actionable; naming the package is.
    expect(io.stdout()).toContain('bwrap was not found on PATH');
  });

  it('never reports os-level for Windows, and names the three missing mechanisms', async () => {
    const io = capture();
    await runDoctor(doctorOn('win32', ['taskkill']), io);
    const out = io.stdout();

    expect(out).toContain('There is no OS-level sandbox on Windows.');
    expect(out).toContain('gate-only');
    expect(out).not.toContain('os-level (');
    expect(out).toContain('windows-no-restricted-token');
    expect(out).toContain('windows-no-job-object');
    expect(out).toContain('windows-no-appcontainer');
  });

  it('carries the plan into --json, including every degradation', async () => {
    const io = capture();
    await runDoctor({ json: true, ...doctorOn('win32', ['taskkill']) }, io);

    const parsed = JSON.parse(io.stdout()) as {
      sandbox: {
        enforcement: string;
        osLevelContainment: boolean;
        mechanism: string;
        degradations: readonly { code: string; scope: string }[];
      };
    };

    expect(parsed.sandbox.enforcement).toBe('gate-only');
    expect(parsed.sandbox.osLevelContainment).toBe(false);
    expect(parsed.sandbox.mechanism).toBe('windows-partial');
    // As data, not as a paragraph: a consumer gating CI on containment needs the codes.
    expect(parsed.sandbox.degradations.map((gap) => gap.code)).toEqual(
      expect.arrayContaining([
        'windows-no-restricted-token',
        'windows-no-job-object',
        'windows-no-appcontainer',
      ]),
    );
  });

  it('keeps the boolean and the string from disagreeing on any host', async () => {
    for (const [platform, present] of [
      ['darwin', ['sandbox-exec']],
      ['darwin', []],
      ['linux', ['bwrap']],
      ['linux', []],
      ['win32', ['taskkill']],
      ['win32', []],
      ['freebsd', []],
    ] as const) {
      const io = capture();
      await runDoctor({ json: true, ...doctorOn(platform, present) }, io);
      const parsed = JSON.parse(io.stdout()) as {
        sandbox: { enforcement: string; osLevelContainment: boolean };
      };

      // Two independent answers to "is this contained" is how one of them ends up wrong,
      // so the boolean is derived from the string and this asserts it stays derived.
      expect(parsed.sandbox.osLevelContainment).toBe(parsed.sandbox.enforcement === 'os-level');
      // `not-applicable` is reserved for `full-access`, which is never the default.
      expect(parsed.sandbox.enforcement).not.toBe('not-applicable');
      if (platform === 'win32') expect(parsed.sandbox.enforcement).toBe('gate-only');
    }
    // Seven `doctor` runs, each of which still shells out for the pnpm and git versions.
  }, 30_000);
});

describe('mechanism names', () => {
  it('spells each mechanism the way a reader would', () => {
    expect(mechanismName('seatbelt')).toBe('Seatbelt');
    expect(mechanismName('bubblewrap')).toBe('bubblewrap');
    expect(mechanismName('docker')).toBe('Docker');
    // Not "windows": the broker confines nothing, and a one-word label that read like a
    // mechanism would be the whole overclaim in miniature.
    expect(mechanismName('windows-partial')).toContain('no Windows mechanism');
    expect(mechanismName('none')).toBe('none');
  });
});
