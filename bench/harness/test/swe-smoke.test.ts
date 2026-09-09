/**
 * Tests for the `swe-smoke` wiring check.
 *
 * Twenty-five placeholders exercise the Tier-1 pipeline while Tier-2 waits on
 * Harbor, a dataset, and a container runtime. What is pinned here is the whole
 * point of the suite: the cases pass, and the report is still refused for
 * publication — a wiring check whose report could pass the gate would become a
 * result the first time someone quoted it.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderAuditMarkdown } from '../src/audit.js';
import { renderReportMarkdown } from '../src/report.js';
import { checkReportPolicy } from '../src/report-policy.js';
import { loadCases, runSuite } from '../src/runner.js';

const suiteDir = join(import.meta.dirname, '..', '..', 'suites', 'swe-smoke');

describe('the committed swe-smoke suite', () => {
  it('loads exactly 25 wiring cases', async () => {
    const cases = await loadCases(suiteDir);
    expect(cases.length).toBe(25);
    expect(new Set(cases.map((c) => c.id)).size).toBe(25);
    for (const bench of cases) {
      expect(bench.tags).toContain('swe-smoke');
      expect(bench.tags).toContain('wiring-check');
    }
  });

  it('passes end to end — the wiring works', async () => {
    const cases = await loadCases(suiteDir);
    const { report, trajectories } = await runSuite(cases, {
      suite: 'swe-smoke',
      invocation: 'vitest',
    });
    expect(trajectories.length).toBe(cases.length);
    expect(report.severeFailures).toEqual([]);
    expect(report.results.filter((r) => r.outcome !== 'pass')).toEqual([]);
    expect(report.totals.passRate).toBe(1);
  });

  it('is refused publication even though every case passes', async () => {
    const cases = await loadCases(suiteDir);
    const { report } = await runSuite(cases, { suite: 'swe-smoke', invocation: 'vitest' });
    const check = checkReportPolicy(report);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.violations.map((v) => v.code)).toContain('wiring-check-not-publishable');
  });

  it('prints the refusal above every number', async () => {
    const cases = await loadCases(suiteDir);
    const { report } = await runSuite(cases, { suite: 'swe-smoke', invocation: 'vitest' });
    const markdown = renderReportMarkdown(report);
    expect(markdown).toContain('wiring-check-not-publishable');
    expect(markdown).toContain('must not be published');
    expect(markdown).toContain('never be published');
    const limitationsAt = markdown.indexOf('## Limitations');
    const violationAt = markdown.indexOf('wiring-check-not-publishable');
    const resultsAt = markdown.indexOf('## Results');
    expect(limitationsAt).toBeLessThan(violationAt);
    expect(violationAt).toBeLessThan(resultsAt);
  });

  it('says in the audit that these are placeholders, not SWE-bench tasks', async () => {
    const cases = await loadCases(suiteDir);
    const { report } = await runSuite(cases, { suite: 'swe-smoke', invocation: 'vitest' });
    expect(renderAuditMarkdown(report)).toContain('not SWE-bench tasks');
  });
});

describe('the wiring-check refusal', () => {
  it('fires on the suite name, not on the case results', async () => {
    // A hand-edited result.json that renames the suite escapes the refusal — and
    // should, because it is then no longer presented as the smoke slice. What must
    // not happen is a swe-smoke report passing the gate while named as one.
    const cases = await loadCases(suiteDir);
    const { report } = await runSuite(cases, { suite: 'swe-smoke', invocation: 'vitest' });
    expect(checkReportPolicy({ ...report, suite: 'apply-bench' }).ok).toBe(true);
  });
});
