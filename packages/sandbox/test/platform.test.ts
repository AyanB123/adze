/**
 * Tests that need the real mechanism, gated on the real host.
 *
 * These are the only tests here that prove containment rather than describing it:
 * everything else asserts a generated profile or argument list, which is necessary but
 * would happily pass with a profile the kernel ignores. So on a host that actually has
 * Seatbelt or a usable bubblewrap, a write outside the writable roots is attempted and
 * must fail.
 *
 * Where the mechanism is absent — every Windows runner, and Linux runners without
 * unprivileged user namespaces — the suite skips and **says so on stderr**. A silent
 * skip reads as a pass in CI output, which is how a sandbox stops being tested without
 * anyone noticing.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BubblewrapBroker } from '../src/bubblewrap.js';
import { capability, detectCapabilities } from '../src/capabilities.js';
import { SeatbeltBroker } from '../src/seatbelt.js';
import type { CommandOutcome } from '../src/types.js';
import { nodeHostProbe } from '../src/which.js';

const capabilities = await detectCapabilities(nodeHostProbe());
const seatbelt = capability(capabilities, 'seatbelt');
const bubblewrap = capability(capabilities, 'bubblewrap');

const seatbeltReady = process.platform === 'darwin' && seatbelt.available;
const bubblewrapReady = process.platform === 'linux' && bubblewrap.available;

if (!seatbeltReady && !bubblewrapReady) {
  // Written straight to stderr rather than through `console.warn`. Vitest intercepts
  // console output inside test files and attributes it to a test, so a notice emitted
  // during module evaluation is swallowed by the default reporter — which would make
  // this exactly the silent skip it exists to prevent.
  process.stderr.write(
    `\n[@adze/sandbox] SKIPPING real-containment tests on platform '${process.platform}'.\n` +
      `  Seatbelt:   ${seatbelt.detail}\n` +
      `  bubblewrap: ${bubblewrap.detail}\n` +
      '  Generated profiles and argument lists are still asserted by the other suites, ' +
      'but nothing\n  here proved that the kernel enforces them on this host.\n\n',
  );
}

const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'adze-sandbox-real-'));
  dirs.push(dir);
  return dir;
}

function env(): Record<string, string> {
  return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? tmpdir() };
}

/** Attempt a write, reporting the outcome rather than throwing. */
function writeScript(target: string): string {
  return (
    'const fs = require("node:fs"); ' +
    `try { fs.writeFileSync(${JSON.stringify(target)}, "escaped"); ` +
    'process.stdout.write("WROTE"); } ' +
    'catch (e) { process.stdout.write("BLOCKED:" + e.code); }'
  );
}

async function attempt(
  broker: SeatbeltBroker | BubblewrapBroker,
  writable: string,
  target: string,
  cwd: string,
): Promise<CommandOutcome> {
  return await broker.exec({
    command: [process.execPath, '-e', writeScript(target)],
    cwd,
    env: env(),
    timeoutMs: 30_000,
    signal: new AbortController().signal,
    containment: {
      mode: 'workspace-write',
      writableRoots: [writable],
      allowedNetworkHosts: [],
    },
  });
}

describe.skipIf(!seatbeltReady)('Seatbelt really contains writes', () => {
  it('permits a write inside a writable root', async () => {
    const writable = await scratch();
    const target = join(writable, 'inside.txt');
    const outcome = await attempt(
      new SeatbeltBroker(true, { env: env() }),
      writable,
      target,
      writable,
    );
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.stdout).toBe('WROTE');
    expect(outcome.enforcement).toBe('os-level');
    expect(await readFile(target, 'utf8')).toBe('escaped');
  });

  it('blocks a write outside every writable root', async () => {
    const writable = await scratch();
    const forbidden = await scratch();
    const target = join(forbidden, 'outside.txt');
    const outcome = await attempt(
      new SeatbeltBroker(true, { env: env() }),
      writable,
      target,
      writable,
    );
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.stdout).toContain('BLOCKED');
  });
});

describe.skipIf(!bubblewrapReady)('bubblewrap really contains writes', () => {
  it('permits a write inside a writable root', async () => {
    const writable = await scratch();
    const target = join(writable, 'inside.txt');
    const outcome = await attempt(
      new BubblewrapBroker(true, { env: env() }),
      writable,
      target,
      writable,
    );
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.stdout).toBe('WROTE');
    expect(outcome.enforcement).toBe('os-level');
  });

  it('blocks a write outside every writable root', async () => {
    const writable = await scratch();
    const forbidden = await scratch();
    const target = join(forbidden, 'outside.txt');
    const outcome = await attempt(
      new BubblewrapBroker(true, { env: env() }),
      writable,
      target,
      writable,
    );
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.stdout).toContain('BLOCKED');
  });
});

describe('the capability report is usable on this host', () => {
  // Runs everywhere, including where nothing is available: the report must be
  // populated and self-explaining rather than empty.
  it('describes every mechanism it probed', () => {
    expect(capabilities.mechanisms.length).toBeGreaterThan(0);
    for (const mechanism of capabilities.mechanisms) {
      expect(mechanism.detail.length).toBeGreaterThan(10);
    }
  });

  it('never reports a mechanism as verified without having run it', () => {
    for (const mechanism of capabilities.mechanisms) expect(mechanism.verified).toBe(false);
  });
});
