/**
 * Artifact validation: whether a report we just produced may be published.
 *
 * `publication.ts` holds the rules as pure functions over numbers and citations.
 * This module is the caller those functions were waiting for. The split is
 * deliberate: the rules must not know about `BenchReport`, because a Tier-2 report
 * will have a different shape and the rules have to outlive it.
 *
 * ## Why validate the artifact rather than review the author
 *
 * `looksLikeMaxOverN` names the failure this file exists for: not a developer
 * writing `Math.max` and believing it complies, but a `result.json` whose headline
 * was filled in by hand from the run that went best. A check that runs on the
 * produced artifact catches that; a checklist item in a review template does not.
 * So every invariant here is stated over the report as data, and is checked on the
 * report that is about to be written rather than on the code that wrote it.
 *
 * ## Why a violation does not stop the run being written
 *
 * `docs/benchmarks/strategy.md` requires trajectories for every trial, failures
 * included, because a report containing only passes is not checkable. Destroying
 * that evidence to hide a policy failure would be the worse outcome, so a violating
 * run is still written in full. What changes is that the violation is rendered into
 * `report.md` itself, inside the limitations section and above every number, and
 * `adze-bench` exits non-zero. The number cannot be quoted from the artifact without
 * the reason it is not publishable travelling with it.
 *
 * ## What is enforced here, and what is not yet
 *
 * Enforced: report integrity, the deterministic/stochastic distinction, model-pin
 * honesty, the wiring-check refusal — and through `checkCitation` — that the
 * report's own provenance is citable. That last one is real rather than decorative:
 * a run whose harness version or invocation is empty is not reproducible, and the
 * policy requires the exact command for every number we publish. The wiring-check
 * refusal is the same construction keyed on the suite name: a `swe-smoke` report
 * carries `wiring-check-not-publishable` no matter how green its cases, because a
 * wiring check whose report could pass the gate would become a result the first
 * time someone quoted it.
 *
 * Not enforced, because a Tier-1 report carries no input for them:
 * `compareToBaseline` needs a published baseline and `looksLikeMaxOverN` needs more
 * than one attempt. `apply-bench` has neither. Calling them anyway on absent data
 * would produce the appearance of enforcement without the substance, which is the
 * failure this package has already had to correct once. They activate when a report
 * shape that carries a baseline or per-attempt rates exists.
 *
 * ## Why there is no leakage rule here
 *
 * The tempting shape is to refuse a report whose `inputSource` is not `synthetic`
 * unless it carries leakage-audit evidence, so that a future Tier-2 run cannot omit
 * it. It was considered and rejected for two reasons.
 *
 * It would need a new `BenchReport` field, and the second paragraph of this file is
 * that the rules must not know about `BenchReport` because a Tier-2 report will have
 * a different shape. The field would therefore be added to the Tier-1 shape in order
 * to guard a condition only a shape that does not exist yet can reach — speculative
 * schema for an absent tier.
 *
 * It would also be the weakest rule in the gate. Every rule here compares two things
 * present in the same artifact: `totals` against `results`, `severeFailures` against
 * `results`, `inputSource` against `models`. That is what makes them checks rather
 * than assertions of good intent. A leakage field would carry a claim with nothing
 * beside it to check the claim against, which is precisely the review-checklist item
 * this file exists to replace.
 *
 * The assertions themselves live in `leakage.ts`, which records why nothing calls
 * them yet and what each one waits for. Every generated `audit.md` restates it per
 * run, which puts the gap in the artifact without pretending a check ran.
 */

import { type Citation, checkCitation } from './publication.js';
import { type BenchReport, REPORT_SCHEMA_VERSION } from './report-schema.js';
import { MIN_ATTEMPTS } from './statistics.js';

/**
 * Why a report may not be published.
 *
 * Distinct codes rather than one generic failure, for the same reason
 * `ApplyFailureReason` is: each maps to a different fix, and collapsing them would
 * discard the only information the reader needs.
 */
export type PolicyViolationCode =
  /** Written against a report schema this harness does not implement. */
  | 'schema-version-mismatch'
  /** `totals.cases` disagrees with the number of case results present. */
  | 'case-count-mismatch'
  /** Passed, failed and harness errors do not account for every case. */
  | 'totals-do-not-sum'
  /** The headline pass rate is not what the case results add up to. */
  | 'headline-not-derived-from-results'
  /** The severe list does not match the cases that actually applied when refused. */
  | 'severe-list-incomplete'
  /** Attempts is not a positive whole number. */
  | 'invalid-attempt-count'
  /** A stochastic suite reporting fewer attempts than the policy's minimum. */
  | 'single-run-headline'
  /** A deterministic suite claiming repeated attempts it cannot benefit from. */
  | 'deterministic-repeated-attempts'
  /** Model-derived inputs with no pinned model recorded. */
  | 'model-claim-without-pins'
  /** Synthetic inputs while listing model pins. */
  | 'synthetic-claim-with-model-pins'
  /** The report cannot cite itself: no pinned harness version, or no invocation. */
  | 'provenance-not-citable'
  /**
   * A wiring-check report that must never be published. `swe-smoke` exercises the
   * Tier-1 pipeline end to end against placeholders, not SWE-bench tasks, and its
   * number is unquotable by N18 — a wiring check whose report could pass the gate
   * would become a result the first time someone quoted it.
   */
  | 'wiring-check-not-publishable';

export interface PolicyViolation {
  readonly code: PolicyViolationCode;
  /** Written for a maintainer deciding what to fix, not for a log line. */
  readonly message: string;
}

export type ReportPolicyCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly PolicyViolation[] };

/** The harness name this package cites itself as. */
export const HARNESS_CITATION_NAME = 'adze-bench';

/**
 * The report's own provenance, as a citation.
 *
 * A first-party harness result is cited by pinned version and exact invocation
 * rather than by URL, because the evidence is the artifacts. Building it here and
 * running it through `checkCitation` means the report is held to the same standard as
 * any external number it might cite.
 */
export function harnessCitation(report: BenchReport): Citation {
  return {
    kind: 'first-party-harness',
    label: `${report.suite} (first-party harness run)`,
    harnessName: HARNESS_CITATION_NAME,
    harnessVersion: report.harnessVersion,
    invocation: report.invocation,
  };
}

/** Floating-point slack. A hand-edited headline differs by far more than this. */
const RATE_EPSILON = 1e-9;

function checkIntegrity(report: BenchReport, add: (v: PolicyViolation) => void): void {
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) {
    add({
      code: 'schema-version-mismatch',
      message:
        `report claims schema version ${report.schemaVersion}, but this harness writes ` +
        `version ${REPORT_SCHEMA_VERSION}. Fields may mean something different than the ` +
        'renderer assumes.',
    });
  }

  const { totals, results } = report;

  if (totals.cases !== results.length) {
    add({
      code: 'case-count-mismatch',
      message:
        `totals.cases is ${totals.cases} but ${results.length} case result(s) are present. ` +
        'The headline denominator does not match the evidence beside it.',
    });
  }

  if (totals.passed + totals.failed + totals.harnessErrors !== totals.cases) {
    add({
      code: 'totals-do-not-sum',
      message:
        `passed (${totals.passed}) + failed (${totals.failed}) + harness errors ` +
        `(${totals.harnessErrors}) does not equal cases (${totals.cases}). Some cases are ` +
        'unaccounted for, so any rate computed from these numbers is meaningless.',
    });
  }

  const observedPassed = results.filter((r) => r.outcome === 'pass').length;
  if (observedPassed !== totals.passed) {
    add({
      code: 'headline-not-derived-from-results',
      message:
        `totals.passed is ${totals.passed}, but ${observedPassed} case result(s) have ` +
        "outcome 'pass'. A headline that is not derived from the case results is exactly " +
        'the artifact the max-over-N rule was written against.',
    });
  }

  const expectedRate = results.length === 0 ? null : observedPassed / results.length;
  const reportedRate = totals.passRate;
  const rateDiffers =
    expectedRate === null || reportedRate === null
      ? expectedRate !== reportedRate
      : Math.abs(expectedRate - reportedRate) > RATE_EPSILON;
  if (rateDiffers) {
    add({
      code: 'headline-not-derived-from-results',
      message:
        `totals.passRate does not equal the rate implied by the case results ` +
        `(${observedPassed} of ${results.length}). The headline must be computed from the ` +
        'evidence published beside it, not written in independently.',
    });
  }

  const severeIds = [...report.severeFailures.map((r) => r.id)].sort();
  const observedSevereIds = results
    .filter((r) => r.outcome === 'unexpected-success')
    .map((r) => r.id)
    .sort();
  if (severeIds.join('\u0000') !== observedSevereIds.join('\u0000')) {
    add({
      code: 'severe-list-incomplete',
      message:
        `severeFailures lists ${severeIds.length} case(s) but ${observedSevereIds.length} ` +
        "case result(s) have outcome 'unexpected-success'. The renderer prints \"every case " +
        'that asserts a refusal was refused" from this list, so a list that disagrees with ' +
        'the results makes the report state the opposite of what happened — and this is the ' +
        'class of failure that corrupts a file.',
    });
  }
}

function checkMeasurementClaims(report: BenchReport, add: (v: PolicyViolation) => void): void {
  if (!Number.isInteger(report.attempts) || report.attempts < 1) {
    add({
      code: 'invalid-attempt-count',
      message: `attempts is ${report.attempts}; it must be a whole number of at least 1.`,
    });
  } else if (report.deterministic) {
    if (report.attempts !== 1) {
      add({
        code: 'deterministic-repeated-attempts',
        message:
          `a deterministic suite reports ${report.attempts} attempts. Repeating a run with ` +
          'no sampling produces a zero-variance interval that looks like rigour and carries ' +
          'no information. Report one attempt, or state why the suite is not deterministic.',
      });
    }
  } else if (report.attempts < MIN_ATTEMPTS) {
    add({
      code: 'single-run-headline',
      message:
        `a non-deterministic suite reports ${report.attempts} attempt(s), below the ` +
        `${MIN_ATTEMPTS} that docs/benchmarks/strategy.md requires. A single-run number is ` +
        'not a result: report mean and standard error over at least three attempts.',
    });
  }

  if (report.inputSource === 'synthetic') {
    if (report.models.length > 0) {
      add({
        code: 'synthetic-claim-with-model-pins',
        message:
          `inputSource is 'synthetic' but ${report.models.length} model pin(s) are listed. ` +
          'One of the two is wrong, and a reader cannot tell which measurement this is.',
      });
    }
  } else if (report.models.length === 0) {
    add({
      code: 'model-claim-without-pins',
      message:
        `inputSource is '${report.inputSource}' but no model pins are recorded. The policy ` +
        'requires pinned dated model snapshots; an unpinned model result cannot be ' +
        'reproduced and must not be published.',
    });
  }
}

/**
 * Whether the report is a wiring check whose number must never be quoted.
 *
 * `swe-smoke` runs the Tier-1 pipeline against 25 placeholders to prove the
 * wiring works while Tier-2 waits on Harbor, a dataset, and a container
 * runtime. Its cases pass by construction, so without this rule a green run
 * would read as a result. With it, every swe-smoke report carries its refusal
 * above every number and `adze-bench` exits 3 — which is the passing condition
 * CI asserts.
 */
function checkWiringOnly(report: BenchReport, add: (v: PolicyViolation) => void): void {
  if (report.suite !== 'swe-smoke') return;
  add({
    code: 'wiring-check-not-publishable',
    message:
      'this is a wiring check, not a measurement: its 25 cases are placeholders, not ' +
      'SWE-bench tasks, and Tier-2 is blocked on Harbor, a dataset, and a container ' +
      'runtime. Its number must never be published or quoted — not in a PR, not in ' +
      'docs, not as "25/25 on SWE-smoke" — per N18 and docs/benchmarks/strategy.md.',
  });
}

/**
 * Whether this report may be published, and if not, precisely why.
 *
 * Every violation is collected rather than returning at the first, because a
 * maintainer fixing a report should see the whole list in one pass.
 */
export function checkReportPolicy(report: BenchReport): ReportPolicyCheck {
  const violations: PolicyViolation[] = [];
  const add = (v: PolicyViolation): void => {
    violations.push(v);
  };

  checkIntegrity(report, add);
  checkMeasurementClaims(report, add);
  checkWiringOnly(report, add);

  const citation = checkCitation(harnessCitation(report));
  if (!citation.ok) {
    add({
      code: 'provenance-not-citable',
      message:
        'the report cannot cite its own run: ' +
        `${citation.problems.join('; ')}. A number nobody can regenerate is not publishable.`,
    });
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
