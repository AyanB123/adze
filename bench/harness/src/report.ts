/**
 * Report rendering.
 *
 * `docs/benchmarks/strategy.md` requires that `report.md` lead with limitations
 * rather than with the headline number, and ADR-0011 goes further: if the code
 * writes the report, the limitations section is emitted first as a *property of the
 * generator* rather than of the author's discipline.
 *
 * So `renderReportMarkdown` assembles an ordered list of sections in which
 * limitations is index 0 and no number can be printed above it. There is no
 * parameter that reorders them, and `test/apply-bench.test.ts` asserts that the
 * limitations heading precedes the first percentage in the output. Getting the
 * headline number to the top would take a deliberate edit to this file plus
 * deleting that test, which is the point.
 */

import type { BenchReport, Breakdown, CaseResult } from './report-schema.js';
import { formatRate } from './report-schema.js';

function table(title: string, rows: Readonly<Record<string, Breakdown>>): string[] {
  const keys = Object.keys(rows).sort();
  if (keys.length === 0) return [`### ${title}`, '', '_No data._', ''];

  const lines = [
    `### ${title}`,
    '',
    '| Key | Cases | Passed | Pass rate |',
    '| --- | --- | --- | --- |',
  ];
  for (const key of keys) {
    const b = rows[key];
    if (b === undefined) continue;
    lines.push(`| \`${key}\` | ${b.total} | ${b.passed} | ${formatRate(b.passRate)} |`);
  }
  lines.push('');
  return lines;
}

function caseLine(r: CaseResult): string {
  const detail = r.detail === undefined ? '' : ` — ${r.detail}`;
  return `- \`${r.id}\` (${r.outcome})${detail}`;
}

/**
 * The limitations section.
 *
 * Written from the report's own fields rather than as fixed prose, so that it
 * cannot claim to be synthetic-only once a model-driven mode exists.
 */
function limitations(report: BenchReport): string[] {
  const lines = ['## Limitations', ''];

  if (report.inputSource === 'synthetic') {
    lines.push(
      '**These numbers measure the applier, not any model.** Every case in this suite',
      'is hand-written. Nothing here is evidence about how any model formats an edit,',
      'and the per-tier and per-strategy tables below must not be described as',
      '"per model" — there is only one synthetic source of inputs.',
      '',
    );
  } else {
    lines.push(
      `**Input source: ${report.inputSource}.** Model pins: ${
        report.models.length === 0 ? 'none recorded' : report.models.join(', ')
      }.`,
      '',
    );
  }

  if (report.deterministic) {
    lines.push(
      '**Deterministic, so there is no confidence interval.** The applier makes no',
      'model calls and has no sampling, which means repeating a case produces exactly',
      "the same result. ADR-0011's rule of mean ± SEM over at least three attempts",
      'exists for stochastic sampling; applying it here would produce a zero-variance',
      'interval that looks like rigour and carries no information. Attempts: ' +
        `${report.attempts}.`,
      '',
    );
  }

  lines.push(
    '**Coverage is what someone thought to write down.** A pass rate of 100% means',
    'every case we have encoded passes, not that the applier is correct. The suite',
    'grows one real failure at a time — see `.github/ISSUE_TEMPLATE/apply_failure.yml`.',
    '',
    '**The structural validator is not a parser.** With no tree-sitter grammars',
    'present, validation is a delimiter-and-indentation check. The `byValidator`',
    'table below reports which level actually ran for each case, and a case validated',
    'by `none` was not checked at all.',
    '',
    '**Not comparable across machines as a latency measurement.** Durations are',
    'included for orientation only. No resource band is pinned, no container digest',
    'exists, and pass rates in this suite do not depend on either.',
    '',
  );

  return lines;
}

export function renderReportMarkdown(report: BenchReport): string {
  const sections: string[][] = [];

  sections.push([`# ${report.suite}`, '', `Harness \`${report.harnessVersion}\`.`, '']);

  // Index 0 among the content sections, before any number. Not configurable.
  sections.push(limitations(report));

  sections.push([
    '## Results',
    '',
    `| Cases | Passed | Failed | Harness errors | Pass rate |`,
    '| --- | --- | --- | --- | --- |',
    `| ${report.totals.cases} | ${report.totals.passed} | ${report.totals.failed} | ${report.totals.harnessErrors} | ${formatRate(report.totals.passRate)} |`,
    '',
  ]);

  // Before the ordinary breakdowns: a case that applied when it should have been
  // refused is the corruption class, and it must not sit below a table.
  const severe = report.severeFailures;
  sections.push([
    '## Severe failures — applied when a refusal was required',
    '',
    ...(severe.length === 0
      ? [
          'None. Every case that asserts a refusal was refused.',
          '',
          'This is the line to read first in this report. A case here means the applier',
          'wrote a file it was supposed to decline, which is the failure users actually',
          'feel.',
          '',
        ]
      : [
          `**${severe.length} case(s) applied an edit that should have been refused.**`,
          '',
          ...severe.map(caseLine),
          '',
        ]),
  ]);

  sections.push([
    '## Breakdowns',
    '',
    'Per tier and per strategy. Aggregated over time and across input sources, this is',
    'the "apply success rate per model per tier" metric from `docs/benchmarks/strategy.md`.',
    'For this run the input source is stated in Limitations above.',
    '',
    ...table('By tier', report.byTier),
    ...table('By match strategy', report.byStrategy),
    ...table('By validator level', report.byValidator),
    ...table('By tag', report.byTag),
  ]);

  const reasons = Object.keys(report.refusalReasons).sort();
  sections.push([
    '### Refusal reasons produced',
    '',
    ...(reasons.length === 0
      ? ['_No refusals in this run._', '']
      : [
          '| Reason | Count |',
          '| --- | --- |',
          ...reasons.map((r) => `| \`${r}\` | ${report.refusalReasons[r] ?? 0} |`),
          '',
        ]),
  ]);

  const failures = report.results.filter(
    (r) => r.outcome !== 'pass' && r.outcome !== 'unexpected-success',
  );
  sections.push([
    '## Negative results',
    '',
    `Harness errors: ${report.totals.harnessErrors}. Failing cases: ${failures.length}.`,
    '',
    ...(failures.length === 0
      ? ['No failures besides any listed above.', '']
      : [...failures.map(caseLine), '']),
  ]);

  sections.push([
    '## Reproduction',
    '',
    '```',
    report.invocation,
    '```',
    '',
    `| Field | Value |`,
    '| --- | --- |',
    `| Harness version | \`${report.harnessVersion}\` |`,
    `| Report schema | \`${report.schemaVersion}\` |`,
    `| Started | ${report.startedAt} |`,
    `| Finished | ${report.finishedAt} |`,
    `| Duration | ${report.durationMs.toFixed(0)} ms |`,
    `| Node | ${report.environment.node} |`,
    `| Platform | ${report.environment.platform} ${report.environment.arch} |`,
    `| Input source | ${report.inputSource} |`,
    `| Attempts per case | ${report.attempts} |`,
    '',
    'Per-case inputs, outputs, and telemetry are in `trajectories/`, for every case',
    'including the ones that failed.',
    '',
  ]);

  sections.push([
    '## Case results',
    '',
    '| Case | Outcome | Tier | Strategy | Validator |',
    '| --- | --- | --- | --- | --- |',
    ...report.results.map((r) => {
      const a = r.actual;
      return `| \`${r.id}\` | ${r.outcome} | ${a?.tier ?? '—'} | ${a?.strategy ?? '—'} | ${a?.validator ?? '—'} |`;
    }),
    '',
  ]);

  return sections.map((s) => s.join('\n')).join('\n');
}

/** Short human summary for the terminal. Never the report itself. */
export function renderConsoleSummary(report: BenchReport): string {
  const t = report.totals;
  const lines = [`${report.suite}: ${t.passed}/${t.cases} passed (${formatRate(t.passRate)})`];
  if (report.severeFailures.length > 0) {
    lines.push(`  ${report.severeFailures.length} SEVERE: applied an edit that required a refusal`);
  }
  if (t.harnessErrors > 0) lines.push(`  ${t.harnessErrors} harness error(s)`);
  for (const r of report.results) {
    if (r.outcome === 'pass') continue;
    lines.push(
      `  ${r.outcome.padEnd(19)} ${r.id}${r.detail === undefined ? '' : ` — ${r.detail}`}`,
    );
  }
  return lines.join('\n');
}
