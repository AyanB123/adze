/**
 * `nep-bench` scoring helpers — the Tier-1 prototype of next-edit prediction.
 *
 * What this suite is: thirty (prefix-context, next-edit) pairs mined from
 * Adze's own git history (see `bench/suites/nep-bench/scripts/mine.mjs`), run
 * deterministically by handing the TRUE edit to `@adze/apply` and checking the
 * reconstruction. What it is not: a measurement of any model. No model loop is
 * wired — that needs a dataset adapter, pinned model snapshots, and at least
 * three attempts per case (see the suite README) — so the number below is the
 * applier's prefix-to-edit reconstruction ability given the answer, and the
 * report's limitations section says exactly that before any number.
 *
 * Scoring in v0 reuses the `apply-bench` outcome vocabulary rather than
 * inventing a second one:
 *
 * - **Exact match** is `outcome === 'pass'`: the applier's output is
 *   byte-identical to the mined post-image. A pass IS an exact match, and
 *   `wrong-output` is the miss. There is no separate near-miss score, because
 *   a near-miss on source code is a different program (ADR-0005).
 * - **AST-equivalence-or-parse-validity** is the validator level the run
 *   actually observed (`byValidator`): `tree-sitter` means a real parse ran,
 *   `structural` the delimiter-and-indentation check, `none` that nothing was
 *   checked. v0 does not boolean-normalize ASTs beyond that — recorded here as
 *   a limit, not as a second number that looks measured and is not.
 * - **Relevant test pass, where cheap**, is not run in v0. Running a case's
 *   neighboring test file would need a container to be honest about isolation,
 *   and Tier 1 has no container by design. The `test` tag marks which cases
 *   have one, so the wiring for that column exists before the measurement does.
 *
 * Per-language breakdown is grouped from `CaseResult.language` (detected from
 * the case path, which is what the validator saw), not from tags, so a case
 * cannot claim a language its path does not detect as.
 */

import type { LoadedCase } from './case-schema.js';
import { addToBreakdown, type BenchReport, type Breakdown, formatRate } from './report-schema.js';
import type { RunOutcome } from './runner.js';

/** Suite name, shared by the runner invocation, the report, and the tests. */
export const NEP_SUITE = 'nep-bench';

/** v0 window: the prototype set must stay small enough to review by hand. */
export const NEP_V0_MIN_CASES = 20;
export const NEP_V0_MAX_CASES = 40;

/**
 * Whether a case carries mined provenance.
 *
 * The miner writes `source` as `commit <40-hex> file <path> language <name>`
 * and tags the language. Both are required: the SHA makes the pair
 * re-derivable from history, and the tag makes the per-language breakdown
 * reviewable without parsing strings.
 */
export function hasNepProvenance(bench: LoadedCase): boolean {
  if (bench.source === undefined) return false;
  if (!/^commit [0-9a-f]{40} file \S+ language \S+/.test(bench.source)) return false;
  const language = bench.source.split('language ').pop() ?? '';
  return bench.tags?.includes(language) ?? false;
}

/** Pass/fail grouped by the language the validator actually saw. */
export function languageBreakdown(report: BenchReport): Record<string, Breakdown> {
  const byLanguage: Record<string, Breakdown> = {};
  for (const result of report.results) {
    const passed = result.outcome === 'pass';
    byLanguage[result.language] = addToBreakdown(byLanguage[result.language], passed);
  }
  return byLanguage;
}

export interface NepSummary {
  /** Cases in the run. */
  readonly cases: number;
  /** Exact-match rate: `pass` means byte-identical to the mined post-image. */
  readonly exactMatchRate: number | null;
  /**
   * Share of cases whose applier telemetry reports validationOk, among cases
   * that produced telemetry. A harness error carries no telemetry and is
   * excluded rather than counted as invalid.
   */
  readonly parseValidRate: number | null;
  /** Which validator levels ran, keyed by level. */
  readonly byValidator: Readonly<Record<string, Breakdown>>;
  /** Pass/fail by language. */
  readonly byLanguage: Record<string, Breakdown>;
  /** Cases carrying the `test` tag: the future test-pass column's roster. */
  readonly testCases: number;
  /** Applied-when-refusal-required: the corruption class, always surfaced. */
  readonly severeFailures: number;
}

/** Score a finished `nep-bench` run. Pure function over the report. */
export function summarizeNep(report: BenchReport): NepSummary {
  const withTelemetry = report.results.filter((r) => r.actual !== undefined);
  const valid = withTelemetry.filter((r) => r.actual?.validationOk === true).length;
  return {
    cases: report.totals.cases,
    exactMatchRate: report.totals.passRate,
    parseValidRate: withTelemetry.length === 0 ? null : valid / withTelemetry.length,
    byValidator: report.byValidator,
    byLanguage: languageBreakdown(report),
    testCases: report.results.filter((r) => r.tags.includes('test')).length,
    severeFailures: report.severeFailures.length,
  };
}

/** One-line-per-finding console rendering. Never the report itself. */
export function renderNepSummary(summary: NepSummary): string {
  const lines = [
    `${NEP_SUITE}: ${summary.cases} cases, exact match ${formatRate(summary.exactMatchRate)}, parse-valid ${formatRate(summary.parseValidRate)}`,
  ];
  const languages = Object.keys(summary.byLanguage).sort();
  for (const language of languages) {
    const breakdown = summary.byLanguage[language];
    if (breakdown === undefined) continue;
    lines.push(
      `  ${language}: ${breakdown.passed}/${breakdown.total} (${formatRate(breakdown.passRate)})`,
    );
  }
  lines.push(`  test-tagged cases: ${summary.testCases} (test-pass column not measured in v0)`);
  if (summary.severeFailures > 0) {
    lines.push(`  ${summary.severeFailures} SEVERE: applied an edit that required a refusal`);
  }
  return lines.join('\n');
}

/**
 * Totales cross-check for tests: the summary must agree with the run it was
 * derived from, so a future scoring change cannot silently diverge from the
 * artifact beside it.
 */
export function checkNepSummary(outcome: RunOutcome, summary: NepSummary): string[] {
  const problems: string[] = [];
  if (summary.cases !== outcome.report.totals.cases) {
    problems.push(
      `summary counts ${summary.cases} cases but the report totals ${outcome.report.totals.cases}`,
    );
  }
  const counted = Object.values(summary.byLanguage).reduce((sum, b) => sum + b.total, 0);
  if (counted !== outcome.report.totals.cases) {
    problems.push(
      `per-language breakdown counts ${counted} cases but the report totals ${outcome.report.totals.cases}`,
    );
  }
  return problems;
}
