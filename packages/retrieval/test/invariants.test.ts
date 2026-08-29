/**
 * The architecture invariants, asserted rather than reviewed.
 *
 * `docs/architecture/README.md` and `.cursor/rules/architecture-invariants.mdc`
 * state these as review rules. A review rule holds until the reviewer is tired,
 * so the ones that can be checked mechanically are checked here.
 *
 * The most important one is the local-first promise. ADR-0006 makes retrieval the
 * place where Adze differs most sharply from the incumbent, which documents that
 * it uploads code chunks to compute embeddings and routes requests through its
 * backend even with a user-supplied API key. "We do not do that" is only worth
 * saying if it is checkable, so this file checks it: no network module is imported
 * anywhere in `src/`, and grammar bytes are read from disk rather than handed to a
 * loader that would accept a URL.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(PACKAGE_ROOT, 'src');

async function sourceFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Strip comment lines before scanning.
 *
 * The package's doc comments contain usage examples and prose about the incumbent
 * uploading chunks. A scanner counting those would report violations that are not
 * there, and one false positive makes the whole file untrusted.
 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

interface Import {
  readonly file: string;
  readonly specifier: string;
}

async function importSpecifiers(): Promise<readonly Import[]> {
  const found: Import[] = [];
  for (const file of await sourceFiles(SRC)) {
    const text = stripComments(await readFile(file, 'utf8'));
    const relative = file.slice(SRC.length + 1).replaceAll('\\', '/');
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier !== undefined) found.push({ file: relative, specifier });
    }
  }
  return found;
}

async function packageJson(): Promise<{
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly exports?: unknown;
  readonly license?: string;
}> {
  const text = await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8');
  return JSON.parse(text) as Awaited<ReturnType<typeof packageJson>>;
}

describe('nothing leaves the machine', () => {
  it('imports no network module anywhere in src', async () => {
    // Local-first is a product promise, and this is the package where it is most
    // load-bearing. A new outbound call needs an ADR, not a commit.
    const forbidden = [
      'node:http',
      'node:https',
      'node:http2',
      'node:net',
      'node:dgram',
      'node:tls',
      'undici',
      'axios',
      'node-fetch',
      'got',
      'superagent',
      'ws',
    ];
    const offenders = (await importSpecifiers()).filter((entry) =>
      forbidden.some(
        (module) => entry.specifier === module || entry.specifier.startsWith(`${module}/`),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('calls no global fetch and constructs no URL request', async () => {
    for (const file of await sourceFiles(SRC)) {
      const text = stripComments(await readFile(file, 'utf8'));
      const name = file.slice(SRC.length + 1);
      expect(text, name).not.toMatch(/\bfetch\s*\(/);
      expect(text, name).not.toMatch(/\bnew\s+Request\s*\(/);
      expect(text, name).not.toMatch(/\bXMLHttpRequest\b/);
      expect(text, name).not.toMatch(/https?:\/\/[^\s'"`]*['"`]\s*\)/);
    }
  });

  it('reads grammar bytes from disk instead of handing a loader a string', async () => {
    // `Language.load` accepts `string | Uint8Array`, and a string can be a URL.
    // Passing bytes is what makes a network fetch impossible rather than unlikely.
    const text = await readFile(join(SRC, 'grammars.ts'), 'utf8');
    expect(text).toContain('bytes = await readFile(path)');
    expect(text).toContain('Language.load(bytes)');
  });

  it('declares no vector or embedding dependency', async () => {
    // ADR-0006 defers local vector search. `VectorIndex` is an interface and
    // nothing else, so a dependency here would mean the deferral is not real.
    const pkg = await packageJson();
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const vectorish = [
      'lancedb',
      '@lancedb/lancedb',
      'vectordb',
      'sqlite-vec',
      'better-sqlite3',
      'hnswlib-node',
      'faiss-node',
      '@xenova/transformers',
      'onnxruntime-node',
      'openai',
      '@huggingface/inference',
    ];
    expect(names.filter((name) => vectorish.includes(name))).toEqual([]);
  });

  it('implements no vector index, and says so where it would be', async () => {
    const text = await readFile(join(SRC, 'vectors.ts'), 'utf8');
    expect(text).toContain('interface only');
    expect(text).toContain('.adze/index');
    // No class or function claiming to be an implementation.
    expect(text).not.toMatch(/implements\s+VectorIndex/);
  });
});

describe('service packages do not import each other', () => {
  it('imports no other Adze package at all', async () => {
    // `protocol -> core -> sdk -> surfaces`, and service packages stay
    // individually swappable. Retrieval is reached through an interface, so it
    // needs nothing from core either.
    const offenders = (await importSpecifiers()).filter((entry) =>
      entry.specifier.startsWith('@adze/'),
    );
    expect(offenders).toEqual([]);
  });

  it('imports nothing from bench', async () => {
    const offenders = (await importSpecifiers()).filter(
      (entry) => entry.specifier.includes('bench/') || entry.specifier.startsWith('bench'),
    );
    expect(offenders).toEqual([]);
  });

  it('imports no surface package', async () => {
    const surfaces = ['@adze/cli', '@adze/vscode', '@adze/ide', '@adze/hub', '@adze/sdk'];
    const offenders = (await importSpecifiers()).filter((entry) =>
      surfaces.some((surface) => entry.specifier.startsWith(surface)),
    );
    expect(offenders).toEqual([]);
  });
});

describe('the package renders nothing', () => {
  it('emits no terminal escapes', async () => {
    for (const file of await sourceFiles(SRC)) {
      const text = await readFile(file, 'utf8');
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching an escape sequence is the point
      expect(text, file.slice(SRC.length + 1)).not.toMatch(/\u001B\[/);
    }
  });

  it('writes to no console or stream', async () => {
    // Diagnostics ride on the response. A service package that logs decides how a
    // surface presents a degradation, which is not its call to make.
    for (const file of await sourceFiles(SRC)) {
      const text = stripComments(await readFile(file, 'utf8'));
      const name = file.slice(SRC.length + 1);
      expect(text, name).not.toMatch(/\bconsole\.\w+\(/);
      expect(text, name).not.toMatch(/process\.std(out|err)\.write/);
    }
  });
});

describe('code conventions', () => {
  it('gives every relative import a .js extension', async () => {
    // `moduleResolution: nodenext` requires it, and an extensionless relative
    // import fails only at runtime, after the build has passed.
    const offenders = (await importSpecifiers()).filter(
      (entry) => entry.specifier.startsWith('.') && !entry.specifier.endsWith('.js'),
    );
    expect(offenders).toEqual([]);
  });

  it('uses no explicit any', async () => {
    for (const file of await sourceFiles(SRC)) {
      const text = stripComments(await readFile(file, 'utf8'));
      expect(text, file.slice(SRC.length + 1)).not.toMatch(/:\s*any\b/);
      expect(text, file.slice(SRC.length + 1)).not.toMatch(/\bas\s+any\b/);
    }
  });

  it('uses no non-null assertion in src', async () => {
    // `noUncheckedIndexedAccess` is on precisely so indexing is handled rather
    // than asserted away.
    for (const file of await sourceFiles(SRC)) {
      const text = stripComments(await readFile(file, 'utf8'));
      const name = file.slice(SRC.length + 1);
      for (const line of text.split('\n')) {
        // A non-null assertion is `x!` followed by `.`, `[`, `)`, `,`, `;`, or end.
        expect(line, `${name}: ${line.trim()}`).not.toMatch(/[\w\])]![.[)\],;]/);
      }
    }
  });

  it('references every dependency through the catalog', async () => {
    // One version per dependency across the workspace is what stops fifteen
    // packages drifting onto four versions of the same thing.
    const pkg = await packageJson();
    for (const [name, version] of Object.entries({
      ...pkg.dependencies,
      ...pkg.devDependencies,
    })) {
      expect(version, name).toBe('catalog:');
    }
  });

  it('is licensed Apache-2.0 and exports a built entry point', async () => {
    const pkg = await packageJson();
    expect(pkg.license).toBe('Apache-2.0');
    expect(JSON.stringify(pkg.exports)).toContain('./dist/index.js');
  });
});

describe('the tree-sitter runtime loads lazily', () => {
  it('imports web-tree-sitter dynamically, never at module scope', async () => {
    // On a fresh clone with no grammars the runtime WASM is never even read. A
    // static import would load it on the first `import '@adze/retrieval'`.
    const text = stripComments(await readFile(join(SRC, 'grammars.ts'), 'utf8'));
    expect(text).toContain("await import('web-tree-sitter')");
    // The invariant is precisely this: no *static value* import. `import type`
    // and `typeof import(...)` both erase at compile time and load nothing; a
    // mention inside a string is just a message.
    for (const line of text.split('\n')) {
      const staticValueImport =
        /^\s*(?:import|export)\s+(?!type\b)[^;]*from\s*['"]web-tree-sitter['"]/.exec(line);
      expect(staticValueImport, line.trim()).toBeNull();
    }
  });

  it('is the only file that mentions web-tree-sitter', async () => {
    // Symbol extraction reads a structural node shape instead, which is what
    // makes the tree-sitter code path testable with no grammar files present.
    for (const file of await sourceFiles(SRC)) {
      const name = file.slice(SRC.length + 1).replaceAll('\\', '/');
      if (name === 'grammars.ts') continue;
      const text = stripComments(await readFile(file, 'utf8'));
      expect(text, name).not.toContain('web-tree-sitter');
    }
  });

  it('depends on WASM rather than a native addon', async () => {
    // ADR-0002 chose web-tree-sitter specifically so nothing rebuilds across
    // Electron ABI x OS x arch.
    const pkg = await packageJson();
    const names = Object.keys(pkg.dependencies ?? {});
    expect(names).toContain('web-tree-sitter');
    expect(names).not.toContain('tree-sitter');
    expect(names.filter((n) => n.startsWith('tree-sitter-'))).toEqual([]);
  });
});

describe('honest degradation is structural', () => {
  it('has exactly one place that reports the extractor level', async () => {
    // Widening `heuristic` to `tree-sitter` must require editing one obvious
    // line, not one of several scattered assignments.
    const text = await readFile(join(SRC, 'symbols.ts'), 'utf8');
    const treeSitterClaims = (text.match(/extractor:\s*'tree-sitter'/g) ?? []).length;
    expect(treeSitterClaims).toBe(1);
  });

  it('never hard-codes a tree-sitter capability claim', async () => {
    const text = stripComments(await readFile(join(SRC, 'provider.ts'), 'utf8'));
    // The capability is answered by attempting a parse, so the only literal
    // `'tree-sitter'` is the value returned after one succeeded.
    expect(text).toContain("return 'tree-sitter'");
    expect(text).not.toMatch(/symbolExtractor:\s*'tree-sitter'/);
  });
});
