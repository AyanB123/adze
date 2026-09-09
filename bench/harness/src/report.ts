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
 *
 * Rendering also validates. `checkReportPolicy` runs on the report here rather than
 * being offered to the caller as an option, so there is no way to produce a
 * `report.md` whose policy violations are not printed inside it, above every number.
 * A caller that wanted a clean-looking report from a violating run would have to
 * stop using this function.
 */

import { checkReportPolicy } from './report-policy.js';
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

  // Above every other caveat, because it is the one that says the rest should not be
  // quoted at all. Deliberately not a separate section: a section could be skipped by
  // a reader who started at the results, and this cannot.
  const policy = checkReportPolicy(report);
  if (!policy.ok) {
    lines.push(
      '**This report violates `docs/benchmarks/strategy.md` and must not be published.**',
      '',
      `${policy.violations.length} violation(s), each naming the rule it breaks:`,
      '',
      ...policy.violations.map((v) => `- \`${v.code}\` — ${v.message}`),
      '',
      'The run was still written out in full, including trajectories for every trial,',
      'because the policy requires that evidence and destroying it to hide a policy',
      'failure would be the worse outcome. `adze-bench` exits non-zero when this',
      'section is present.',
      '',
    );
  }

  if (report.suite === 'index-bench') {
    lines.push(
      '**These numbers measure local retrieval on this machine, not any model.** Every',
      'query is hand-written against a checked-in fixture (`inputSource: synthetic`).',
      'Latency is wall-clock time here and is **not comparable across machines**: the',
      'same queries take different time on different CPUs, disks, and load. The machine,',
      'the fixture digest, and the resource band travel with the numbers in `config.json`',
      'and in Reproduction below — compare pass rates across machines if you like, and do',
      'not compare milliseconds.',
      '',
      '**Precision here is a wiring signal, not a ranking benchmark.** The fixture is a',
      'handful of files with unambiguous symbol names, so literal search answers every',
      'query and the expected precision is 1.0. A drop means lookup broke. Ranking quality',
      'at larger scales does not exist yet (see `docs/roadmap.md` M6).',
      '',
    );
  } else if (report.suite === 'polyglot-bench') {
    lines.push(
      '**These numbers measure edit format, not model behavior.** Every case in this',
      'suite is hand-written: a 40-case subset sampling the shape of the 225-task Aider',
      'Polyglot set, run with no model, no network, and no container (`inputSource:',
      'synthetic`). Nothing here is evidence about how any model formats an edit, and',
      'the per-tier and per-strategy tables below must not be described as "per model"',
      '— there is only one synthetic source of inputs.',
      '',
    );
  } else if (report.inputSource === 'synthetic') {
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
      '**Deterministic, so there is no confidence interval.** ' +
        (report.suite === 'index-bench'
          ? 'The queries make no model calls and retrieval has no sampling, so the pass/fail of each query repeats exactly; latency itself still varies run to run, which is why it is recorded with the machine rather than averaged into an interval. '
          : 'The applier makes no model calls and has no sampling, which means repeating a case produces exactly the same result. ') +
        "ADR-0011's rule of mean ± SEM over at least three attempts exists for stochastic sampling; applying it here would produce a zero-variance interval that looks like rigour and carries no information. Attempts: " +
        `${report.attempts}.`,
      '',
    );
  }

  if (report.suite === 'index-bench') {
    lines.push(
      '**Coverage is eight hand-written queries over eleven fixture files.** A pass rate',
      'of 100% means every query found its expected file, not that retrieval is good.',
      'The fixture is a wiring signal at small scale; ranking quality at larger scales',
      'does not exist yet (see `docs/roadmap.md` M6).',
      '',
      '**Applier tables do not apply here.** The tier, strategy, and validator breakdowns',
      'track `@adze/apply`; this suite records no applier telemetry rather than zeros,',
      'so those tables are empty by design. Per-query precision and latency are in Index',
      'measurements and Case results below.',
      '',
      '**Latency is not comparable across machines.** Durations are wall-clock time on',
      'this machine: the fixture digest and resource band travel with them in Reproduction',
      'below, and no container digest exists. Pass rates do not depend on either.',
      '',
    );
  } else {
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
  }

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
    ...(report.suite === 'polyglot-bench'
      ? [
          `**% well formed: ${formatRate(
            report.totals.cases === 0
              ? null
              : (report.totals.cases - report.totals.harnessErrors) / report.totals.cases,
          )}** (${report.totals.cases - report.totals.harnessErrors}/${report.totals.cases} cases parsed as valid edit blocks).`,
          '',
          'Well formed and pass rate are reported separately: a malformed edit block is a',
          'harness error, never a pass, so a format regression cannot average away into the',
          'pass rate.',
          '',
        ]
      : []),
  ]);

  // Before the ordinary breakdowns: a case that applied when it should have been
  // refused is the corruption class, and it must not sit below a table.
  // Retrieval has no refusal semantics, so the section is stated as inapplicable
  // for index-bench rather than printed as an applier claim.
  const severe = report.severeFailures;
  sections.push(
    report.suite === 'index-bench'
      ? [
          '## Severe failures — not applicable',
          '',
          'Retrieval has no refusal semantics: a query that finds nothing is a miss,',
          'reported as `wrong-output` in Negative results below, not as a refusal.',
          'This section tracks the applier corruption class and does not apply here.',
          '',
        ]
      : [
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
        ],
  );

  if (
    report.metrics !== undefined ||
    report.fixture !== undefined ||
    report.resourceBand !== undefined
  ) {
    const m = report.metrics;
    const f = report.fixture;
    sections.push([
      '## Index measurements',
      '',
      'Wall-clock time on this machine. Not comparable across machines; the fixture',
      'digest and resource band below are what tie these numbers to this run.',
      '',
      ...(m === undefined
        ? ['_No latency metrics recorded._', '']
        : [
            '| Metric | Value |',
            '| --- | --- |',
            `| Cold index (list + first pass) | ${m.coldIndexMs.toFixed(1)} ms |`,
            `| Incremental (one query after one-file touch) | ${m.incrementalMs.toFixed(1)} ms |`,
            `| Mean query (ripgrep + provider) | ${m.meanQueryMs.toFixed(1)} ms |`,
            `| Mean ripgrep | ${m.meanRipgrepMs.toFixed(1)} ms |`,
            `| Mean precision@k | ${(m.meanPrecisionAtK * 100).toFixed(1)}% |`,
            `| Peak RSS | ${m.peakMemoryMb.toFixed(1)} MB |`,
            '',
          ]),
      ...(f === undefined
        ? []
        : [
            `Fixture: \`${f.digest.slice(0, 16)}…\` (${f.files} files, ${f.bytes} bytes, sha256 over paths and bytes).`,
            '',
          ]),
      ...(report.resourceBand === undefined ? [] : [`Resource band: ${report.resourceBand}.`, '']),
    ]);
  }

  sections.push([
    '## Breakdowns',
    '',
    ...(report.suite === 'index-bench'
      ? [
          'The tier, strategy, and validator tables track the applier and are empty for',
          'a retrieval run by design — index results record no applier telemetry rather',
          'than zeros. Per-query precision and latency are in Case results and',
          '`trajectories/`.',
          '',
        ]
      : [
          'Per tier and per strategy. Aggregated over time and across input sources, this is',
          'the "apply success rate per model per tier" metric from `docs/benchmarks/strategy.md`.',
          'For this run the input source is stated in Limitations above.',
          '',
        ]),
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
    ...(report.fixture === undefined
      ? []
      : [
          `| Fixture digest | \`${report.fixture.digest.slice(0, 16)}…\` (${report.fixture.files} files, ${report.fixture.bytes} bytes) |`,
        ]),
    ...(report.resourceBand === undefined ? [] : [`| Resource band | ${report.resourceBand} |`]),
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
  if (report.suite === 'polyglot-bench') {
    const wellFormed = t.cases - t.harnessErrors;
    const rate = t.cases === 0 ? null : wellFormed / t.cases;
    lines.push(`  well formed: ${wellFormed}/${t.cases} (${formatRate(rate)})`);
  }
  if (report.metrics !== undefined) {
    const m = report.metrics;
    lines.push(
      `  precision@k: ${(m.meanPrecisionAtK * 100).toFixed(1)}% | cold ${m.coldIndexMs.toFixed(0)}ms | incremental ${m.incrementalMs.toFixed(0)}ms | rg ${m.meanRipgrepMs.toFixed(1)}ms`,
    );
  }
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
