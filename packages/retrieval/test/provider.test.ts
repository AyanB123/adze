/**
 * End-to-end provider tests.
 *
 * This is where the ADR's ordering claim becomes checkable: a hybrid search runs
 * ripgrep and symbol lookup over a real temp repository, fuses them, and reports
 * which signals ran. Every assertion below is either about a bound, a
 * degradation, or the honesty of a report.
 *
 * The degradation tests deliberately do not need ripgrep or grammars, because
 * those are the paths a fresh clone actually takes.
 */

import { describe, expect, it } from 'vitest';
import { LocalRetrievalProvider } from '../src/provider.js';
import { resolveRipgrepPath } from '../src/ripgrep.js';
import type { VectorHit, VectorIndex, VectorQuery } from '../src/types.js';
import { createFixture } from './fixture.js';

const rg = await resolveRipgrepPath();
const withRg = rg.ok ? it : it.skip;

/**
 * A workspace with a little of everything: two languages, a nested directory, an
 * ignored directory, and a symbol that also appears as prose.
 */
const REPO: Readonly<Record<string, string>> = {
  '.gitignore': 'ignored/\n',
  'src/retry.ts': [
    'import { sleep } from "./sleep.js";',
    '',
    'export const RETRY_LIMIT = 5;',
    '',
    'export async function retryWithBackoff(attempts: number): Promise<void> {',
    '  for (let i = 0; i < attempts; i++) {',
    '    await sleep(2 ** i);',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/user.ts': [
    'export class UserService {',
    '  findUser(id: string): string {',
    '    return id;',
    '  }',
    '',
    '  retryWithBackoff(): void {}',
    '}',
    '',
  ].join('\n'),
  'src/deep/nested.py': [
    'class UserService:',
    '    def find_user(self, id):',
    '        return id',
    '',
  ].join('\n'),
  'docs/notes.md': 'We should document retryWithBackoff at some point.\n',
  'ignored/copy.ts': 'export function retryWithBackoff(): void {}\n',
};

function provider(root: string, overrides = {}): LocalRetrievalProvider {
  // Grammars are explicitly off in most tests so the assertions describe the
  // fresh-clone path rather than whatever happens to be installed.
  return new LocalRetrievalProvider({ root, grammars: null, ...overrides });
}

describe('LocalRetrievalProvider — capabilities are evidence, not configuration', () => {
  it('reports the extractor level it can actually reach', async () => {
    const fixture = await createFixture(REPO);
    try {
      const capabilities = await provider(fixture.root).capabilities();
      expect(capabilities.lexical).toBe(rg.ok);
      // Some level is always available, because the heuristic scanner needs nothing.
      expect(capabilities.symbols).toBe(true);
      // Grammars are off here, so claiming tree-sitter would be the exact lie
      // ValidationResult.validator exists to prevent.
      expect(capabilities.symbolExtractor).toBe('heuristic');
      expect(capabilities.notes.join(' ')).toContain('heuristic scanner');
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not claim tree-sitter merely because a grammar directory is configured', async () => {
    const fixture = await createFixture(REPO);
    try {
      const configured = new LocalRetrievalProvider({
        root: fixture.root,
        grammarOptions: { directory: `${fixture.root}/no-grammars-here` },
      });
      const capabilities = await configured.capabilities();
      expect(capabilities.symbolExtractor).toBe('heuristic');
      expect(capabilities.notes.join(' ')).toContain('no tree-sitter grammar loaded');
      await configured.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports semantic as unavailable, and says it is unimplemented', async () => {
    const fixture = await createFixture(REPO);
    try {
      const capabilities = await provider(fixture.root).capabilities();
      expect(capabilities.semantic).toBe(false);
      expect(capabilities.notes.join(' ')).toContain('not implemented');
    } finally {
      await fixture.cleanup();
    }
  });

  it('distinguishes "no vector index" from "index not built"', async () => {
    const fixture = await createFixture(REPO);
    const unbuilt: VectorIndex = {
      name: 'stub',
      isIndexed: async () => await Promise.resolve(false),
      query: async (_: VectorQuery): Promise<readonly VectorHit[]> => await Promise.resolve([]),
    };
    try {
      const capabilities = await provider(fixture.root, { vectorIndex: unbuilt }).capabilities();
      expect(capabilities.semantic).toBe(false);
      expect(capabilities.notes.join(' ')).toContain('has not been indexed');
      expect(capabilities.notes.join(' ')).not.toContain('not implemented in this milestone');
    } finally {
      await fixture.cleanup();
    }
  });

  it('survives a vector index that throws while reporting its state', async () => {
    const fixture = await createFixture(REPO);
    const broken: VectorIndex = {
      name: 'broken',
      isIndexed: async () => {
        await Promise.resolve();
        throw new Error('index file corrupt');
      },
      query: async (): Promise<readonly VectorHit[]> => await Promise.resolve([]),
    };
    try {
      const capabilities = await provider(fixture.root, { vectorIndex: broken }).capabilities();
      expect(capabilities.semantic).toBe(false);
      expect(capabilities.notes.join(' ')).toContain('index file corrupt');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('LocalRetrievalProvider — hybrid search', () => {
  withRg('runs lexical and symbol signals and names both', async () => {
    const fixture = await createFixture(REPO, { initGit: true });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.search({ query: 'retryWithBackoff' });
      expect(response.signalsUsed).toContain('lexical');
      expect(response.signalsUsed).toContain('symbol');
      // Never the signal that did not run.
      expect(response.signalsUsed).not.toContain('semantic');
      expect(response.results.length).toBeGreaterThan(0);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('gives every result a full score breakdown', async () => {
    const fixture = await createFixture(REPO, { initGit: true });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.search({ query: 'retryWithBackoff' });
      for (const result of response.results) {
        expect(Object.keys(result.signals.ranks).length).toBeGreaterThan(0);
        let sum = 0;
        for (const value of Object.values(result.signals.contributions)) sum += value;
        expect(result.signals.fusion).toBeCloseTo(sum);
        expect(result.score).toBeGreaterThan(0);
        expect(result.path).not.toContain('\\');
        expect(result.path).not.toMatch(/^\.\//);
      }
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('ranks the declaration above a prose mention of the same name', async () => {
    const fixture = await createFixture(REPO, { initGit: true });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.search({ query: 'retryWithBackoff' });
      const declaration = response.results.findIndex(
        (r) => r.path === 'src/retry.ts' && r.line === 5,
      );
      const prose = response.results.findIndex((r) => r.path === 'docs/notes.md');
      expect(declaration).toBeGreaterThanOrEqual(0);
      // The symbol signal agrees with the lexical one on the declaration, and
      // nothing agrees about the markdown file.
      if (prose >= 0) expect(declaration).toBeLessThan(prose);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('attaches symbol metadata where the symbol signal contributed', async () => {
    const fixture = await createFixture(REPO, { initGit: true });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.search({ query: 'UserService', mode: 'symbol' });
      const hit = response.results.find((r) => r.path === 'src/user.ts');
      expect(hit?.symbol?.name).toBe('UserService');
      expect(hit?.symbol?.kind).toBe('class');
      expect(response.signalsUsed).toEqual(['symbol']);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('respects .gitignore, so an ignored copy never surfaces', async () => {
    const fixture = await createFixture(REPO, { initGit: true });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.search({ query: 'retryWithBackoff' });
      expect(response.results.map((r) => r.path)).not.toContain('ignored/copy.ts');
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('applies include and exclude globs to both signals', async () => {
    const fixture = await createFixture(REPO, { initGit: true });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.search({
        query: 'retryWithBackoff',
        include: ['*.md'],
      });
      expect(response.results.every((r) => r.path.endsWith('.md'))).toBe(true);

      const excluded = await retrieval.search({
        query: 'retryWithBackoff',
        exclude: ['docs/**'],
      });
      expect(excluded.results.some((r) => r.path.startsWith('docs/'))).toBe(false);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('treats a literal query as text in literal mode', async () => {
    const fixture = await createFixture({ 'a.ts': 'const x = a.b;\nconst y = axb;\n' });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.search({ query: 'a.b', mode: 'literal' });
      expect(response.results).toHaveLength(1);
      expect(response.results[0]?.line).toBe(1);
      expect(response.signalsUsed).toEqual(['lexical']);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('applies a regex in regex mode', async () => {
    const fixture = await createFixture({ 'a.ts': 'const x = 1;\nlet y = 2;\n' });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.search({
        query: String.raw`^(const|let)\s`,
        mode: 'regex',
      });
      expect(response.results).toHaveLength(2);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('captures context lines when asked', async () => {
    const fixture = await createFixture({ 'a.ts': 'one\ntwo\nneedle\nfour\nfive\n' });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.search({
        query: 'needle',
        mode: 'literal',
        contextLines: 2,
      });
      expect(response.results[0]?.before).toEqual(['one', 'two']);
      expect(response.results[0]?.after).toEqual(['four', 'five']);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('omits context fields entirely when none was requested', async () => {
    const fixture = await createFixture({ 'a.ts': 'needle\n' });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.search({ query: 'needle', mode: 'literal' });
      expect('before' in (response.results[0] ?? {})).toBe(false);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('boosts a result in the same directory as the open file', async () => {
    const fixture = await createFixture({
      'far/away.ts': 'const needle = 1;\n',
      'near/here.ts': 'const needle = 2;\n',
    });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.search({
        query: 'needle',
        mode: 'literal',
        openFile: 'near/open.ts',
      });
      expect(response.results[0]?.path).toBe('near/here.ts');
      expect(response.results[0]?.signals.proximity).toBeGreaterThan(0);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('echoes the ranking parameters actually applied', async () => {
    const fixture = await createFixture({ 'a.ts': 'needle\n' });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.search({
        query: 'needle',
        mode: 'literal',
        ranking: { k: 7, weights: { lexical: 2 } },
      });
      expect(response.ranking.k).toBe(7);
      expect(response.ranking.weights.lexical).toBe(2);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('reports a duration', async () => {
    const fixture = await createFixture({ 'a.ts': 'needle\n' });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.search({ query: 'needle', mode: 'literal' });
      expect(response.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });
});

describe('LocalRetrievalProvider — bounds are marked', () => {
  withRg('caps results and says the cap is why', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `const needle${i} = ${i};`).join('\n');
    const fixture = await createFixture({ 'big.ts': `${lines}\n` });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.search({
        query: 'needle',
        mode: 'literal',
        maxResults: 5,
      });
      // An unbounded result set is a denial-of-service on a model's context, and
      // an unmarked truncation reads as a complete answer.
      expect(response.results).toHaveLength(5);
      expect(response.truncated).toBe(true);
      expect(response.truncationReason).toBe('max-results');
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('does not mark truncation when everything fitted', async () => {
    const fixture = await createFixture({ 'a.ts': 'needle\n' });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.search({
        query: 'needle',
        mode: 'literal',
        maxResults: 100,
      });
      expect(response.truncated).toBe(false);
      expect(response.truncationReason).toBeUndefined();
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('bounds the number of files it will parse', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      files[`src/f${i}.ts`] =
        `export function target${i}(): void {}\nexport function target(): void {}\n`;
    }
    const fixture = await createFixture(files);
    const retrieval = new LocalRetrievalProvider({
      root: fixture.root,
      grammars: null,
      maxFilesParsed: 4,
    });
    try {
      const response = await retrieval.definitions({ name: 'target' });
      expect(response.filesParsed).toBeLessThanOrEqual(4);
      expect(response.truncated).toBe(true);
      expect(response.truncationReason).toBe('max-files');
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg(
    'returns bounded results under a tiny time budget',
    async () => {
      const lines = Array.from({ length: 3000 }, (_, i) => `const needle${i} = ${i};`).join('\n');
      const files: Record<string, string> = {};
      for (let i = 0; i < 20; i++) files[`src/f${i}.ts`] = `${lines}\n`;
      const fixture = await createFixture(files);
      const retrieval = provider(fixture.root);
      try {
        const startedAt = Date.now();
        const response = await retrieval.search({ query: 'needle', timeoutMs: 20 });
        // Boundedness is the assertion. The reason is marked whenever it was cut.
        expect(Date.now() - startedAt).toBeLessThan(15_000);
        if (response.truncated) {
          expect(['timeout', 'max-results', 'max-files']).toContain(response.truncationReason);
        }
      } finally {
        await retrieval.dispose();
        await fixture.cleanup();
      }
    },
    30_000,
  );

  withRg('skips a file larger than the read ceiling', async () => {
    const fixture = await createFixture({
      'small.ts': 'export function target(): void {}\n',
      'huge.ts': `export function target(): void {}\n// ${'x'.repeat(5000)}\n`,
    });
    const retrieval = new LocalRetrievalProvider({
      root: fixture.root,
      grammars: null,
      maxFileBytes: 200,
    });
    try {
      const response = await retrieval.definitions({ name: 'target' });
      expect(response.hits.map((h) => h.path)).toEqual(['small.ts']);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });
});

describe('LocalRetrievalProvider — definitions', () => {
  withRg('finds a definition and reports which extractor found it', async () => {
    const fixture = await createFixture(REPO, { initGit: true });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.definitions({ name: 'UserService' });
      const paths = response.hits.map((h) => h.path);
      expect(paths).toContain('src/user.ts');
      expect(paths).toContain('src/deep/nested.py');
      for (const hit of response.hits) expect(hit.extractor).toBe('heuristic');
      // The histogram is a claim about evidence: how many files each level handled.
      expect(response.extractors.heuristic).toBeGreaterThan(0);
      expect(response.extractors['tree-sitter']).toBeUndefined();
      expect(response.filesParsed).toBeGreaterThan(0);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('matches exactly, never fuzzily', async () => {
    const fixture = await createFixture({
      'a.ts': 'export class UserService {}\nexport class UserServiceFactory {}\n',
    });
    const retrieval = provider(fixture.root);
    try {
      const exact = await retrieval.definitions({ name: 'UserService' });
      expect(exact.hits.map((h) => h.symbol.name)).toEqual(['UserService']);

      // A model told that a typo is defined somewhere plausible will act on it.
      const typo = await retrieval.definitions({ name: 'UserServcie' });
      expect(typo.hits).toHaveLength(0);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('filters by kind when asked', async () => {
    const fixture = await createFixture({
      'a.ts': 'export class Thing {}\n',
      'b.ts': 'export interface Thing { x: number }\n',
    });
    const retrieval = provider(fixture.root);
    try {
      const classes = await retrieval.definitions({ name: 'Thing', kinds: ['class'] });
      expect(classes.hits.map((h) => h.path)).toEqual(['a.ts']);

      const interfaces = await retrieval.definitions({ name: 'Thing', kinds: ['interface'] });
      expect(interfaces.hits.map((h) => h.path)).toEqual(['b.ts']);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('orders hits by path then line, so a run is reproducible', async () => {
    const fixture = await createFixture({
      'b.ts': 'export function target(): void {}\n',
      'a.ts': 'export function other(): void {}\nexport function target(): void {}\n',
    });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.definitions({ name: 'target' });
      expect(response.hits.map((h) => h.path)).toEqual(['a.ts', 'b.ts']);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('caps hits and marks the cap', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`f${i}.ts`] = 'export function target(): void {}\n';
    const fixture = await createFixture(files);
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.definitions({ name: 'target', maxResults: 3 });
      expect(response.hits).toHaveLength(3);
      expect(response.truncated).toBe(true);
      expect(response.truncationReason).toBe('max-results');
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('returns an empty, untruncated result for a name that does not exist', async () => {
    const fixture = await createFixture(REPO, { initGit: true });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.definitions({ name: 'NoSuchSymbolAnywhere' });
      expect(response.hits).toHaveLength(0);
      expect(response.truncated).toBe(false);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('carries the declaration line as the snippet', async () => {
    const fixture = await createFixture({ 'a.ts': '\n\nexport class Thing {}\n' });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.definitions({ name: 'Thing' });
      expect(response.hits[0]?.snippet).toBe('export class Thing {}');
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });
});

describe('LocalRetrievalProvider — degrades rather than throwing', () => {
  it('reports a broken ripgrep as an error diagnostic and still returns', async () => {
    const fixture = await createFixture(REPO);
    const retrieval = provider(fixture.root);
    try {
      // A root that does not exist makes the spawn fail, which is the same shape
      // as a missing binary from this layer's point of view.
      const response = await retrieval.search({
        query: 'retryWithBackoff',
        root: `${fixture.root}/does-not-exist`,
      });
      expect(response.results).toHaveLength(0);
      const lexical = response.diagnostics.filter((d) => d.source === 'lexical');
      expect(lexical.length).toBeGreaterThan(0);
      // "Unknown" is not the same as "absent", and a model must be told which.
      expect(lexical.map((d) => d.message).join(' ')).toContain('unknown rather than absent');
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  it('never throws for an empty query, and says the query was empty', async () => {
    const fixture = await createFixture(REPO);
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.search({ query: '' });
      expect(response.results).toHaveLength(0);
      expect(response.signalsUsed).toHaveLength(0);
      expect(response.diagnostics.map((d) => d.message).join(' ')).toContain('empty');
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('reports a bad regex as a diagnostic rather than raising', async () => {
    const fixture = await createFixture({ 'a.ts': 'x\n' });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.search({ query: '(unclosed', mode: 'regex' });
      expect(response.results).toHaveLength(0);
      const lexical = response.diagnostics.filter((d) => d.source === 'lexical');
      expect(lexical.some((d) => d.level === 'error')).toBe(true);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('reports why symbols came from the heuristic scanner', async () => {
    const fixture = await createFixture(REPO, { initGit: true });
    const retrieval = new LocalRetrievalProvider({
      root: fixture.root,
      grammarOptions: { directory: `${fixture.root}/no-grammars` },
    });
    try {
      const response = await retrieval.definitions({ name: 'UserService' });
      // Symbols were still found — degrading must not mean returning nothing.
      expect(response.hits.length).toBeGreaterThan(0);
      expect(response.extractors.heuristic).toBeGreaterThan(0);
      const notes = response.diagnostics.filter((d) => d.source === 'symbol');
      expect(notes.map((d) => d.message).join(' ')).toContain('no grammar');
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('treats a query full of shell metacharacters as data', async () => {
    const fixture = await createFixture({
      'a.ts': 'const x = "$(rm -rf /)";\n',
      'keep.ts': 'const keep = 1;\n',
    });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.search({ query: '$(rm -rf /)', mode: 'literal' });
      // It matched as text, and both files still exist.
      expect(response.results.map((r) => r.path)).toEqual(['a.ts']);
      const files = await retrieval.listFiles();
      expect([...files.files].sort()).toEqual(['a.ts', 'keep.ts']);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  it('explains the missing semantic signal only when it was asked for', async () => {
    const fixture = await createFixture(REPO);
    const retrieval = provider(fixture.root);
    try {
      const explicit = await retrieval.search({ query: 'anything', mode: 'semantic' });
      expect(explicit.diagnostics.some((d) => d.source === 'semantic')).toBe(true);
      expect(explicit.signalsUsed).toHaveLength(0);

      // A hybrid query stays quiet: "semantic is off by default" is the design,
      // not a degradation to warn about on every single search.
      const hybrid = await retrieval.search({ query: 'anything' });
      expect(hybrid.diagnostics.some((d) => d.source === 'semantic')).toBe(false);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  it('says a configured-but-unbuilt index is unbuilt, not unimplemented', async () => {
    const fixture = await createFixture(REPO);
    const unbuilt: VectorIndex = {
      name: 'stub',
      isIndexed: async () => await Promise.resolve(false),
      query: async (): Promise<readonly VectorHit[]> => await Promise.resolve([]),
    };
    const retrieval = provider(fixture.root, { vectorIndex: unbuilt });
    try {
      const response = await retrieval.search({ query: 'anything', mode: 'semantic' });
      const semantic = response.diagnostics.filter((d) => d.source === 'semantic');
      expect(semantic.map((d) => d.message).join(' ')).toContain('has not been indexed');
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  it('does not pretend to fuse hits from an index that reports itself built', async () => {
    const fixture = await createFixture(REPO);
    const built: VectorIndex = {
      name: 'stub',
      isIndexed: async () => await Promise.resolve(true),
      query: async (): Promise<readonly VectorHit[]> =>
        await Promise.resolve([
          { path: 'src/retry.ts', startLine: 1, endLine: 2, snippet: 'x', score: 0.9 },
        ]),
    };
    const retrieval = provider(fixture.root, { vectorIndex: built });
    try {
      const response = await retrieval.search({ query: 'anything', mode: 'semantic' });
      // ADR-0006 defers fusing semantic hits. Saying so is better than silently
      // ignoring a supplied index, and far better than claiming it worked.
      expect(response.signalsUsed).not.toContain('semantic');
      expect(response.diagnostics.map((d) => d.message).join(' ')).toContain(
        'not implemented in this milestone',
      );
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  it('falls back to a directory walk for listFiles when ripgrep cannot run', async () => {
    const fixture = await createFixture({ 'a.ts': 'x\n' });
    const retrieval = provider(fixture.root);
    try {
      const files = await retrieval.listFiles({ root: `${fixture.root}/nope` });
      expect(files.files).toHaveLength(0);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  it('can be disposed twice', async () => {
    const fixture = await createFixture({ 'a.ts': 'x\n' });
    const retrieval = provider(fixture.root);
    try {
      await retrieval.dispose();
      await retrieval.dispose();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('LocalRetrievalProvider — cheapest signal first', () => {
  withRg('bounds parse cost with a lexical prefilter rather than by repository size', async () => {
    // 60 files exist; only one contains the name. The symbol signal must parse
    // roughly the one, not the sixty. This is the whole reason the prefilter is
    // there, and the reason ADR-0006 puts ripgrep first.
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++) files[`src/noise${i}.ts`] = `export const filler${i} = ${i};\n`;
    files['src/target.ts'] = 'export class VeryDistinctName {}\n';
    const fixture = await createFixture(files);
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.definitions({ name: 'VeryDistinctName' });
      expect(response.hits.map((h) => h.path)).toEqual(['src/target.ts']);
      expect(response.filesParsed).toBeLessThanOrEqual(2);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });

  withRg('does not let a short name drag in every longer name', async () => {
    const fixture = await createFixture({
      'a.ts': 'export function get(): void {}\n',
      'b.ts': 'export function getUser(): void {}\nexport function getThing(): void {}\n',
    });
    const retrieval = provider(fixture.root);
    try {
      const response = await retrieval.definitions({ name: 'get' });
      expect(response.hits.map((h) => h.path)).toEqual(['a.ts']);
    } finally {
      await retrieval.dispose();
      await fixture.cleanup();
    }
  });
});
