/**
 * `nep-bench` — the mined next-edit prototype.
 *
 * Every assertion here pins the honesty properties, not just the wiring: the
 * set stays in its 20–40 cap, every case carries re-derivable provenance, the
 * summary agrees with the artifact beside it, and the rendered report leads
 * with limitations and refuses to read as a model measurement. If the suite
 * outgrows any of these (a model loop, refusal cases, a second dataset), the
 * failing test names the doc to update alongside the code.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderAuditMarkdown } from '../src/audit.js';
import {
  checkNepSummary,
  hasNepProvenance,
  languageBreakdown,
  NEP_SUITE,
  NEP_V0_MAX_CASES,
  NEP_V0_MIN_CASES,
  renderNepSummary,
  summarizeNep,
} from '../src/nep.js';
import { renderReportMarkdown } from '../src/report.js';
import { loadCases, runSuite } from '../src/runner.js';

const suiteDir = join(import.meta.dirname, '..', '..', 'suites', 'nep-bench');

describe('the committed nep-bench prototype set', () => {
  it('stays in its capped v0 window', async () => {
    const cases = await loadCases(suiteDir);
    expect(cases.length).toBeGreaterThanOrEqual(NEP_V0_MIN_CASES);
    expect(cases.length).toBeLessThanOrEqual(NEP_V0_MAX_CASES);
  });

  it('gives every case a unique id', async () => {
    const cases = await loadCases(suiteDir);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('records commit SHA, file, and language on every case', async () => {
    // The SHA makes the pair re-derivable from history; without it the
    // "mined" claim is uncheckable.
    const cases = await loadCases(suiteDir);
    for (const bench of cases) {
      expect(hasNepProvenance(bench), `${bench.id} is missing mined provenance`).toBe(true);
    }
  });

  it('is TypeScript-heavy with a mixed tail', async () => {
    const cases = await loadCases(suiteDir);
    const languages = new Set(
      cases.map((c) => c.tags?.find((t) => t !== 'nep' && t !== 'mined' && t !== 'test')),
    );
    expect(languages.has('typescript')).toBe(true);
    expect(languages.size).toBeGreaterThanOrEqual(2);
    const typescript = cases.filter((c) => c.tags?.includes('typescript')).length;
    expect(typescript).toBeGreaterThan(cases.length / 3);
  });

  it('is output-only in v0, so the severe class is knowingly unexercised', async () => {
    // Pinning this forces the day refusal cases arrive to land as an explicit
    // test edit — alongside updating the "unexercised" prose in report.ts and
    // audit.ts that this test also asserts below.
    const cases = await loadCases(suiteDir);
    for (const bench of cases) {
      expect(bench.expect.kind).toBe('output');
    }
  });
});

describe('nep scoring over a finished run', () => {
  it('reconstructs every mined hunk end to end', async () => {
    const cases = await loadCases(suiteDir);
    const { report } = await runSuite(cases, {
      suite: NEP_SUITE,
      invocation: 'vitest',
    });
    expect(
      report.severeFailures.map((f) => `${f.id}: ${f.detail ?? ''}`),
      'applied an edit that required a refusal',
    ).toEqual([]);
    expect(
      report.results.filter((r) => r.outcome !== 'pass').map((r) => `${r.id}: ${r.detail ?? ''}`),
    ).toEqual([]);
    expect(report.totals.passRate).toBe(1);
  });

  it('summarizes exact match, parse validity, and per-language rows', async () => {
    const cases = await loadCases(suiteDir);
    const outcome = await runSuite(cases, { suite: NEP_SUITE, invocation: 'vitest' });
    const summary = summarizeNep(outcome.report);
    expect(summary.cases).toBe(cases.length);
    expect(summary.exactMatchRate).toBe(1);
    expect(summary.severeFailures).toBe(0);
    expect(checkNepSummary(outcome, summary)).toEqual([]);
    const counted = Object.values(summary.byLanguage).reduce((sum, b) => sum + b.total, 0);
    expect(counted).toBe(cases.length);
    // Keyed by what the validator saw (`detectLanguage` reports the file
    // extension), not by the miner's display names in tags.
    expect(Object.keys(summary.byLanguage)).toContain('ts');
  });

  it('groups the per-language breakdown from the detected language', async () => {
    const cases = await loadCases(suiteDir);
    const { report } = await runSuite(cases, { suite: NEP_SUITE, invocation: 'vitest' });
    const byLanguage = languageBreakdown(report);
    // Grouped from `result.language` — the value the validator saw — so a case
    // cannot claim a language its path does not detect as.
    for (const result of report.results) {
      expect(byLanguage[result.language]?.total).toBeGreaterThan(0);
    }
    expect(renderNepSummary(summarizeNep(report))).toContain('ts');
  });

  it('writes a trajectory for every case, failures included', async () => {
    const cases = await loadCases(suiteDir);
    const { trajectories } = await runSuite(cases, { suite: NEP_SUITE, invocation: 'vitest' });
    expect(trajectories.length).toBe(cases.length);
  });
});

describe('nep report honesty', () => {
  async function markdown(): Promise<string> {
    const cases = await loadCases(suiteDir);
    const outcome = await runSuite(cases, {
      suite: NEP_SUITE,
      invocation: 'node bench/harness/bin/adze-bench.mjs nep',
    });
    return renderReportMarkdown(outcome.report);
  }

  it('puts limitations before the first number', async () => {
    const text = await markdown();
    const limitationsAt = text.indexOf('## Limitations');
    const firstPercentage = text.search(/\d+\.\d%/);
    expect(limitationsAt).toBeGreaterThan(-1);
    expect(firstPercentage).toBeGreaterThan(-1);
    expect(limitationsAt).toBeLessThan(firstPercentage);
  });

  it('states the distribution and refuses a model reading', async () => {
    const text = await markdown();
    expect(text).toContain('given the');
    expect(text).toContain('true edit');
    expect(text).toContain('not model behavior');
    expect(text).toContain('single-next-edit');
    expect(text).toContain('must not be described');
  });

  it('marks the severe class unexercised rather than covered', async () => {
    const text = await markdown();
    expect(text).toContain('unexercised rather than covered');
  });

  it('audits the mined set instead of claiming a borrowed-set audit', async () => {
    const cases = await loadCases(suiteDir);
    const outcome = await runSuite(cases, { suite: NEP_SUITE, invocation: 'vitest' });
    const audit = renderAuditMarkdown(outcome.report);
    expect(audit).toContain('EXCLUDED_IDS');
    expect(audit).toContain('commit SHA');
  });
});
