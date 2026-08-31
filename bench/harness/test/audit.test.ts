/**
 * Tests for `audit.md`.
 *
 * `docs/benchmarks/strategy.md` requires five files beside a report and the harness
 * wrote four, so the first assertion here is simply that the fifth exists. The rest
 * are about its content, and they exist because the failure mode for this particular
 * file is not a crash: it is a file that reads as though an audit was performed. For
 * `apply-bench` almost nothing in the policy's audit applies, so what these tests
 * pin is that every exemption is *stated with its reason* and that none of them is
 * hardcoded — flip `inputSource` and the exemptions have to turn into an obligation.
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderAuditMarkdown } from '../src/audit.js';
import type { BenchReport, CaseResult } from '../src/report-schema.js';
import { loadCases, type RunOutcome, runSuite } from '../src/runner.js';
import { writeRun } from '../src/write-run.js';

const suiteDir = join(import.meta.dirname, '..', '..', 'suites', 'apply-bench');

const scratchDirs: string[] = [];

afterAll(async () => {
  for (const dir of scratchDirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'adze-audit-'));
  scratchDirs.push(dir);
  return dir;
}

/**
 * The suite, run once for the whole file.
 *
 * Memoized rather than re-run per test. The run is deterministic, so every call would
 * produce the same report, and running 51 cases a dozen times inside one file loads
 * the machine enough to time out the git-subprocess tests in `leakage.test.ts` running
 * beside it.
 */
let cachedRun: Promise<RunOutcome> | undefined;

async function realRun(): Promise<RunOutcome> {
  cachedRun ??= (async () => {
    const cases = await loadCases(suiteDir);
    return runSuite(cases, {
      suite: 'apply-bench',
      invocation: 'node bench/harness/bin/adze-bench.mjs apply',
    });
  })();
  return cachedRun;
}

async function realAudit(): Promise<string> {
  return renderAuditMarkdown((await realRun()).report);
}

describe('writeRun', () => {
  it('writes audit.md beside the other four artifacts the policy requires', async () => {
    // The gap this file closes: strategy.md names five files, writeRun emitted four.
    const outcome = await realRun();
    const dir = await scratch();

    const written = await writeRun(outcome, dir);
    const entries = (await readdir(dir)).sort();

    expect(entries).toEqual([
      'audit.md',
      'config.json',
      'report.md',
      'result.json',
      'trajectories',
    ]);
    expect(written.auditPath).toBe(join(dir, 'audit.md'));
    expect((await readFile(written.auditPath, 'utf8')).length).toBeGreaterThan(0);
  });
});

describe('what audit.md declines to claim', () => {
  it('says the broken-task audit does not apply, and why', async () => {
    // Not an empty section and not a fabricated audit. A reader has to be able to tell
    // a genuine exemption from a file nobody wrote.
    const markdown = await realAudit();

    expect(markdown).toContain('Broken-task audit — not applicable');
    expect(markdown).toContain('borrowed');
    expect(markdown).toContain('hand-written in');
    expect(markdown).toContain('no third-party task set to audit');
  });

  it('says every leakage assertion is inapplicable, separating the two reasons', async () => {
    const markdown = await realAudit();

    expect(markdown).toContain('Leakage assertions — none applicable');
    // Implemented but with no input to check, versus not implemented at all. Collapsing
    // the two would hide that three of the six are built and tested.
    expect(markdown).toContain('Not applicable — no such input');
    expect(markdown).toContain('Not applicable — unimplemented');
  });

  it('states plainly that no run passes data through the leakage assertions', async () => {
    // The claim that must not be made anywhere in this artifact is that a leakage check
    // ran. It did not: runner.ts does not import leakage.ts, deliberately.
    const markdown = await realAudit();

    expect(markdown).toContain('runner.ts` does not import `leakage.ts');
    expect(markdown).toContain('would return clean every time');
    expect(markdown).toContain('exercised by unit tests over fixtures');
  });

  it('names the validator levels that did not run', async () => {
    // `validator` is a claim about evidence, so a level with no results is a level this
    // run says nothing about. Naming only the observed levels would leave that silent.
    const markdown = await realAudit();
    const notObserved = markdown
      .split('\n')
      .find((line) => line.startsWith('Not observed in this run:'));

    // Asserted on that line specifically. `tree-sitter` also appears in the paragraph
    // explaining what the levels mean, so a whole-document match would pass either way.
    expect(notObserved).toBeDefined();
    expect(notObserved).toContain('`tree-sitter`');
    expect(markdown).toContain('not evidence about them either way');
  });
});

describe('what audit.md does establish', () => {
  it('reports the case count, and it agrees with the report', async () => {
    const { report } = await realRun();
    const markdown = renderAuditMarkdown(report);

    expect(markdown).toContain(`| Cases | ${report.totals.cases} |`);
    expect(markdown).toContain(`| Passed | ${report.totals.passed} |`);
    expect(markdown).toContain(`| Harness errors | ${report.totals.harnessErrors} |`);
  });

  it('reports the refusal-reason distribution', async () => {
    const { report } = await realRun();
    const markdown = renderAuditMarkdown(report);
    const reasons = Object.keys(report.refusalReasons);

    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(markdown).toContain(`| \`${reason}\` | ${report.refusalReasons[reason] ?? 0} |`);
    }
  });

  it('reports which validator levels actually ran', async () => {
    const { report } = await realRun();
    const markdown = renderAuditMarkdown(report);

    expect(markdown).toContain('Validator levels that actually ran');
    for (const level of Object.keys(report.byValidator)) {
      expect(markdown).toContain(`| \`${level}\` |`);
    }
  });

  it('reports the severe-failure count, above the ordinary tables', async () => {
    const { report } = await realRun();
    const markdown = renderAuditMarkdown(report);

    expect(report.severeFailures).toEqual([]);
    expect(markdown).toContain('| Applied when a refusal was required | 0 |');
    expect(markdown).toContain('Every case that asserts a refusal was refused');
    expect(markdown.indexOf('Applied when a refusal was required')).toBeLessThan(
      markdown.indexOf('Refusal reasons produced'),
    );
  });

  it('lists a severe failure rather than reporting none', async () => {
    // The branch that matters. A file claiming "every case that asserts a refusal was
    // refused" when one was not is the worst output this generator could produce.
    const { report } = await realRun();
    const first = report.results[0];
    if (first === undefined) throw new Error('the suite produced no results');
    const severe: CaseResult = {
      ...first,
      id: 'invented-severe-case',
      outcome: 'unexpected-success',
      detail: 'expected refusal, the edit applied',
    };
    const markdown = renderAuditMarkdown({ ...report, severeFailures: [severe] });

    expect(markdown).toContain('1 case(s) applied an edit that should have been refused');
    expect(markdown).toContain('invented-severe-case');
    expect(markdown).not.toContain('Every case that asserts a refusal was refused');
  });
});

describe('the exemptions are derived from the report, not hardcoded', () => {
  async function nonSynthetic(): Promise<string> {
    const { report } = await realRun();
    const model: BenchReport = {
      ...report,
      inputSource: 'model',
      models: ['some-model-2026-08-31'],
    };
    return renderAuditMarkdown(model);
  }

  it('turns both exemptions into obligations once the input source is not synthetic', async () => {
    // An audit whose whole content is "not applicable" is actively misleading the moment
    // the input source changes, so the branch is keyed on the report's own field. This is
    // the same reason report.ts writes its limitations from the report rather than as
    // fixed prose.
    const markdown = await nonSynthetic();

    expect(markdown).toContain('Broken-task audit — required, and not produced here');
    expect(markdown).toContain('Leakage assertions — required, and not produced here');
    expect(markdown).toContain('Complete this section by hand');
    expect(markdown).toContain('incomplete under `docs/benchmarks/strategy.md`');
  });

  it('drops the not-applicable claims entirely in that case', async () => {
    const markdown = await nonSynthetic();

    expect(markdown).not.toMatch(/not applicable/i);
    expect(markdown).not.toContain('no third-party task set to audit');
  });

  it('records the model pins it was given', async () => {
    const markdown = await nonSynthetic();
    expect(markdown).toContain('| Model pins | some-model-2026-08-31 |');
  });
});
