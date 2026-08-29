/**
 * `@adze/bench-harness` — benchmark adapters and reporting for Adze.
 *
 * **Nothing in product code may import this package.** Benchmark code that can
 * influence what ships stops measuring the product; the isolation is the reason the
 * numbers mean anything. The dependency runs one way: `bench/` imports `@adze/apply`
 * and never the reverse.
 *
 * ADR-0011 commits to building *adapters*, not a harness. Harbor is the harness for
 * the public boards we target, and a private harness is indistinguishable from a
 * tuned one. `apply-bench` is the exception, and it is an exception with a reason:
 * nobody publishes apply success rate per model per tier, so there is no existing
 * harness to adapt to.
 */

export type {
  BenchCase,
  CaseExpectation,
  CaseOptions,
  CaseText,
  LoadedCase,
} from './case-schema.js';
export { CaseFormatError, parseCase, parseCaseFile, renderText } from './case-schema.js';
export { renderConsoleSummary, renderReportMarkdown } from './report.js';
export type { BenchReport, Breakdown, CaseOutcome, CaseResult } from './report-schema.js';
export {
  addToBreakdown,
  emptyBreakdown,
  formatRate,
  REPORT_SCHEMA_VERSION,
} from './report-schema.js';
export type { RunOutcome, Trajectory } from './runner.js';
export { HARNESS_VERSION, loadCases, runCase, runSuite } from './runner.js';
export type { WrittenRun } from './write-run.js';
export { runStamp, writeRun } from './write-run.js';
