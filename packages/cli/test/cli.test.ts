import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { EXIT, type Io } from '../src/output.js';
import { CLI_VERSION } from '../src/version.js';

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

function argv(...args: string[]): string[] {
  return ['node', 'adze', ...args];
}

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'adze-cli-v-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fixture(name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content, 'utf8');
  return path;
}

describe('adze validate', () => {
  it('reports a well-formed file as validated, naming the level that ran', async () => {
    const file = await fixture('a.ts', 'export function f(): number {\n  return 1;\n}\n');
    const io = capture();

    const code = await run(argv('validate', file), io);

    expect(code).toBe(EXIT.Ok);
    expect(io.stdout()).toContain('ok');
    expect(io.stdout()).toContain('structural');
    // Never imply a parse that did not happen.
    expect(io.stdout()).not.toContain('tree-sitter');
  });

  it('exits non-zero on an unbalanced file and says where', async () => {
    const file = await fixture('a.ts', 'function f() {\n  return 1;\n');
    const io = capture();

    const code = await run(argv('validate', file), io);

    expect(code).toBe(EXIT.Failure);
    expect(io.stderr()).toContain('invalid');
    expect(io.stderr()).toContain("unclosed '{'");
  });

  it('catches an unterminated string', async () => {
    const file = await fixture('a.ts', 'const s = "oops;\nconst t = 1;\n');
    const io = capture();
    expect(await run(argv('validate', file), io)).toBe(EXIT.Failure);
    expect(io.stderr()).toContain('unterminated string');
  });

  it('catches a Python block whose body was dropped', async () => {
    const file = await fixture('a.py', 'def f():\nreturn 1\n');
    const io = capture();
    expect(await run(argv('validate', file), io)).toBe(EXIT.Failure);
    expect(io.stderr()).toContain('no indented body');
  });

  it('reports an unknown language as skipped, not as a pass', async () => {
    // The distinction is the whole point: `validator: 'none'` means we declined to
    // guess, which is a different claim from "this file parses".
    const file = await fixture('notes.xyz', '((( unbalanced everything\n');
    const io = capture();

    const code = await run(argv('validate', file), io);

    expect(code).toBe(EXIT.Ok);
    expect(io.stdout()).toContain('skipped');
    expect(io.stdout()).toContain('not checked');
    expect(io.stdout()).not.toMatch(/^ok/m);
  });

  it('validates several files and summarises the mix', async () => {
    const good = await fixture('good.ts', 'const a = 1;\n');
    const bad = await fixture('bad.ts', 'const a = {;\n');
    const unknown = await fixture('x.unknownext', 'whatever\n');
    const io = capture();

    const code = await run(argv('validate', good, bad, unknown), io);

    expect(code).toBe(EXIT.Failure);
    expect(io.stdout()).toContain('1 validated');
    expect(io.stdout()).toContain('1 skipped');
    expect(io.stdout()).toContain('1 invalid');
  });

  it('exits non-zero for a file it cannot read', async () => {
    const io = capture();
    const code = await run(argv('validate', join(dir, 'nope.ts')), io);
    expect(code).toBe(EXIT.Failure);
    expect(io.stderr()).toContain('error');
  });

  it('emits per-file outcomes under --json', async () => {
    const good = await fixture('good.ts', 'const a = 1;\n');
    const bad = await fixture('bad.ts', 'const a = {;\n');
    const io = capture();

    await run(argv('validate', good, bad, '--json'), io);

    const parsed = JSON.parse(io.stdout()) as {
      ok: boolean;
      counts: { valid: number; invalid: number };
      files: { outcome: string; validator?: string }[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.counts.valid).toBe(1);
    expect(parsed.counts.invalid).toBe(1);
    expect(parsed.files.every((f) => f.validator === 'structural')).toBe(true);
  });

  it('exits 2 when no files are given', async () => {
    const io = capture();
    expect(await run(argv('validate'), io)).toBe(EXIT.Usage);
  });
});

describe('adze doctor', () => {
  it('reports Node, platform, and architecture', async () => {
    const io = capture();
    const code = await run(argv('doctor'), io);

    expect(code).toBe(EXIT.Ok);
    expect(io.stdout()).toContain(`v${process.versions.node}`);
    expect(io.stdout()).toContain(process.platform);
    expect(io.stdout()).toContain(process.arch);
  });

  it('reports the CLI and protocol versions', async () => {
    const io = capture();
    await run(argv('doctor'), io);
    expect(io.stdout()).toContain(CLI_VERSION);
    expect(io.stdout()).toContain('protocol');
  });

  it('reports on pnpm, git, and ripgrep', async () => {
    const io = capture();
    await run(argv('doctor'), io);
    for (const tool of ['pnpm', 'git', 'ripgrep']) {
      expect(io.stdout()).toContain(tool);
    }
  });

  it('states the sandbox position for this platform without overclaiming', async () => {
    const io = capture();
    await run(argv('doctor'), io);
    const out = io.stdout();

    expect(out).toContain('Sandbox');
    expect(out).toContain('workspace-write');
    expect(out).toContain('on-request');

    if (process.platform === 'win32') {
      // ADR-0007 accepts shipping without Windows containment only on the condition
      // that we say so. This assertion is that condition, enforced.
      expect(out).toContain('There is no OS-level sandbox on Windows.');
      expect(out).toContain('permission gate');
      expect(out).toContain('0007-sandbox-and-permissions.md');
      expect(out).not.toContain('OS-level sandbox.\n');
    } else if (process.platform === 'darwin') {
      expect(out).toContain('Seatbelt');
    } else if (process.platform === 'linux') {
      expect(out).toContain('bubblewrap');
    }
  });

  it('never claims containment it does not have, in --json either', async () => {
    const io = capture();
    await run(argv('doctor', '--json'), io);

    const parsed = JSON.parse(io.stdout()) as {
      sandbox: { enforcement: string; osLevelContainment: boolean };
    };
    const expected = process.platform === 'darwin' || process.platform === 'linux';
    expect(parsed.sandbox.osLevelContainment).toBe(expected);
    expect(parsed.sandbox.enforcement).toBe(expected ? 'os-level' : 'gate-only');
  });

  it('exits 0 when only optional tooling is missing', async () => {
    // Otherwise `doctor` fails on any machine without ripgrep, people stop reading
    // it, and the sandbox warning above stops being seen — which is the failure that
    // actually matters here.
    const io = capture();
    expect(await run(argv('doctor'), io)).toBe(EXIT.Ok);
  });
});

describe('adze — top level', () => {
  it('prints the version', async () => {
    const io = capture();
    const code = await run(argv('--version'), io);
    expect(code).toBe(EXIT.Ok);
    expect(io.stdout().trim()).toBe(CLI_VERSION);
  });

  it('prints help listing the implemented commands', async () => {
    const io = capture();
    const code = await run(argv('--help'), io);
    expect(code).toBe(EXIT.Ok);
    for (const command of ['apply', 'validate', 'doctor', 'chat', 'run']) {
      expect(io.stdout()).toContain(command);
    }
  });

  it('treats a bare invocation as a request for help', async () => {
    const io = capture();
    const code = await run(argv(), io);
    expect(code).toBe(EXIT.Ok);
    expect(io.stdout()).toContain('Usage: adze');
  });

  it('exits 2 on an unknown command', async () => {
    const io = capture();
    expect(await run(argv('summon'), io)).toBe(EXIT.Usage);
  });
});

describe('adze — commands that are not built yet', () => {
  it('says plainly that chat is not implemented and points at the roadmap', async () => {
    // The alternative is an obscure failure, or worse a fake prompt. Neither is
    // acceptable: a planned capability must never read as a working one.
    const io = capture();
    const code = await run(argv('chat'), io);

    expect(code).toBe(EXIT.NotImplemented);
    expect(io.stderr()).toContain('not implemented yet');
    expect(io.stderr()).toContain('docs/roadmap.md');
    expect(io.stderr()).toContain('M1');
    // And it says what does work, so the message is useful rather than only honest.
    expect(io.stderr()).toContain('adze apply');
  });

  it('does the same for run, and tolerates extra arguments', async () => {
    const io = capture();
    const code = await run(argv('run', 'fix the failing test', '--model', 'whatever'), io);

    expect(code).toBe(EXIT.NotImplemented);
    expect(io.stderr()).toContain('not implemented yet');
    expect(io.stderr()).toContain('docs/roadmap.md');
  });
});
