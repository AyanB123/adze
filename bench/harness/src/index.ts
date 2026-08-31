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
 *
 * The publication rules from `docs/benchmarks/strategy.md` are reachable from here on
 * purpose. `checkReportPolicy` is the gate a produced report passes through, and it
 * runs inside `renderReportMarkdown` rather than being left to a caller. The rules it
 * is built from — `compareToBaseline`, `checkCitation`, `estimatePassRate` — are
 * exported too, because the Tier-2 adapters will need them and because a rule nothing
 * can reach is a rule nobody is following.
 */

export type {
  BenchCase,
  CaseExpectation,
  CaseOptions,
  CaseText,
  LoadedCase,
} from './case-schema.js';
export { CaseFormatError, parseCase, parseCaseFile, renderText } from './case-schema.js';
export type {
  Baseline,
  Citation,
  CitationCheck,
  Comparison,
  ComparisonVerdict,
  SourceKind,
  SourceRegistry,
} from './publication.js';
export {
  checkCitation,
  compareToBaseline,
  DEFAULT_SOURCE_REGISTRY,
  KNOWN_AGGREGATOR_HOSTS,
  NOISE_FLOOR_POINTS,
  SEM_MULTIPLE,
  VERIFIED_LEADERBOARD_HOSTS,
} from './publication.js';
export { renderConsoleSummary, renderReportMarkdown } from './report.js';
export type {
  PolicyViolation,
  PolicyViolationCode,
  ReportPolicyCheck,
} from './report-policy.js';
export { checkReportPolicy, HARNESS_CITATION_NAME, harnessCitation } from './report-policy.js';
export type { BenchReport, Breakdown, CaseOutcome, CaseResult } from './report-schema.js';
export {
  addToBreakdown,
  emptyBreakdown,
  formatRate,
  REPORT_SCHEMA_VERSION,
} from './report-schema.js';
export type { RunOutcome, Trajectory } from './runner.js';
export { HARNESS_VERSION, loadCases, runCase, runSuite } from './runner.js';
export type { AttemptSummary, PassRateEstimate } from './statistics.js';
export {
  attemptRate,
  estimatePassRate,
  formatMeanSem,
  looksLikeMaxOverN,
  MIN_ATTEMPTS,
  StatisticsError,
  solvesPerMillionCompletionTokens,
} from './statistics.js';
export type { WrittenRun } from './write-run.js';
export { runStamp, writeRun } from './write-run.js';
