/**
 * Tree-sitter validation tests.
 *
 * The contract under test is the honesty one, and it is the same contract
 * `SymbolExtraction.extractor` carries in `@adze/retrieval`:
 * `ValidationResult.validator` reports the level that *actually ran*. So every
 * assertion below checks `validator` as well as the outcome — a test that only
 * checked `ok` would pass on a package that lied about how it validated, which
 * is the failure mode that matters here because benchmark reports read that
 * field.
 *
 * Three groups. Grammar resolution is pure and always runs. The no-grammar path
 * always runs and must never report `tree-sitter`. The real-grammar path is
 * gated on `ADZE_GRAMMAR_DIR` the way retrieval gates its own, so it skips
 * loudly on a fresh clone rather than silently passing without a parse.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyEdit } from '../src/applier.js';
import {
  grammarFileForLanguage,
  resolveGrammarDirectory,
  resolveGrammarPath,
} from '../src/tree-sitter.js';
import { validate, validateAsync } from '../src/validate.js';

let dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

async function emptyDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'adze-apply-grammars-'));
  dirs.push(dir);
  return dir;
}

describe('grammar resolution', () => {
  it('maps known extensions to the tree-sitter wasm convention', () => {
    expect(grammarFileForLanguage('ts')).toBe('tree-sitter-typescript.wasm');
    expect(grammarFileForLanguage('tsx')).toBe('tree-sitter-tsx.wasm');
    expect(grammarFileForLanguage('js')).toBe('tree-sitter-javascript.wasm');
    expect(grammarFileForLanguage('py')).toBe('tree-sitter-python.wasm');
    expect(grammarFileForLanguage('go')).toBe('tree-sitter-go.wasm');
    expect(grammarFileForLanguage('rs')).toBe('tree-sitter-rust.wasm');
  });

  it('aliases resolve to the same grammar file', () => {
    expect(grammarFileForLanguage('mts')).toBe(grammarFileForLanguage('ts'));
    expect(grammarFileForLanguage('cts')).toBe(grammarFileForLanguage('ts'));
    expect(grammarFileForLanguage('mjs')).toBe(grammarFileForLanguage('js'));
    expect(grammarFileForLanguage('cjs')).toBe(grammarFileForLanguage('js'));
    expect(grammarFileForLanguage('jsx')).toBe(grammarFileForLanguage('js'));
    expect(grammarFileForLanguage('pyi')).toBe(grammarFileForLanguage('py'));
  });

  it('has no mapping for languages without a known-good grammar', () => {
    // No mapping means the filesystem is never touched for these: validation
    // falls back without a miss. JSON, shell, and the rest stay structural.
    expect(grammarFileForLanguage('json')).toBeUndefined();
    expect(grammarFileForLanguage('sh')).toBeUndefined();
    expect(grammarFileForLanguage('')).toBeUndefined();
    expect(grammarFileForLanguage('unknownext')).toBeUndefined();
  });

  it('names a grammar file matching the tree-sitter convention', () => {
    for (const extension of ['ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'py', 'pyi']) {
      expect(grammarFileForLanguage(extension), extension).toMatch(/^tree-sitter-[a-z]+\.wasm$/);
    }
  });

  it('prefers an explicit directory over the environment', async () => {
    const workspace = await emptyDir();
    vi.stubEnv('ADZE_GRAMMAR_DIR', join(workspace, 'from-env'));
    expect(resolveGrammarDirectory({ directory: join(workspace, 'explicit') })).toBe(
      join(workspace, 'explicit'),
    );
  });

  it('reads ADZE_GRAMMAR_DIR when no directory is given', async () => {
    const workspace = await emptyDir();
    vi.stubEnv('ADZE_GRAMMAR_DIR', join(workspace, 'from-env'));
    expect(resolveGrammarDirectory({ root: workspace })).toBe(join(workspace, 'from-env'));
  });

  it('defaults to <root>/.adze/grammars', async () => {
    const workspace = await emptyDir();
    // Stubbed away explicitly: a developer with this set in their shell would
    // otherwise see this test pass or fail based on their environment.
    vi.stubEnv('ADZE_GRAMMAR_DIR', undefined);
    expect(resolveGrammarDirectory({ root: workspace })).toBe(join(workspace, '.adze', 'grammars'));
  });

  it('prefers an explicit per-language file over any directory', async () => {
    const workspace = await emptyDir();
    const custom = join(workspace, 'custom', 'py.wasm');
    expect(
      resolveGrammarPath('py', { directory: join(workspace, 'dir'), files: { py: custom } }),
    ).toBe(custom);
  });

  it('resolves no path for an unmapped language, whatever the options', async () => {
    const workspace = await emptyDir();
    expect(resolveGrammarPath('json', { directory: workspace })).toBeUndefined();
  });
});

describe('validateAsync — no grammars present', () => {
  it('never reports tree-sitter when the grammar directory is empty', async () => {
    const directory = await emptyDir();
    const broken = 'function f() {\n  return 1;\n';
    const result = await validateAsync(broken, 'ts', { directory });
    expect(result.ok).toBe(false);
    // The structural checker catches this one too, and says so.
    expect(result.validator).toBe('structural');
    expect(result.validator).not.toBe('tree-sitter');
  });

  it('applies a valid edit at the structural level when grammars are absent', async () => {
    const directory = await emptyDir();
    const result = await applyEdit(
      {
        path: 'src/a.ts',
        original: 'const a = 1;\n',
        edits: [{ search: 'a = 1', replace: 'a = 2' }],
      },
      { grammarOptions: { directory } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.telemetry.validation.validator).toBe('structural');
  });

  it('refuses a broken edit without ever claiming a parse', async () => {
    const directory = await emptyDir();
    const result = await applyEdit(
      {
        path: 'src/a.ts',
        original: 'function f() {\n  return 1;\n}\n',
        edits: [{ search: '  return 1;\n}', replace: '  return 1;' }],
      },
      { grammarOptions: { directory } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('parse-broken');
    expect(result.telemetry.validation.validator).toBe('structural');
    expect(result.telemetry.validation.validator).not.toBe('tree-sitter');
  });

  it('reports none, not tree-sitter, for an unknown language', async () => {
    const directory = await emptyDir();
    const result = await validateAsync('still ( unbalanced', 'unknownext', { directory });
    expect(result.ok).toBe(true);
    expect(result.validator).toBe('none');
  });

  it('survives a corrupt grammar file instead of throwing', async () => {
    const directory = await emptyDir();
    await mkdir(directory, { recursive: true });
    // Not valid WASM. web-tree-sitter must reject it and we must survive that
    // by falling back, not by crashing the edit.
    await writeFile(join(directory, 'tree-sitter-typescript.wasm'), 'this is not wasm\n');
    const result = await validateAsync('const a = 1;\n', 'ts', { directory });
    expect(result.validator).toBe('structural');
    expect(result.ok).toBe(true);
  });

  it('validate() stays synchronous and structural-only', () => {
    // The existing public export keeps its shape: it cannot await a parse, so
    // it must never claim one happened.
    const result = validate('function f() {\n  return 1;\n', 'ts');
    expect(result.ok).toBe(false);
    expect(result.validator).toBe('structural');
  });
});

// ---------------------------------------------------------------------------
// Real grammars — opt-in, because WASM files are not vendored
// ---------------------------------------------------------------------------

const grammarDirectory = process.env.ADZE_GRAMMAR_DIR;
const withGrammars = grammarDirectory === undefined ? describe.skip : describe;

withGrammars('validateAsync — with real tree-sitter grammars', () => {
  it('accepts valid TypeScript with validator tree-sitter', async () => {
    const result = await validateAsync('const a: number = 1;\n', 'ts', {
      directory: grammarDirectory ?? '',
    });
    expect(result.ok).toBe(true);
    expect(result.validator).toBe('tree-sitter');
  });

  it('rejects a broken edit with validator tree-sitter', async () => {
    const result = await validateAsync('function f() {\n  return 1;\n', 'ts', {
      directory: grammarDirectory ?? '',
    });
    expect(result.ok).toBe(false);
    expect(result.validator).toBe('tree-sitter');
    expect(result.line).toBe(1);
  });

  it('refuses a broken edit through applyEdit at the tree-sitter level', async () => {
    const result = await applyEdit(
      {
        path: 'src/a.ts',
        original: 'function f() {\n  return 1;\n}\n',
        edits: [{ search: '  return 1;\n}', replace: '  return 1;' }],
      },
      { grammarOptions: { directory: grammarDirectory ?? '' } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('parse-broken');
    expect(result.telemetry.validation.validator).toBe('tree-sitter');
  });

  it('still applies a type error, which parses but does not typecheck', async () => {
    // A parser is not a typechecker. If tree-sitter validation rejected
    // well-formed code with a type error, every model fixing types would be
    // refused — so this must apply, at the tree-sitter level.
    const result = await applyEdit(
      {
        path: 'src/a.ts',
        original: 'const n: number = 1;\n',
        edits: [{ search: 'const n: number = 1;', replace: 'const n: number = "oops";' }],
      },
      { grammarOptions: { directory: grammarDirectory ?? '' } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('const n: number = "oops";\n');
    expect(result.telemetry.validation.validator).toBe('tree-sitter');
  });
});

describe('the tree-sitter level is earned, never hard-coded', () => {
  const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
  const SRC = join(PACKAGE_ROOT, 'src');

  async function sourceFiles(): Promise<readonly string[]> {
    const entries = await readdir(SRC, { withFileTypes: true, encoding: 'utf8' });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => join(SRC, entry.name));
  }

  /** Strip comment lines before scanning, so prose about the level is not a hit. */
  function stripComments(text: string): string {
    return text
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
      })
      .join('\n');
  }

  it("produces validator 'tree-sitter' in exactly one place: the completed parse", async () => {
    // Widening `structural` to `tree-sitter` must require editing one obvious
    // function, not one of several scattered assignments. `types.ts` declares
    // the union and is the only other file allowed to name the value.
    const holders: string[] = [];
    for (const file of await sourceFiles()) {
      const text = stripComments(await readFile(file, 'utf8'));
      if (/validator:\s*'tree-sitter'/.test(text)) holders.push(file);
    }
    expect(holders.map((file) => file.split(/[/\\]/).pop()).sort()).toEqual([
      'tree-sitter.ts',
      'types.ts',
    ]);
    const producer = await readFile(join(SRC, 'tree-sitter.ts'), 'utf8');
    expect(stripComments(producer).match(/validator:\s*'tree-sitter'/g)).toHaveLength(1);
  });

  it('imports web-tree-sitter dynamically, never at module scope', async () => {
    // On a fresh clone with no grammars the runtime WASM is never even read. A
    // static import would load it on the first `import '@adze/apply'`.
    const text = stripComments(await readFile(join(SRC, 'tree-sitter.ts'), 'utf8'));
    expect(text).toContain("await import('web-tree-sitter')");
    // The invariant is precisely this: no *static value* import. `import type`
    // erases at compile time and loads nothing.
    for (const line of text.split('\n')) {
      const staticValueImport =
        /^\s*(?:import|export)\s+(?!type\b)[^;]*from\s*['"]web-tree-sitter['"]/.exec(line);
      expect(staticValueImport, line.trim()).toBeNull();
    }
  });

  it('reads grammar bytes from disk instead of handing a loader a string', async () => {
    // `Language.load` accepts `string | Uint8Array`, and a string can be a URL.
    // Passing bytes is what makes a network fetch impossible rather than unlikely.
    const text = await readFile(join(SRC, 'tree-sitter.ts'), 'utf8');
    expect(text).toContain('bytes = await readFile(grammarPath)');
    expect(text).toContain('Language.load(bytes)');
  });

  it('never imports another Adze service package', async () => {
    // `@adze/apply` must not import `@adze/retrieval`'s loader: service packages
    // stay individually swappable and testable. The grammar convention is
    // duplicated on purpose; see the module comment in `tree-sitter.ts`.
    for (const file of await sourceFiles()) {
      const text = stripComments(await readFile(file, 'utf8'));
      const name = file.slice(SRC.length + 1);
      for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const specifier = match[1];
        expect(specifier, `${name}: ${specifier}`).not.toMatch(/^@adze\//);
      }
    }
  });
});
