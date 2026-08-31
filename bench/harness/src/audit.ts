/**
 * `audit.md` — the audit half of a written run.
 *
 * `docs/benchmarks/strategy.md` requires five files beside every report, and this is
 * the fifth: the broken-task audit, and the leakage assertion output.
 *
 * ## Why "not applicable" is the honest content, and not an empty file
 *
 * For `apply-bench` most of what that document asks for genuinely does not apply. The
 * broken-task audit exists because roughly a third of the hardest tasks in
 * circulation are broken rather than hard — a statement about **borrowed** task sets.
 * This suite borrows nothing: its cases are hand-written in this repository, so there
 * is no upstream author to disagree with and no gold patch to verify. The leakage
 * rows are inapplicable for two further reasons: three of them are properties of a
 * container this suite never starts, and the other three assert over a dataset
 * record, an agent payload and a prepared repository that this suite does not have.
 *
 * Both remaining options are worse than saying so. Rendering either audit as though
 * it had been performed produces an artifact that looks checked, which is the failure
 * ADR-0011 is most concerned with. Writing nothing leaves a reader unable to tell a
 * genuine exemption from a file somebody forgot, and an absent `audit.md` and an
 * empty one read identically.
 *
 * ## Why applicability is derived from the report rather than hardcoded
 *
 * `report.ts` writes its limitations from the report's own fields so that it cannot
 * keep claiming to be synthetic-only once a model-driven mode exists. That matters
 * more here: an audit whose whole content is "not applicable" is actively misleading
 * the moment the input source changes. So `inputSource` selects the branch, and a
 * non-synthetic report gets a section saying the audit is owed and that this
 * generator cannot produce it, rather than inheriting a hand-written suite's
 * exemption.
 *
 * ## What this module does not do
 *
 * It renders what is true about a run. It does not gate one, and nothing here should
 * be read as a leakage check having run — see `leakage.ts` for the status of those
 * assertions and `report-policy.ts` for what the publication gate does and does not
 * cover.
 */

import type { BenchReport, Breakdown } from './report-schema.js';
import { formatRate } from './report-schema.js';

/**
 * Validator levels the report schema can carry.
 *
 * Enumerated so the audit can name the levels that did **not** run. That is the part
 * a reader needs: `validator` is a claim about evidence, so a level absent from a run
 * is a level the run says nothing about, and only naming the observed ones would
 * leave that silent. The list is local to `bench/` on purpose — this file reports
 * what it observed against what it knows to look for, and if the applier gains a
 * level without this list growing, the audit under-reports rather than over-reports.
 */
const VALIDATOR_LEVELS: readonly string[] = ['tree-sitter', 'structural', 'none'];

function brokenTaskAudit(report: BenchReport): string[] {
  if (report.inputSource !== 'synthetic') {
    return [
      '## Broken-task audit — required, and not produced here',
      '',
      `This report's input source is \`${report.inputSource}\`, so the exemption a`,
      'hand-written suite earns does not apply: the cases came from somewhere this',
      'generator knows nothing about. The policy requires our own broken-task audit of',
      'the task set actually used, and this generator cannot render one — it can see the',
      'run and not the provenance of its tasks.',
      '',
      '**Complete this section by hand before publishing.** As it stands the report is',
      'incomplete under `docs/benchmarks/strategy.md`.',
      '',
    ];
  }

  return [
    '## Broken-task audit — not applicable',
    '',
    'The policy requires our own broken-task audit of the benchmark being reported on,',
    'because roughly a third of the "hardest" tasks in circulation are broken rather',
    'than hard. That rule is about **borrowed** task sets: an upstream dataset whose',
    'tests do not check what its task description claims.',
    '',
    `This suite borrows nothing. Its ${report.totals.cases} cases are hand-written in this`,
    'repository — each one an input file, an edit, and an expectation stated in the same',
    'file. There is no upstream author to disagree with and no gold patch to verify, so',
    'there is no third-party task set to audit. A case that asserts the wrong thing is a',
    'bug here, fixed by editing the case, rather than a dataset defect to be measured and',
    'then worked around.',
    '',
    '### What stands in for it',
    '',
    'The failure a broken-task audit catches is a task that passes for the wrong reason,',
    'and that failure does have a form here: a case that produces the right output by a',
    'route it was never written to exercise. Cases pin `expect.strategy`, `expect.tier`',
    'and `expect.validator` for exactly that reason, and the runner reports',
    '`wrong-strategy`, `wrong-tier` and `wrong-validator` as outcomes distinct from a',
    'pass rather than folding them in. Those outcomes are in `report.md` and',
    '`result.json` beside this file. A case pinning none of the three asserts only its',
    'output, and is weaker evidence than one that pins them.',
    '',
  ];
}

function leakageAssertions(report: BenchReport): string[] {
  if (report.inputSource !== 'synthetic') {
    return [
      '## Leakage assertions — required, and not produced here',
      '',
      `This report's input source is \`${report.inputSource}\`, so the exemption a`,
      'hand-written suite earns does not hold: a run with a model in it has a payload,',
      'and a payload can leak. The policy requires the leakage audit to be published with',
      'the assertion output, and this generator has none to render — nothing in this run',
      'recorded a call to `checkPromptLeakage` or `checkHistoryIsolation`.',
      '',
      '**Complete this section by hand, with the assertion output, before publishing.**',
      '',
    ];
  }

  return [
    '## Leakage assertions — none applicable',
    '',
    'Six assertions are named in `docs/benchmarks/strategy.md`. None of them applies to',
    'this run, and the two reasons are different enough that the table separates them.',
    '',
    '| Assertion | This run | Why |',
    '| --- | --- | --- |',
    '| Gold-patch fields never reach the prompt | Not applicable — no such input | There is no dataset record and no agent payload. The inputs are hand-written edits held in memory. |',
    '| Test patch absent from the agent payload | Not applicable — no such input | As above: no payload, because there is no agent. |',
    '| Future git history unreachable in the agent repository | Not applicable — no such input | No agent repository and no base commit. The applier is handed file contents, not a checkout. |',
    '| Network egress blocked | Not applicable — unimplemented | No network connection is opened by this suite. |',
    "| Grading only on the committed diff, in a fresh container | Not applicable — unimplemented | No container is started. Grading compares the returned string to the case's own expectation. |",
    '| Report names every task-defining test | Not applicable — unimplemented | There are no task-defining tests; each case carries its own expectation. |',
    '',
    '**The three that are implemented.** `checkPromptLeakage` and',
    '`checkHistoryIsolation` in `bench/harness/src/leakage.ts` cover the first three',
    'rows, and are exercised by unit tests over fixtures: a SWE-bench-shaped record for',
    'the payload rows, and a real git repository built per test for the history row. A',
    'regression in either fails the build. What no benchmark run does is pass its own',
    'data through them — `runner.ts` does not import `leakage.ts`, because this suite has',
    'no record, no payload and no repository to pass. Calling them from a run that has',
    'none of those would return clean every time, which would read as enforcement while',
    'checking nothing. They begin to apply with the first adapter that prepares a task',
    'from a dataset.',
    '',
    '**The other three.** Unimplemented, and properties of a container rather than of',
    'any value this harness can inspect. ADR-0011 assigns the two-container design to',
    'Harbor and rejects building a harness of our own, so these are not work items',
    'sitting unstarted in `bench/`.',
    '',
  ];
}

function refusalReasons(report: BenchReport): string[] {
  const reasons = Object.keys(report.refusalReasons).sort();
  if (reasons.length === 0) {
    return [
      '### Refusal reasons produced',
      '',
      '_No refusals in this run._ Nothing here is evidence about any refusal path.',
      '',
    ];
  }

  return [
    '### Refusal reasons produced',
    '',
    'Which refusals this run actually exercised. A reason absent from this table is a',
    'refusal path the run says nothing about.',
    '',
    '| Reason | Cases |',
    '| --- | --- |',
    ...reasons.map((reason) => `| \`${reason}\` | ${report.refusalReasons[reason] ?? 0} |`),
    '',
  ];
}

function validatorLevels(report: BenchReport): string[] {
  const observed = Object.keys(report.byValidator).sort();
  const rows: string[] = [];
  for (const level of observed) {
    const b: Breakdown | undefined = report.byValidator[level];
    if (b === undefined) continue;
    rows.push(`| \`${level}\` | ${b.total} | ${b.passed} | ${formatRate(b.passRate)} |`);
  }

  const unobserved = VALIDATOR_LEVELS.filter((level) => !observed.includes(level));

  return [
    '### Validator levels that actually ran',
    '',
    '`validator` is a claim about evidence. `tree-sitter` means a real parse happened,',
    '`structural` means the delimiter-and-indentation checker ran, and `none` means the',
    'language was unknown and nothing was checked at all. This table reports the level',
    'that ran, not the level a case hoped for.',
    '',
    ...(rows.length === 0
      ? ['_No case reported a validator level._', '']
      : ['| Level | Cases | Passed | Pass rate |', '| --- | --- | --- | --- |', ...rows, '']),
    ...(unobserved.length === 0
      ? ['Every level the schema can carry was observed in this run.', '']
      : [
          `Not observed in this run: ${unobserved.map((l) => `\`${l}\``).join(', ')}.`,
          'No case reported them, so this run is not evidence about them either way.',
          '',
        ]),
  ];
}

function severeFailures(report: BenchReport): string[] {
  const severe = report.severeFailures;
  if (severe.length === 0) {
    return [
      '### Applied when a refusal was required',
      '',
      'None. Every case that asserts a refusal was refused. This is the corruption class,',
      'and it is the line in this file worth reading if you read only one.',
      '',
    ];
  }

  return [
    '### Applied when a refusal was required',
    '',
    `**${severe.length} case(s) applied an edit that should have been refused.**`,
    '',
    ...severe.map((r) => `- \`${r.id}\`${r.detail === undefined ? '' : ` — ${r.detail}`}`),
    '',
  ];
}

/**
 * `audit.md` for one run.
 *
 * Everything asserted here is either read out of the report or is a statement about
 * what this suite structurally cannot do. Nothing is claimed to have been checked
 * that was not.
 */
export function renderAuditMarkdown(report: BenchReport): string {
  const sections: string[][] = [];

  sections.push([
    `# ${report.suite} — audit`,
    '',
    'Required beside every report by `docs/benchmarks/strategy.md`: the broken-task',
    'audit, and the leakage assertion output.',
    '',
    'Most of what that document asks for does not apply to this run. **Which parts, and',
    'why, is the substance of this file** — an `audit.md` recording a genuine exemption',
    'and one nobody wrote look identical if the exemption is left unstated. The',
    "publication gate's own verdict is not repeated here; it is rendered into",
    '`report.md`, above every number.',
    '',
  ]);

  sections.push(brokenTaskAudit(report));
  sections.push(leakageAssertions(report));

  sections.push([
    '## What this run does establish',
    '',
    'The sections above are a list of things that do not apply. This one is here so the',
    'file cannot be mistaken for one that checked nothing.',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Cases | ${report.totals.cases} |`,
    `| Passed | ${report.totals.passed} |`,
    `| Failed | ${report.totals.failed} |`,
    `| Harness errors | ${report.totals.harnessErrors} |`,
    `| Applied when a refusal was required | ${report.severeFailures.length} |`,
    `| Input source | ${report.inputSource} |`,
    `| Model pins | ${report.models.length === 0 ? 'none recorded' : report.models.join(', ')} |`,
    `| Attempts per case | ${report.attempts} |`,
    `| Harness version | \`${report.harnessVersion}\` |`,
    '',
  ]);

  sections.push(severeFailures(report));
  sections.push(refusalReasons(report));
  sections.push(validatorLevels(report));

  return sections.map((s) => s.join('\n')).join('\n');
}
