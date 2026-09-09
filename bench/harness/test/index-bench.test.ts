/**
 * Tests for `index-bench`: local retrieval measurements at small scale.
 *
 * What is pinned here is the honest subset: queries parse with locatable
 * errors, precision@k and matching mean what they say, the fixture digest is
 * stable for identical trees, and the suite runs end to end on the checked-in
 * fixture with every query matched — while the report states plainly that
 * latency is not comparable across machines and precision is a wiring signal
 * rather than a ranking benchmark.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderAuditMarkdown } from '../src/audit.js';
import {
  countFixtureFiles,
  fixtureDigest,
  matchedAtK,
  parseQueriesFile,
  precisionAtK,
  runIndexSuite,
} from '../src/index-bench.js';
import { renderConsoleSummary, renderReportMarkdown } from '../src/report.js';
import { checkReportPolicy } from '../src/report-policy.js';

const fixtureDir = join(import.meta.dirname, '..', '..', 'suites', 'index-bench', 'fixture');
const queriesPath = join(
  import.meta.dirname,
  '..',
  '..',
  'suites',
  'index-bench',
  'cases',
  'queries.json',
);

const scratchDirs: string[] = [];

afterAll(async () => {
  for (const dir of scratchDirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

describe('query file parsing', () => {
  it('rejects a file without a queries array', () => {
    expect(() => parseQueriesFile('[]', 'queries.json')).toThrow(/queries.*array/);
    expect(() => parseQueriesFile('not json', 'queries.json')).toThrow(/not valid JSON/);
  });

  it('rejects a query missing its id or text', () => {
    expect(() =>
      parseQueriesFile(JSON.stringify({ queries: [{ description: 'd' }] }), 'f.json'),
    ).toThrow(/'id' must be/);
  });

  it('rejects an empty expected-paths list', () => {
    expect(() =>
      parseQueriesFile(
        JSON.stringify({
          queries: [{ id: 'q', description: 'd', query: 'x', expectedPaths: [] }],
        }),
        'f.json',
      ),
    ).toThrow(/must not be empty/);
  });

  it('rejects duplicate query ids', () => {
    const text = JSON.stringify({
      queries: [
        { id: 'q', description: 'a', query: 'x', expectedPaths: ['a.ts'] },
        { id: 'q', description: 'b', query: 'y', expectedPaths: ['b.ts'] },
      ],
    });
    expect(() => parseQueriesFile(text, 'f.json')).toThrow(/duplicate query id/);
  });
});

describe('precision@k', () => {
  it('scores a unique hit at 1.0', () => {
    expect(precisionAtK(['a.ts'], ['a.ts'], 5)).toBe(1);
    expect(matchedAtK(['a.ts'], ['a.ts'], 5)).toBe(true);
  });

  it('scores a miss at 0.0', () => {
    expect(precisionAtK(['a.ts'], ['b.ts'], 5)).toBe(0);
    expect(matchedAtK(['a.ts'], ['b.ts'], 5)).toBe(false);
  });

  it('scores a partial top-k honestly', () => {
    expect(precisionAtK(['a.ts', 'b.ts'], ['a.ts', 'c.ts'], 2)).toBe(0.5);
    expect(matchedAtK(['a.ts', 'b.ts'], ['a.ts', 'c.ts'], 2)).toBe(true);
  });

  it('ignores hits below k', () => {
    expect(matchedAtK(['a.ts'], ['b.ts', 'c.ts', 'a.ts'], 2)).toBe(false);
    expect(matchedAtK(['a.ts'], ['b.ts', 'c.ts', 'a.ts'], 3)).toBe(true);
  });

  it('scores no results as a miss rather than as zero over zero', () => {
    expect(precisionAtK(['a.ts'], [], 5)).toBe(0);
    expect(matchedAtK(['a.ts'], [], 5)).toBe(false);
  });
});

describe('fixture digest', () => {
  it('is stable for the committed tree', async () => {
    const first = await fixtureDigest(fixtureDir);
    const second = await fixtureDigest(fixtureDir);
    expect(second.digest).toBe(first.digest);
    expect(first.files).toBeGreaterThanOrEqual(8);
    expect(first.bytes).toBeGreaterThan(0);
    expect(await countFixtureFiles(fixtureDir)).toBe(first.files);
  });

  it('changes when a file changes', async () => {
    const before = await fixtureDigest(fixtureDir);
    const dir = await mkdtemp(join(tmpdir(), 'adze-digest-'));
    scratchDirs.push(dir);
    const { cpSync } = await import('node:fs');
    cpSync(fixtureDir, dir, { recursive: true });
    await writeFile(join(dir, 'src', 'auth.ts'), '// touched\n', { flag: 'a' });
    const after = await fixtureDigest(dir);
    expect(after.digest).not.toBe(before.digest);
    expect(after.files).toBe(before.files);
  });
});

describe('the committed index-bench suite', () => {
  it('runs end to end with every query matched', async () => {
    const { readFile } = await import('node:fs/promises');
    const queries = parseQueriesFile(await readFile(queriesPath, 'utf8'), 'queries.json');
    expect(queries.length).toBeGreaterThanOrEqual(6);

    const { report, trajectories } = await runIndexSuite(queries, {
      fixtureDir,
      invocation: 'vitest',
    });

    expect(report.suite).toBe('index-bench');
    expect(report.inputSource).toBe('synthetic');
    expect(trajectories.length).toBe(queries.length);
    expect(report.results.filter((r) => r.outcome !== 'pass')).toEqual([]);
    expect(report.totals.passRate).toBe(1);
    expect(report.severeFailures).toEqual([]);
  }, 60_000);

  it('records metrics, digest, and the resource band', async () => {
    const { readFile } = await import('node:fs/promises');
    const queries = parseQueriesFile(await readFile(queriesPath, 'utf8'), 'queries.json');
    const { report } = await runIndexSuite(queries, { fixtureDir, invocation: 'vitest' });

    expect(report.metrics).toBeDefined();
    expect(report.metrics?.meanPrecisionAtK).toBe(1);
    expect(report.metrics?.coldIndexMs).toBeGreaterThanOrEqual(0);
    expect(report.fixture?.files).toBeGreaterThanOrEqual(8);
    expect(report.fixture?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(report.resourceBand).toContain('small-scale local');
    // Retrieval results record no applier telemetry rather than zeros.
    expect(Object.keys(report.byTier)).toEqual([]);
    expect(report.results.every((r) => r.actual === undefined)).toBe(true);
  }, 60_000);

  it('states non-comparability and the wiring-signal limit before any number', async () => {
    const { readFile } = await import('node:fs/promises');
    const queries = parseQueriesFile(await readFile(queriesPath, 'utf8'), 'queries.json');
    const { report } = await runIndexSuite(queries, { fixtureDir, invocation: 'vitest' });
    const markdown = renderReportMarkdown(report);

    expect(markdown).toContain('not comparable across machines');
    expect(markdown).toContain('wiring signal, not a ranking benchmark');
    expect(markdown).toContain('## Index measurements');
    expect(markdown.indexOf('## Limitations')).toBeLessThan(markdown.search(/\d+\.\d%/));
  }, 60_000);

  it('passes the publication gate', async () => {
    const { readFile } = await import('node:fs/promises');
    const queries = parseQueriesFile(await readFile(queriesPath, 'utf8'), 'queries.json');
    const { report } = await runIndexSuite(queries, { fixtureDir, invocation: 'vitest' });
    expect(checkReportPolicy(report).ok).toBe(true);
  }, 60_000);

  it('names the fixture and the band in the audit', async () => {
    const { readFile } = await import('node:fs/promises');
    const queries = parseQueriesFile(await readFile(queriesPath, 'utf8'), 'queries.json');
    const { report } = await runIndexSuite(queries, { fixtureDir, invocation: 'vitest' });
    const audit = renderAuditMarkdown(report);
    expect(audit).toContain('Fixture digest');
    expect(audit).toContain('Resource band');
  }, 60_000);

  it('prints precision and latency in the console summary', async () => {
    const { readFile } = await import('node:fs/promises');
    const queries = parseQueriesFile(await readFile(queriesPath, 'utf8'), 'queries.json');
    const { report } = await runIndexSuite(queries, { fixtureDir, invocation: 'vitest' });
    expect(renderConsoleSummary(report)).toContain('precision@k');
  }, 60_000);
});
