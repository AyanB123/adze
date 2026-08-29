import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { EXIT, type Io } from '../src/output.js';

/** Collects output so assertions run against what a user would actually see. */
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
  dir = await mkdtemp(join(tmpdir(), 'adze-cli-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fixture(name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content, 'utf8');
  return path;
}

describe('adze apply — success', () => {
  it('applies an exact edit and writes the file', async () => {
    const file = await fixture('server.ts', 'const port = 3000;\nstart(port);\n');
    const io = capture();

    const code = await run(
      argv(
        'apply',
        '--file',
        file,
        '--search',
        'const port = 3000;',
        '--replace',
        'const port = env.PORT ?? 3000;',
      ),
      io,
    );

    expect(code).toBe(EXIT.Ok);
    expect(await readFile(file, 'utf8')).toBe('const port = env.PORT ?? 3000;\nstart(port);\n');
    expect(io.stdout()).toContain('applied');
  });

  it('reports the tier and the match strategy that were used', async () => {
    // These are not decoration. Aggregated across runs they are what makes
    // "apply success rate per model per tier" a measurable claim, so the CLI has to
    // surface them rather than only reporting success.
    const file = await fixture('a.ts', 'let x = 1;\n');
    const io = capture();

    await run(
      argv('apply', '--file', file, '--search', 'let x = 1;', '--replace', 'const x = 1;'),
      io,
    );

    expect(io.stdout()).toContain('tier');
    expect(io.stdout()).toContain('search-replace');
    expect(io.stdout()).toContain('exact');
  });

  it('names the validator level that actually ran', async () => {
    const file = await fixture('a.ts', 'let x = 1;\n');
    const io = capture();

    await run(
      argv('apply', '--file', file, '--search', 'let x = 1;', '--replace', 'const x = 1;'),
      io,
    );

    // `structural`, not `tree-sitter`: no grammars are loaded, and the field is a
    // claim about evidence rather than a label.
    expect(io.stdout()).toContain('structural');
    expect(io.stdout()).not.toContain('tree-sitter');
  });

  it('says "not validated" rather than reporting a pass for an unknown language', async () => {
    const file = await fixture('notes.xyz', 'anything at all\n');
    const io = capture();

    const code = await run(
      argv('apply', '--file', file, '--search', 'anything', '--replace', 'something'),
      io,
    );

    expect(code).toBe(EXIT.Ok);
    expect(io.stdout()).toContain('not validated');
  });

  it('leaves the file untouched under --dry-run', async () => {
    const before = 'let x = 1;\n';
    const file = await fixture('a.ts', before);
    const io = capture();

    const code = await run(
      argv(
        'apply',
        '--file',
        file,
        '--search',
        'let x = 1;',
        '--replace',
        'const x = 1;',
        '--dry-run',
      ),
      io,
    );

    expect(code).toBe(EXIT.Ok);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(io.stdout()).toContain('dry run');
  });

  it('applies an ordered sequence of edits from --edits', async () => {
    const file = await fixture('a.ts', 'let a = 1;\nlet b = 2;\n');
    const editsFile = await fixture(
      'edits.json',
      JSON.stringify({
        edits: [
          { search: 'let a = 1;', replace: 'const a = 10;' },
          { search: 'let b = 2;', replace: 'const b = 20;' },
        ],
      }),
    );
    const io = capture();

    const code = await run(argv('apply', '--file', file, '--edits', editsFile), io);

    expect(code).toBe(EXIT.Ok);
    expect(await readFile(file, 'utf8')).toBe('const a = 10;\nconst b = 20;\n');
  });

  it('reindents a block the model quoted from the wrong nesting level', async () => {
    const original = ['class A {', '  run() {', '    return 1;', '  }', '}', ''].join('\n');
    const file = await fixture('a.ts', original);
    const editsFile = await fixture(
      'edits.json',
      JSON.stringify({
        edits: [{ search: 'run() {\n  return 1;\n}', replace: 'run() {\n  return 2;\n}' }],
      }),
    );
    const io = capture();

    const code = await run(argv('apply', '--file', file, '--edits', editsFile), io);

    expect(code).toBe(EXIT.Ok);
    expect(io.stdout()).toContain('indentation-tolerant');
    // Restored to the file's real indentation, not the model's.
    expect(await readFile(file, 'utf8')).toBe(
      ['class A {', '  run() {', '    return 2;', '  }', '}', ''].join('\n'),
    );
  });

  it('emits machine-readable output with full telemetry under --json', async () => {
    const file = await fixture('a.ts', 'let x = 1;\n');
    const io = capture();

    const code = await run(
      argv(
        'apply',
        '--file',
        file,
        '--search',
        'let x = 1;',
        '--replace',
        'const x = 1;',
        '--json',
      ),
      io,
    );

    expect(code).toBe(EXIT.Ok);
    const parsed: unknown = JSON.parse(io.stdout());
    expect(parsed).toMatchObject({
      ok: true,
      written: true,
      telemetry: { tier: 'search-replace', strategy: 'exact' },
    });
  });

  it('includes the resulting content in --json only on a dry run', async () => {
    const file = await fixture('a.ts', 'let x = 1;\n');
    const dry = capture();
    await run(
      argv(
        'apply',
        '--file',
        file,
        '--search',
        'let x = 1;',
        '--replace',
        'const x = 1;',
        '--dry-run',
        '--json',
      ),
      dry,
    );
    expect(JSON.parse(dry.stdout())).toHaveProperty('content');

    const wet = capture();
    await run(
      argv(
        'apply',
        '--file',
        file,
        '--search',
        'const x = 1;',
        '--replace',
        'const x = 2;',
        '--json',
      ),
      wet,
    );
    expect(JSON.parse(wet.stdout())).not.toHaveProperty('content');
  });
});

describe('adze apply — refusal exits non-zero', () => {
  it('refuses an ambiguous match and lists the candidates', async () => {
    const file = await fixture('a.ts', 'let x = 1;\nlet x = 1;\n');
    const io = capture();

    const code = await run(
      argv('apply', '--file', file, '--search', 'let x = 1;', '--replace', 'const x = 1;'),
      io,
    );

    expect(code).toBe(EXIT.Failure);
    expect(io.stderr()).toContain('refused');
    expect(io.stderr()).toContain('ambiguous');
    expect(io.stderr()).toContain('candidate matches');
    // The file must be exactly as it was.
    expect(await readFile(file, 'utf8')).toBe('let x = 1;\nlet x = 1;\n');
  });

  it('applies a specific occurrence when told which one', async () => {
    const file = await fixture('a.ts', 'let x = 1;\nlet x = 1;\n');
    const io = capture();

    const code = await run(
      argv(
        'apply',
        '--file',
        file,
        '--search',
        'let x = 1;',
        '--replace',
        'const x = 2;',
        '--occurrence',
        '2',
      ),
      io,
    );

    expect(code).toBe(EXIT.Ok);
    expect(await readFile(file, 'utf8')).toBe('let x = 1;\nconst x = 2;\n');
  });

  it('refuses a search block that is not there rather than finding the closest one', async () => {
    // `deleteUser` against `deleteUsers` is a different function. There is no
    // edit-distance strategy for exactly this reason.
    const file = await fixture('a.ts', 'export function deleteUsers(ids: string[]) {}\n');
    const io = capture();

    const code = await run(
      argv(
        'apply',
        '--file',
        file,
        '--search',
        'export function deleteUser(ids: string[]) {}',
        '--replace',
        'export function removeUser(ids: string[]) {}',
      ),
      io,
    );

    expect(code).toBe(EXIT.Failure);
    expect(io.stderr()).toContain('not-found');
    expect(await readFile(file, 'utf8')).toBe('export function deleteUsers(ids: string[]) {}\n');
  });

  it('refuses an edit that would break the parse, and writes nothing', async () => {
    const file = await fixture('a.ts', 'function f() {\n  return 1;\n}\n');
    const io = capture();

    const code = await run(argv('apply', '--file', file, '--search', '}', '--replace', ''), io);

    expect(code).toBe(EXIT.Failure);
    expect(io.stderr()).toContain('refused');
    expect(await readFile(file, 'utf8')).toBe('function f() {\n  return 1;\n}\n');
  });

  it('refuses a no-op', async () => {
    const file = await fixture('a.ts', 'let x = 1;\n');
    const io = capture();

    const code = await run(
      argv('apply', '--file', file, '--search', 'let x = 1;', '--replace', 'let x = 1;'),
      io,
    );

    expect(code).toBe(EXIT.Failure);
    expect(io.stderr()).toContain('no-op');
  });

  it('reports a refusal in --json with the reason and message', async () => {
    const file = await fixture('a.ts', 'let x = 1;\nlet x = 1;\n');
    const io = capture();

    const code = await run(
      argv(
        'apply',
        '--file',
        file,
        '--search',
        'let x = 1;',
        '--replace',
        'const x = 1;',
        '--json',
      ),
      io,
    );

    expect(code).toBe(EXIT.Failure);
    const parsed = JSON.parse(io.stdout()) as { ok: boolean; reason: string; message: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('ambiguous');
    // The message is written for a model to retry against, so it must say what
    // would disambiguate.
    expect(parsed.message).toContain('occurrence');
  });
});

describe('adze apply — usage errors', () => {
  it('exits 2 when the file does not exist', async () => {
    const io = capture();
    const code = await run(
      argv('apply', '--file', join(dir, 'missing.ts'), '--search', 'a', '--replace', 'b'),
      io,
    );
    expect(code).toBe(EXIT.Usage);
    expect(io.stderr()).toContain('cannot read');
  });

  it('exits 2 when neither --search/--replace nor --edits is given', async () => {
    const file = await fixture('a.ts', 'x\n');
    const io = capture();
    const code = await run(argv('apply', '--file', file), io);
    expect(code).toBe(EXIT.Usage);
    expect(io.stderr()).toContain('nothing to apply');
  });

  it('exits 2 when both inline and file edits are given', async () => {
    const file = await fixture('a.ts', 'x\n');
    const editsFile = await fixture('e.json', '{"edits":[]}');
    const io = capture();
    const code = await run(
      argv('apply', '--file', file, '--search', 'x', '--replace', 'y', '--edits', editsFile),
      io,
    );
    expect(code).toBe(EXIT.Usage);
    expect(io.stderr()).toContain('not both');
  });

  it('names the offending field in a malformed --edits file', async () => {
    // These files are usually produced by a model or a script, so the failure to
    // design for is a plausible file with one wrong field.
    const file = await fixture('a.ts', 'x\n');
    const editsFile = await fixture('e.json', '{"edits":[{"search":1,"replace":"y"}]}');
    const io = capture();
    const code = await run(argv('apply', '--file', file, '--edits', editsFile), io);
    expect(code).toBe(EXIT.Usage);
    expect(io.stderr()).toContain('edits[0].search must be a string');
  });

  it('rejects an --edits file that is not JSON', async () => {
    const file = await fixture('a.ts', 'x\n');
    const editsFile = await fixture('e.json', 'not json');
    const io = capture();
    const code = await run(argv('apply', '--file', file, '--edits', editsFile), io);
    expect(code).toBe(EXIT.Usage);
    expect(io.stderr()).toContain('not valid JSON');
  });

  it('rejects a non-positive --occurrence', async () => {
    const file = await fixture('a.ts', 'x\n');
    const io = capture();
    const code = await run(
      argv('apply', '--file', file, '--search', 'x', '--replace', 'y', '--occurrence', '0'),
      io,
    );
    expect(code).toBe(EXIT.Usage);
    expect(io.stderr()).toContain('positive integer');
  });

  it('exits 2 when --file is missing entirely', async () => {
    const io = capture();
    const code = await run(argv('apply', '--search', 'x', '--replace', 'y'), io);
    expect(code).toBe(EXIT.Usage);
  });
});
