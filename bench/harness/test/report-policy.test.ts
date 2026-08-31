/**
 * Tests for the artifact gate.
 *
 * Two obligations pull against each other here, and both are tested.
 *
 * The gate must **accept the report the harness really produces**. A gate that fires
 * on a legitimate run gets switched off within a week, so the first test runs the
 * committed suite end to end and requires a clean verdict. That is also what stops the
 * invariants below from being written to match a hand-built fixture that drifts from
 * what `runSuite` emits.
 *
 * The gate must **refuse a report whose headline is not what the evidence says**. So
 * every violation is provoked by mutating one field of an otherwise valid report,
 * which is the shape a hand-edited `result.json` would actually have.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCitation } from '../src/publication.js';
import { renderReportMarkdown } from '../src/report.js';
import {
  checkReportPolicy,
  harnessCitation,
  type PolicyViolationCode,
  type ReportPolicyCheck,
} from '../src/report-policy.js';
import { type BenchReport, type CaseResult, REPORT_SCHEMA_VERSION } from '../src/report-schema.js';
import { loadCases, runSuite } from '../src/runner.js';

const suiteDir = join(import.meta.dirname, '..', '..', 'suites', 'apply-bench');

function codes(check: ReportPolicyCheck): readonly PolicyViolationCode[] {
  return check.ok ? [] : check.violations.map((v) => v.code);
}

function messages(check: ReportPolicyCheck): string {
  return check.ok ? '' : check.violations.map((v) => v.message).join(' ');
}

function caseResult(id: string, outcome: CaseResult['outcome']): CaseResult {
  return {
    id,
    file: 'cases/example.json',
    description: `case ${id}`,
    outcome,
    tags: [],
    language: 'typescript',
    durationMs: 1,
  };
}

/** A report that passes every gate, as the baseline for one-field mutations. */
function validReport(): BenchReport {
  const results = [caseResult('a', 'pass'), caseResult('b', 'pass')];
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    suite: 'apply-bench',
    harnessVersion: '0.0.1',
    invocation: 'node bench/harness/bin/adze-bench.mjs apply',
    startedAt: '2026-08-30T00:00:00.000Z',
    finishedAt: '2026-08-30T00:00:01.000Z',
    durationMs: 1000,
    environment: { node: '22.12.0', platform: 'linux', arch: 'x64' },
    inputSource: 'synthetic',
    models: [],
    attempts: 1,
    deterministic: true,
    totals: { cases: 2, passed: 2, failed: 0, harnessErrors: 0, passRate: 1 },
    byTier: {},
    byStrategy: {},
    byValidator: {},
    byTag: {},
    refusalReasons: {},
    severeFailures: [],
    results,
  };
}

describe('the gate accepts what the harness actually produces', () => {
  it('passes the committed apply-bench run', async () => {
    // The load-bearing test in this file. If the gate rejects a legitimate run, every
    // invariant below is wrong no matter how well it reads.
    const cases = await loadCases(suiteDir);
    const outcome = await runSuite(cases, {
      suite: 'apply-bench',
      invocation: 'node bench/harness/bin/adze-bench.mjs apply',
    });

    const check = checkReportPolicy(outcome.report);
    expect(messages(check)).toBe('');
    expect(check.ok).toBe(true);
  });

  it('passes a hand-built valid report', () => {
    expect(checkReportPolicy(validReport()).ok).toBe(true);
  });

  it('accepts a stochastic suite that reports at least three attempts', () => {
    const report: BenchReport = { ...validReport(), deterministic: false, attempts: 3 };
    expect(checkReportPolicy(report).ok).toBe(true);
  });

  it('accepts model-derived inputs when the model is pinned', () => {
    const report: BenchReport = {
      ...validReport(),
      inputSource: 'model',
      models: ['some-model-2026-08-01'],
    };
    expect(checkReportPolicy(report).ok).toBe(true);
  });
});

describe('report integrity', () => {
  it('refuses a schema version this harness does not write', () => {
    const report: BenchReport = { ...validReport(), schemaVersion: REPORT_SCHEMA_VERSION + 1 };
    expect(codes(checkReportPolicy(report))).toContain('schema-version-mismatch');
  });

  it('refuses a case count that disagrees with the results present', () => {
    const base = validReport();
    const report: BenchReport = { ...base, totals: { ...base.totals, cases: 50 } };

    const found = codes(checkReportPolicy(report));
    expect(found).toContain('case-count-mismatch');
  });

  it('refuses totals that do not account for every case', () => {
    const base = validReport();
    const report: BenchReport = { ...base, totals: { ...base.totals, failed: 1 } };
    expect(codes(checkReportPolicy(report))).toContain('totals-do-not-sum');
  });

  it('refuses a headline pass rate written in independently of the results', () => {
    // The hand-edited `result.json`: the cases say one thing, the number says another.
    const base = validReport();
    const report: BenchReport = { ...base, totals: { ...base.totals, passRate: 0.5 } };

    const check = checkReportPolicy(report);
    expect(codes(check)).toContain('headline-not-derived-from-results');
    expect(messages(check)).toContain('computed from the');
  });

  it('refuses a passed count that disagrees with the case outcomes', () => {
    const base = validReport();
    const report: BenchReport = {
      ...base,
      totals: { ...base.totals, passed: 1, failed: 1 },
    };
    expect(codes(checkReportPolicy(report))).toContain('headline-not-derived-from-results');
  });

  it('tolerates floating-point noise in a rate it recomputes', () => {
    // 1/3 does not round-trip exactly through arithmetic, and refusing a report over
    // the last bit of a double would make the gate useless.
    const results = [
      caseResult('a', 'pass'),
      caseResult('b', 'wrong-output'),
      caseResult('c', 'wrong-output'),
    ];
    const report: BenchReport = {
      ...validReport(),
      results,
      totals: { cases: 3, passed: 1, failed: 2, harnessErrors: 0, passRate: 0.333_333_333_333 },
    };

    expect(checkReportPolicy(report).ok).toBe(true);
  });
});

describe('the severe class cannot be hidden', () => {
  it('refuses a report that omits a case which applied when a refusal was required', () => {
    // The renderer prints "every case that asserts a refusal was refused" from
    // `severeFailures`. Emptying that list while the results still record the
    // corruption makes the report state the opposite of what happened, which is worse
    // than a wrong number.
    const results = [caseResult('a', 'pass'), caseResult('b', 'unexpected-success')];
    const report: BenchReport = {
      ...validReport(),
      results,
      totals: { cases: 2, passed: 1, failed: 1, harnessErrors: 0, passRate: 0.5 },
      severeFailures: [],
    };

    const check = checkReportPolicy(report);
    expect(codes(check)).toContain('severe-list-incomplete');
    expect(messages(check)).toContain('corrupts a file');
  });

  it('refuses a severe list naming a case the results do not', () => {
    const report: BenchReport = {
      ...validReport(),
      severeFailures: [caseResult('ghost', 'unexpected-success')],
    };
    expect(codes(checkReportPolicy(report))).toContain('severe-list-incomplete');
  });

  it('accepts a severe list that matches the results exactly', () => {
    const results = [caseResult('a', 'pass'), caseResult('b', 'unexpected-success')];
    const report: BenchReport = {
      ...validReport(),
      results,
      totals: { cases: 2, passed: 1, failed: 1, harnessErrors: 0, passRate: 0.5 },
      severeFailures: [caseResult('b', 'unexpected-success')],
    };

    expect(checkReportPolicy(report).ok).toBe(true);
  });
});

describe('what the number is a measurement of', () => {
  it('refuses a stochastic suite reporting a single run', () => {
    // The rule the policy states outright: a single-run number is not a result. This
    // fires the moment a model-driven tier is wired without an attempt loop.
    const report: BenchReport = { ...validReport(), deterministic: false, attempts: 1 };

    const check = checkReportPolicy(report);
    expect(codes(check)).toContain('single-run-headline');
    expect(messages(check)).toContain('not a result');
  });

  it('refuses a deterministic suite claiming repeated attempts', () => {
    // Repeating a run with no sampling manufactures a zero-variance interval that
    // looks like rigour, which is why the schema pins attempts at 1 for this suite.
    const report: BenchReport = { ...validReport(), attempts: 3 };

    const check = checkReportPolicy(report);
    expect(codes(check)).toContain('deterministic-repeated-attempts');
    expect(messages(check)).toContain('looks like rigour');
  });

  it('refuses a nonsensical attempt count', () => {
    expect(codes(checkReportPolicy({ ...validReport(), attempts: 0 }))).toContain(
      'invalid-attempt-count',
    );
    expect(codes(checkReportPolicy({ ...validReport(), attempts: 1.5 }))).toContain(
      'invalid-attempt-count',
    );
  });

  it('refuses model-derived inputs with no model pinned', () => {
    const report: BenchReport = { ...validReport(), inputSource: 'model', models: [] };

    const check = checkReportPolicy(report);
    expect(codes(check)).toContain('model-claim-without-pins');
    expect(messages(check)).toContain('pinned dated model snapshots');
  });

  it('refuses synthetic inputs that list model pins', () => {
    const report: BenchReport = { ...validReport(), models: ['some-model-2026-08-01'] };
    expect(codes(checkReportPolicy(report))).toContain('synthetic-claim-with-model-pins');
  });
});

describe('a report has to be able to cite its own run', () => {
  it('builds a first-party-harness citation that passes rule 2', () => {
    expect(checkCitation(harnessCitation(validReport())).ok).toBe(true);
  });

  it('refuses a report with no invocation recorded', () => {
    // The policy publishes the exact command for every number. Without it the run
    // cannot be regenerated by anyone, including us.
    const report: BenchReport = { ...validReport(), invocation: '' };

    const check = checkReportPolicy(report);
    expect(codes(check)).toContain('provenance-not-citable');
    expect(messages(check)).toContain('invocation');
  });

  it('refuses a report from an unpinned harness', () => {
    const report: BenchReport = { ...validReport(), harnessVersion: '' };

    const check = checkReportPolicy(report);
    expect(codes(check)).toContain('provenance-not-citable');
    expect(messages(check)).toContain('harnessVersion');
  });
});

describe('reporting every problem at once', () => {
  it('collects all violations rather than stopping at the first', () => {
    const base = validReport();
    const report: BenchReport = {
      ...base,
      deterministic: false,
      attempts: 1,
      inputSource: 'model',
      models: [],
      invocation: '',
      totals: { ...base.totals, passRate: 0.25 },
    };

    const found = codes(checkReportPolicy(report));
    expect(found).toContain('single-run-headline');
    expect(found).toContain('model-claim-without-pins');
    expect(found).toContain('provenance-not-citable');
    expect(found).toContain('headline-not-derived-from-results');
  });
});

describe('a violating report says so in the report', () => {
  it('prints the violation inside limitations, above every number', () => {
    // Rendering runs the gate itself, so there is no way to produce a clean-looking
    // report.md from a violating run short of not using the renderer.
    const report: BenchReport = { ...validReport(), deterministic: false, attempts: 1 };
    const markdown = renderReportMarkdown(report);

    expect(markdown).toContain('must not be published');
    expect(markdown).toContain('single-run-headline');

    const limitationsAt = markdown.indexOf('## Limitations');
    const violationAt = markdown.indexOf('must not be published');
    const resultsAt = markdown.indexOf('## Results');

    expect(limitationsAt).toBeLessThan(violationAt);
    expect(violationAt).toBeLessThan(resultsAt);
  });

  it('says nothing of the kind for a clean report', () => {
    const markdown = renderReportMarkdown(validReport());

    expect(markdown).not.toContain('must not be published');
    expect(markdown).toContain('## Limitations');
  });

  it('still renders a violating report in full, so the evidence survives', () => {
    const report: BenchReport = { ...validReport(), invocation: '' };
    const markdown = renderReportMarkdown(report);

    // Refusing to render would destroy the artifact the policy requires be published.
    expect(markdown).toContain('## Results');
    expect(markdown).toContain('## Negative results');
    expect(markdown).toContain('## Case results');
  });
});
