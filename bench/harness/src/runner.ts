/**
 * The `apply-bench` runner.
 *
 * Deterministic and free: no model calls, no network, no container. That is what
 * makes it a Tier-1 gate eval per ADR-0011 — it runs on every pull request in under
 * a second, which is the only reason it will still be running in a year.
 *
 * What it measures: `@adze/apply`, against hand-written edits. It measures nothing
 * about any model, and the report says so rather than leaving a reader to assume
 * otherwise.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApplyOptions, ApplyResult } from '@adze/apply';
import { applyEdit, detectLanguage } from '@adze/apply';
import { type LoadedCase, parseCaseFile, renderText } from './case-schema.js';
import {
  addToBreakdown,
  type BenchReport,
  type Breakdown,
  type CaseOutcome,
  type CaseResult,
  REPORT_SCHEMA_VERSION,
} from './report-schema.js';

export const HARNESS_VERSION = '0.0.1';

/** Load every `*.json` under a suite's `cases/` directory, sorted for stable reports. */
export async function loadCases(suiteDir: string): Promise<LoadedCase[]> {
  const casesDir = join(suiteDir, 'cases');
  let entries: string[];
  try {
    entries = await readdir(casesDir);
  } catch (cause) {
    throw new Error(
      `cannot read ${casesDir}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const files = entries.filter((f) => f.endsWith('.json')).sort();
  const cases: LoadedCase[] = [];
  for (const file of files) {
    const text = await readFile(join(casesDir, file), 'utf8');
    cases.push(...parseCaseFile(text, file));
  }

  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) {
      // Duplicate ids would silently overwrite each other in the per-case
      // trajectory files, which is data loss in the artifact the policy requires.
      throw new Error(`duplicate case id '${c.id}' (second occurrence in ${c.file})`);
    }
    seen.add(c.id);
  }
  return cases;
}

function optionsFor(bench: LoadedCase): ApplyOptions {
  const o = bench.options;
  if (o === undefined) return {};
  return {
    ...(o.tiers === undefined ? {} : { tiers: o.tiers }),
    ...(o.maxWholeFileBytes === undefined ? {} : { maxWholeFileBytes: o.maxWholeFileBytes }),
  };
}

/**
 * Compare a result against a case's expectation.
 *
 * Returns the most specific mismatch. Order matters: a refusal that was supposed to
 * be an application is reported as `unexpected-refusal` rather than as a strategy
 * mismatch, because the first tells you what to fix.
 */
function classify(
  bench: LoadedCase,
  result: ApplyResult,
): { outcome: CaseOutcome; detail?: string } {
  const expect = bench.expect;

  if (expect.kind === 'refusal') {
    if (result.ok) {
      return {
        outcome: 'unexpected-success',
        detail: `expected refusal '${expect.reason}', but the edit was applied via ${result.telemetry.tier}/${result.telemetry.strategy ?? 'n/a'}`,
      };
    }
    if (result.reason !== expect.reason) {
      return {
        outcome: 'wrong-reason',
        detail: `expected refusal '${expect.reason}', got '${result.reason}'`,
      };
    }
    // Checked on refusals too, not only on successes. On a refusal the result *is*
    // the diagnosis, so the tier that produced it is what belongs in the per-tier
    // breakdown — and a case can pin that.
    if (expect.tier !== undefined && result.telemetry.tier !== expect.tier) {
      return {
        outcome: 'wrong-tier',
        detail: `refused correctly with '${result.reason}', but attributed to tier '${result.telemetry.tier}' rather than '${expect.tier}'`,
      };
    }
    return { outcome: 'pass' };
  }

  if (!result.ok) {
    return {
      outcome: 'unexpected-refusal',
      detail: `expected the edit to apply, got '${result.reason}': ${result.message}`,
    };
  }

  const expected = renderText(expect.content ?? '');
  if (result.content !== expected) {
    return {
      outcome: 'wrong-output',
      detail: `content mismatch (expected ${expected.length} chars, got ${result.content.length})`,
    };
  }

  if (expect.strategy !== undefined && result.telemetry.strategy !== expect.strategy) {
    return {
      outcome: 'wrong-strategy',
      detail: `right output, but via '${result.telemetry.strategy ?? 'none'}' rather than '${expect.strategy}'`,
    };
  }
  if (expect.tier !== undefined && result.telemetry.tier !== expect.tier) {
    return {
      outcome: 'wrong-tier',
      detail: `right output, but from tier '${result.telemetry.tier}' rather than '${expect.tier}'`,
    };
  }
  if (
    expect.validator !== undefined &&
    result.telemetry.validation.validator !== expect.validator
  ) {
    return {
      outcome: 'wrong-validator',
      detail: `right output, but validated by '${result.telemetry.validation.validator}' rather than '${expect.validator}'`,
    };
  }

  return { outcome: 'pass' };
}

/** Per-case output kept beside the report, so every trial is inspectable. */
export interface Trajectory {
  readonly case: LoadedCase;
  readonly result: CaseResult;
  /** The file the applier produced, when it produced one. */
  readonly output?: string;
}

export async function runCase(bench: LoadedCase): Promise<Trajectory> {
  const startedAt = performance.now();
  const language = detectLanguage(bench.path);
  const base = {
    id: bench.id,
    file: bench.file,
    description: bench.description,
    tags: bench.tags ?? [],
    language,
  };

  let result: ApplyResult;
  try {
    result = await applyEdit(
      {
        path: bench.path,
        original: renderText(bench.original),
        edits: bench.edits,
        ...(bench.replacement === undefined ? {} : { replacement: renderText(bench.replacement) }),
      },
      optionsFor(bench),
    );
  } catch (cause) {
    return {
      case: bench,
      result: {
        ...base,
        outcome: 'harness-error',
        durationMs: performance.now() - startedAt,
        detail: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }

  const { outcome, detail } = classify(bench, result);
  const caseResult: CaseResult = {
    ...base,
    outcome,
    durationMs: performance.now() - startedAt,
    actual: {
      ok: result.ok,
      tier: result.telemetry.tier,
      ...(result.telemetry.strategy === undefined ? {} : { strategy: result.telemetry.strategy }),
      validator: result.telemetry.validation.validator,
      validationOk: result.telemetry.validation.ok,
      ...(result.ok ? {} : { reason: result.reason, message: result.message }),
      tiersAttempted: result.telemetry.tiersAttempted,
    },
    ...(detail === undefined ? {} : { detail }),
  };

  // The produced file is retained for the trajectory, pass or fail. Publishing
  // failures is the strongest credibility signal available, and a report that
  // contains only passes is not checkable.
  return {
    case: bench,
    result: caseResult,
    ...(result.ok ? { output: result.content } : {}),
  };
}

export interface RunOutcome {
  readonly report: BenchReport;
  readonly trajectories: readonly Trajectory[];
}

function bucket(map: Record<string, Breakdown>, key: string, passed: boolean): void {
  map[key] = addToBreakdown(map[key], passed);
}

export async function runSuite(
  cases: readonly LoadedCase[],
  meta: { readonly suite: string; readonly invocation: string },
): Promise<RunOutcome> {
  const startedAtMs = performance.now();
  const startedAt = new Date().toISOString();

  const trajectories: Trajectory[] = [];
  for (const bench of cases) {
    trajectories.push(await runCase(bench));
  }
  const results = trajectories.map((t) => t.result);

  const byTier: Record<string, Breakdown> = {};
  const byStrategy: Record<string, Breakdown> = {};
  const byValidator: Record<string, Breakdown> = {};
  const byTag: Record<string, Breakdown> = {};
  const refusalReasons: Record<string, number> = {};

  for (const r of results) {
    const passed = r.outcome === 'pass';
    if (r.actual !== undefined) {
      bucket(byTier, r.actual.tier, passed);
      bucket(byStrategy, r.actual.strategy ?? 'none', passed);
      bucket(byValidator, r.actual.validator, passed);
      if (r.actual.reason !== undefined) {
        refusalReasons[r.actual.reason] = (refusalReasons[r.actual.reason] ?? 0) + 1;
      }
    }
    for (const tag of r.tags) bucket(byTag, tag, passed);
  }

  const passed = results.filter((r) => r.outcome === 'pass').length;
  const harnessErrors = results.filter((r) => r.outcome === 'harness-error').length;
  const failed = results.length - passed - harnessErrors;

  const report: BenchReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    suite: meta.suite,
    harnessVersion: HARNESS_VERSION,
    invocation: meta.invocation,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: performance.now() - startedAtMs,
    environment: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    // Hand-written cases. This is the field that stops the report being read as a
    // statement about model behaviour.
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
    byTier,
    byStrategy,
    byValidator,
    byTag,
    refusalReasons,
    severeFailures: results.filter((r) => r.outcome === 'unexpected-success'),
    results,
  };

  return { report, trajectories };
}
