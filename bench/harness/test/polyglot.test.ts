/**
 * Tests for `polyglot-bench` edit-format helpers and the committed 40-case subset.
 *
 * The subset samples the 225-task Aider Polyglot shape at a size that fits a
 * pull-request gate: deterministic, no model, no network, no container. What is
 * pinned here is that the suite loads 40 well-formed cases, passes end to end,
 * and reports `% well formed` alongside the pass rate while stating plainly that
 * it measures edit format rather than model behavior.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isWellFormedCase,
  POLYGLOT_SUBSET_SIZE,
  POLYGLOT_UPSTREAM_TOTAL,
  parseFencedEdits,
  renderFencedEdits,
  wellFormedSummary,
} from '../src/polyglot.js';
import { renderConsoleSummary, renderReportMarkdown } from '../src/report.js';
import { loadCases, runSuite } from '../src/runner.js';

const suiteDir = join(import.meta.dirname, '..', '..', 'suites', 'polyglot-bench');

describe('fenced edit format', () => {
  it('round-trips a single edit', () => {
    const rendered = renderFencedEdits('src/a.ts', [
      { search: 'const a = 1;', replace: 'const a = 2;' },
    ]);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const parsed = parseFencedEdits(rendered.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.path).toBe('src/a.ts');
    expect(parsed.edits).toEqual([{ search: 'const a = 1;', replace: 'const a = 2;' }]);
  });

  it('refuses to render without a path or without edits', () => {
    expect(renderFencedEdits('', [{ search: 'a', replace: 'b' }]).ok).toBe(false);
    expect(renderFencedEdits('src/a.ts', []).ok).toBe(false);
  });

  it('refuses to render content containing a marker line', () => {
    // Emitting a block whose content collides with the format markers would parse
    // back differently, so rendering refuses rather than producing ambiguity.
    const rendered = renderFencedEdits('src/a.ts', [{ search: '---search---', replace: 'b' }]);
    expect(rendered.ok).toBe(false);
  });

  it('refuses a block missing its opening fence', () => {
    expect(parseFencedEdits('no fences here').ok).toBe(false);
  });

  it('refuses a block missing its path', () => {
    expect(
      parseFencedEdits('```edit\n---search---\na\n---replace---\nb\n---end---\n```\n').ok,
    ).toBe(false);
  });

  it('refuses a block whose search text never terminates', () => {
    expect(parseFencedEdits('```edit src/a.ts\n---search---\na\n').ok).toBe(false);
  });

  it('refuses a block whose replace text never terminates', () => {
    expect(parseFencedEdits('```edit src/a.ts\n---search---\na\n---replace---\nb\n').ok).toBe(
      false,
    );
  });

  it('refuses trailing content after the closing fence', () => {
    const rendered = renderFencedEdits('src/a.ts', [{ search: 'a', replace: 'b' }]);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(parseFencedEdits(`${rendered.text}extra line\n`).ok).toBe(false);
  });
});

describe('well-formedness', () => {
  it('names the upstream total and the committed subset size', () => {
    expect(POLYGLOT_UPSTREAM_TOTAL).toBe(225);
    expect(POLYGLOT_SUBSET_SIZE).toBe(40);
  });

  it('rates an empty set as null rather than as a failure', () => {
    expect(wellFormedSummary([]).wellFormedRate).toBe(null);
  });
});

describe('the committed polyglot-bench suite', () => {
  it('loads exactly the 40-case subset', async () => {
    const cases = await loadCases(suiteDir);
    expect(cases.length).toBe(POLYGLOT_SUBSET_SIZE);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('finds every case well formed', async () => {
    const cases = await loadCases(suiteDir);
    const summary = wellFormedSummary(cases);
    expect(summary.wellFormed).toBe(summary.total);
    expect(summary.wellFormedRate).toBe(1);
    for (const bench of cases) {
      expect(isWellFormedCase(bench), bench.id).toBe(true);
    }
  });

  it('covers at least five languages', async () => {
    const cases = await loadCases(suiteDir);
    const languages = new Set(cases.map((c) => c.path.split('.').pop()));
    expect(languages.size).toBeGreaterThanOrEqual(5);
  });

  it('passes end to end', async () => {
    const cases = await loadCases(suiteDir);
    const { report } = await runSuite(cases, { suite: 'polyglot-bench', invocation: 'vitest' });
    expect(report.severeFailures).toEqual([]);
    expect(report.results.filter((r) => r.outcome !== 'pass')).toEqual([]);
    expect(report.totals.passRate).toBe(1);
  });

  it('states edit format rather than the applier in its limitations', async () => {
    const cases = await loadCases(suiteDir);
    const { report } = await runSuite(cases, { suite: 'polyglot-bench', invocation: 'vitest' });
    const markdown = renderReportMarkdown(report);
    expect(markdown).toContain('measure edit format, not model behavior');
    expect(markdown).toContain('40-case subset');
    expect(markdown).toContain('225');
    expect(markdown.indexOf('## Limitations')).toBeLessThan(markdown.search(/\d+\.\d%/));
  });

  it('reports percent well formed alongside the pass rate', async () => {
    const cases = await loadCases(suiteDir);
    const { report } = await runSuite(cases, { suite: 'polyglot-bench', invocation: 'vitest' });
    const markdown = renderReportMarkdown(report);
    expect(markdown).toContain('% well formed');
    const summary = renderConsoleSummary(report);
    expect(summary).toContain('well formed');
  });
});
