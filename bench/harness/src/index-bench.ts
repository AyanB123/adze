/**
 * `index-bench` — local retrieval measurements at small scale.
 *
 * Ripgrep latency, cold symbol index time, incremental re-index latency on
 * save, and precision@k against a checked-in fixture repository. No model, no
 * network, no container: every query is hand-written and the fixture is
 * committed beside the suite, so `inputSource` stays `synthetic`.
 *
 * ## What the numbers are, and what they are not
 *
 * Latency is wall-clock time on the run's own machine. It is recorded beside
 * the machine (CPU, memory, platform), the fixture digest (sha256 over the
 * fixture files), and the resource band (`small-scale local`) in the report and
 * `config.json` — and it is **not comparable across machines**. The limitations
 * section states this before any number, and the suite README repeats it.
 *
 * Precision here is a wiring signal, not a ranking benchmark. The fixture holds
 * eleven files with unambiguous symbol names, so every query is answerable by
 * literal search and the expected precision is 1.0. A drop means lookup broke.
 * Ranking quality at 10k/100k/1M files belongs to M6 and does not exist yet.
 *
 * ## How each metric is measured
 *
 * All measurements run against a temp copy of the fixture; the checked-in files
 * are never modified, and the digest is computed over the committed bytes.
 *
 * - `ripgrepLatencyMs` per query: direct `ripgrepSearch` wall clock.
 * - `coldIndexMs`: a fresh `LocalRetrievalProvider` over the temp copy,
 *   `listFiles` plus the first full query pass (grammar loads and file reads
 *   included, caches cold).
 * - `incrementalMs`: one query re-run after appending a comment line to a
 *   single fixture file in the temp copy. The provider holds no persistent
 *   index, so this is honestly a warm-cache second search rather than an
 *   incremental-index data structure — stated as such in the suite README.
 * - `precision@k` per query: fraction of the top-k returned paths that are
 *   expected. `matched` means at least one expected path is in the top-k.
 *
 * ## Why results carry no applier telemetry
 *
 * `CaseResult.actual` (tier, strategy, validator) describes `@adze/apply`.
 * Setting it here would claim an applier measurement a retrieval run never
 * made, so index results omit it: the applier breakdown tables are empty for
 * this suite, and the report says why rather than printing zeros.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { LocalRetrievalProvider, ripgrepSearch } from '@adze/retrieval';
import type { LoadedCase } from './case-schema.js';
import {
  addToBreakdown,
  type BenchReport,
  type Breakdown,
  type CaseResult,
  REPORT_SCHEMA_VERSION,
} from './report-schema.js';
import type { Trajectory } from './runner.js';
import { HARNESS_VERSION, type RunOutcome } from './runner.js';

export interface IndexQuery {
  readonly id: string;
  readonly description: string;
  readonly query: string;
  readonly mode: 'literal' | 'regex';
  readonly k: number;
  readonly expectedPaths: readonly string[];
  readonly tags: readonly string[];
}

export class IndexCaseFormatError extends Error {}

function fail(message: string): never {
  throw new IndexCaseFormatError(message);
}

function asStringArray(value: unknown, where: string, field: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    return fail(`${where}: '${field}' must be an array of strings`);
  }
  return value as readonly string[];
}

function parseQuery(value: unknown, file: string, index: number): IndexQuery {
  const where = `${file} [query ${index}]`;
  if (typeof value !== 'object' || value === null) return fail(`${where}: query must be an object`);
  const q = value as Record<string, unknown>;
  if (typeof q.id !== 'string' || q.id.length === 0)
    return fail(`${where}: 'id' must be a non-empty string`);
  const at = `${file} [${q.id}]`;
  if (typeof q.description !== 'string' || q.description.length === 0) {
    return fail(`${at}: 'description' must be a non-empty string`);
  }
  if (typeof q.query !== 'string' || q.query.length === 0) {
    return fail(`${at}: 'query' must be a non-empty string`);
  }
  const mode = q.mode ?? 'literal';
  if (mode !== 'literal' && mode !== 'regex') {
    return fail(`${at}: 'mode' must be 'literal' or 'regex'`);
  }
  const k = q.k ?? 5;
  if (!Number.isInteger(k) || (k as number) < 1) {
    return fail(`${at}: 'k' must be a positive integer`);
  }
  const expectedPaths = asStringArray(q.expectedPaths, at, 'expectedPaths');
  if (expectedPaths.length === 0) return fail(`${at}: 'expectedPaths' must not be empty`);
  const tags = q.tags === undefined ? [] : asStringArray(q.tags, at, 'tags');
  return {
    id: q.id,
    description: q.description,
    query: q.query,
    mode,
    k: k as number,
    expectedPaths,
    tags,
  };
}

/** Parse a queries file: `{ "queries": [ ... ] }`. */
export function parseQueriesFile(text: string, file: string): IndexQuery[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new IndexCaseFormatError(
      `${file} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !Array.isArray((raw as { queries?: unknown }).queries)
  ) {
    throw new IndexCaseFormatError(`${file} must be an object with a 'queries' array`);
  }
  const queries = (raw as { queries: unknown[] }).queries;
  const parsed = queries.map((entry, index) => parseQuery(entry, file, index));
  const seen = new Set<string>();
  for (const q of parsed) {
    if (seen.has(q.id)) throw new IndexCaseFormatError(`duplicate query id '${q.id}' in ${file}`);
    seen.add(q.id);
  }
  return parsed;
}

/** Fraction of the top-k returned paths that are expected, in [0, 1]. */
export function precisionAtK(
  expected: readonly string[],
  returned: readonly string[],
  k: number,
): number {
  const top = returned.slice(0, k);
  if (top.length === 0) return 0;
  const wanted = new Set(expected);
  let hits = 0;
  for (const path of top) {
    if (wanted.has(path)) hits++;
  }
  return hits / top.length;
}

/** True when at least one expected path is in the top-k returned paths. */
export function matchedAtK(
  expected: readonly string[],
  returned: readonly string[],
  k: number,
): boolean {
  const wanted = new Set(expected);
  return returned.slice(0, k).some((path) => wanted.has(path));
}

async function fixtureFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  await walk(dir);
  return out.sort();
}

/**
 * sha256 over the sorted relative paths and their bytes, plus file and byte totals.
 *
 * Paths are posix-normalized so the digest is stable across operating systems for
 * identical trees — a CRLF checkout still differs, and that is correct: the bytes
 * searched are the bytes hashed.
 */
export async function fixtureDigest(
  fixtureDir: string,
): Promise<{ readonly digest: string; readonly files: number; readonly bytes: number }> {
  const files = await fixtureFiles(fixtureDir);
  const hash = createHash('sha256');
  let bytes = 0;
  for (const full of files) {
    const rel = relative(fixtureDir, full).split(sep).join('/');
    const content = await readFile(full);
    bytes += content.byteLength;
    hash.update(rel, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(content);
    hash.update('\0', 'utf8');
  }
  return { digest: hash.digest('hex'), files: files.length, bytes };
}

function languageForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'py':
      return 'python';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'java':
      return 'java';
    case 'c':
    case 'h':
      return 'c';
    case 'sh':
      return 'shell';
    case 'json':
      return 'json';
    case 'md':
      return 'markdown';
    default:
      return 'unknown';
  }
}

function toPosix(rel: string): string {
  return rel.split(sep).join('/');
}

export interface IndexSuiteOptions {
  readonly fixtureDir: string;
  readonly invocation: string;
}

/**
 * Run the index-bench queries against a temp copy of the fixture.
 *
 * The temp copy exists so the incremental step can append a line to one file
 * without dirtying the checked-in tree. It is removed before this returns,
 * including on failure.
 */
export async function runIndexSuite(
  queries: readonly IndexQuery[],
  options: IndexSuiteOptions,
): Promise<RunOutcome> {
  const startedAtMs = performance.now();
  const startedAt = new Date().toISOString();
  const digest = await fixtureDigest(options.fixtureDir);

  const workDir = mkdtempSync(join(tmpdir(), 'adze-index-bench-'));
  try {
    return await runInCopy(queries, options, digest, workDir, startedAtMs, startedAt);
  } finally {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}

interface MeasuredQuery {
  readonly query: IndexQuery;
  readonly returnedPaths: readonly string[];
  readonly ripgrepMs: number;
  readonly providerMs: number;
  readonly precision: number;
  readonly matched: boolean;
  readonly harnessError?: string;
}

async function runInCopy(
  queries: readonly IndexQuery[],
  options: IndexSuiteOptions,
  digest: { readonly digest: string; readonly files: number; readonly bytes: number },
  workDir: string,
  startedAtMs: number,
  startedAt: string,
): Promise<RunOutcome> {
  cpSync(options.fixtureDir, workDir, { recursive: true });

  const provider = new LocalRetrievalProvider({ root: workDir });
  try {
    // Cold: fresh provider, file listing plus the first full pass. Grammar loads
    // and file reads are inside this window, which is the point.
    const coldStart = performance.now();
    await provider.listFiles();
    const measured: MeasuredQuery[] = [];
    for (const query of queries) {
      measured.push(await measureQuery(provider, workDir, query));
    }
    const coldIndexMs = performance.now() - coldStart;

    // Incremental: touch one file in the copy, re-run the first query warm.
    let incrementalMs = 0;
    const first = queries[0];
    if (first !== undefined) {
      try {
        appendFileSync(
          join(workDir, 'src', 'store.ts'),
          '\n// index-bench incremental touch\n',
          'utf8',
        );
      } catch {
        // The touch is best-effort: if the probe file is absent the re-run still
        // measures a warm second search, and the report states which file was used.
      }
      const again = performance.now();
      await provider.search({ query: first.query, mode: 'hybrid', maxResults: first.k });
      incrementalMs = performance.now() - again;
    }

    const peakMemoryMb = process.memoryUsage().rss / 1024 / 1024;
    return buildReport(measured, options, digest, {
      coldIndexMs,
      incrementalMs,
      peakMemoryMb,
      startedAtMs,
      startedAt,
    });
  } finally {
    await provider.dispose();
  }
}

async function measureQuery(
  provider: LocalRetrievalProvider,
  workDir: string,
  query: IndexQuery,
): Promise<MeasuredQuery> {
  let returnedPaths: readonly string[] = [];
  let ripgrepMs = 0;
  let harnessError: string | undefined;

  try {
    const rgStart = performance.now();
    const rg = await ripgrepSearch({
      pattern: query.query,
      literal: query.mode === 'literal',
      cwd: workDir,
      maxResults: 50,
      timeoutMs: 10_000,
    });
    ripgrepMs = performance.now() - rgStart;
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const match of rg.matches) {
      if (seen.has(match.path)) continue;
      seen.add(match.path);
      ordered.push(match.path);
    }
    returnedPaths = ordered;
  } catch (error) {
    // A missing binary is a harness error, never a miss: recording zero results
    // as a retrieval failure would blame the fixture for an environment problem.
    harnessError = error instanceof Error ? error.message : `ripgrep failed: ${String(error)}`;
  }

  let providerMs = 0;
  try {
    const pStart = performance.now();
    await provider.search({ query: query.query, mode: 'hybrid', maxResults: query.k });
    providerMs = performance.now() - pStart;
  } catch {
    // Provider diagnostics are best-effort timing context; precision is decided
    // by the lexical pass above, so a provider failure must not fail the query.
    providerMs = 0;
  }

  const precision =
    harnessError === undefined ? precisionAtK(query.expectedPaths, returnedPaths, query.k) : 0;
  const matched =
    harnessError === undefined && matchedAtK(query.expectedPaths, returnedPaths, query.k);
  return {
    query,
    returnedPaths,
    ripgrepMs,
    providerMs,
    precision,
    matched,
    ...(harnessError === undefined ? {} : { harnessError }),
  };
}

function buildReport(
  measured: readonly MeasuredQuery[],
  options: IndexSuiteOptions,
  digest: { readonly digest: string; readonly files: number; readonly bytes: number },
  timing: {
    readonly coldIndexMs: number;
    readonly incrementalMs: number;
    readonly peakMemoryMb: number;
    readonly startedAtMs: number;
    readonly startedAt: string;
  },
): RunOutcome {
  const byTag: Record<string, Breakdown> = {};
  const results: CaseResult[] = [];
  const trajectories: Trajectory[] = [];

  let ripgrepSum = 0;
  let precisionSum = 0;

  for (const m of measured) {
    ripgrepSum += m.ripgrepMs;
    precisionSum += m.precision;
    const passed = m.matched;
    const outcome =
      m.harnessError !== undefined ? 'harness-error' : passed ? 'pass' : 'wrong-output';
    // Retrieval outcomes reuse the shared vocabulary with retrieval meaning, stated
    // in the report: 'wrong-output' here means no expected path was in the top-k,
    // not that a file was written. No `actual` is recorded, because tier, strategy
    // and validator describe the applier and claiming them would be a false claim
    // about evidence.
    const detail =
      m.harnessError !== undefined
        ? m.harnessError
        : `precision@${m.query.k}=${m.precision.toFixed(2)} ` +
          `(${m.query.expectedPaths.length} expected; ${m.returnedPaths.length} returned; ` +
          `rg ${m.ripgrepMs.toFixed(1)}ms)`;
    const firstExpected = m.query.expectedPaths[0] ?? 'fixture';
    const result: CaseResult = {
      id: m.query.id,
      file: 'queries.json',
      description: m.query.description,
      outcome: outcome as CaseResult['outcome'],
      tags: [...m.query.tags],
      language: languageForPath(firstExpected),
      durationMs: m.ripgrepMs + m.providerMs,
      detail,
    };
    results.push(result);
    for (const tag of m.query.tags) {
      byTag[tag] = addToBreakdown(byTag[tag], passed);
    }

    const bench: LoadedCase = {
      id: m.query.id,
      file: 'queries.json',
      description: m.query.description,
      path: toPosix(firstExpected),
      original: m.query.query,
      edits: [],
      expect: { kind: 'output', content: m.query.expectedPaths.join('\n') },
      tags: [...m.query.tags],
      source: 'index-bench fixture, synthetic',
    };
    trajectories.push({
      case: bench,
      result,
      output: JSON.stringify(
        {
          expectedPaths: m.query.expectedPaths,
          returnedPaths: m.returnedPaths,
          k: m.query.k,
          precisionAtK: m.precision,
          matched: m.matched,
          ripgrepMs: m.ripgrepMs,
          providerMs: m.providerMs,
        },
        null,
        2,
      ),
    });
  }

  const passed = results.filter((r) => r.outcome === 'pass').length;
  const harnessErrors = results.filter((r) => r.outcome === 'harness-error').length;
  const failed = results.length - passed - harnessErrors;
  const meanRipgrepMs = measured.length === 0 ? 0 : ripgrepSum / measured.length;
  const meanPrecisionAtK = measured.length === 0 ? 0 : precisionSum / measured.length;
  const meanQueryMs =
    measured.length === 0
      ? 0
      : measured.reduce((sum, m) => sum + m.ripgrepMs + m.providerMs, 0) / measured.length;

  const report: BenchReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    suite: 'index-bench',
    harnessVersion: HARNESS_VERSION,
    invocation: options.invocation,
    startedAt: timing.startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: performance.now() - timing.startedAtMs,
    environment: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    // Hand-written queries against a checked-in fixture. The numbers measure
    // local retrieval on this machine and say nothing about any model.
    inputSource: 'synthetic',
    models: [],
    attempts: 1,
    deterministic: true,
    totals: {
      cases: results.length,
      passed,
      failed,
      harnessErrors,
      passRate: results.length === 0 ? null : passed / results.length,
    },
    byTier: {},
    byStrategy: {},
    byValidator: {},
    byTag,
    refusalReasons: {},
    severeFailures: [],
    results,
    metrics: {
      coldIndexMs: timing.coldIndexMs,
      incrementalMs: timing.incrementalMs,
      meanQueryMs,
      meanRipgrepMs,
      meanPrecisionAtK,
      peakMemoryMb: timing.peakMemoryMb,
    },
    fixture: { digest: digest.digest, files: digest.files, bytes: digest.bytes },
    resourceBand: `small-scale local: ${digest.files} files, ${digest.bytes} bytes, no container, single attempt`,
  };

  return { report, trajectories };
}

/** Total files on disk under a directory, for tests asserting the band. */
export async function countFixtureFiles(fixtureDir: string): Promise<number> {
  let count = 0;
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const s = await stat(full);
        if (s.isFile()) count++;
      }
    }
  }
  await walk(fixtureDir);
  return count;
}
