import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CaseFormatError, parseCase, parseCaseFile, renderText } from '../src/case-schema.js';
import { renderReportMarkdown } from '../src/report.js';
import { loadCases, runCase, runSuite } from '../src/runner.js';

const suiteDir = join(import.meta.dirname, '..', '..', 'suites', 'apply-bench');

describe('case text', () => {
  it('uses a string verbatim', () => {
    expect(renderText('a\nb\n')).toBe('a\nb\n');
  });

  it('joins an array with newlines and adds nothing', () => {
    // No implicit trailing newline. Whether a file ends with one changes what the
    // applier matches, so a format that inserted one would make some real failures
    // unreproducible. A final "" element is how a case asks for it.
    expect(renderText(['a', 'b'])).toBe('a\nb');
    expect(renderText(['a', 'b', ''])).toBe('a\nb\n');
  });
});

describe('case format validation', () => {
  const valid = {
    id: 'x',
    description: 'd',
    path: 'a.ts',
    original: 'a',
    edits: [{ search: 'a', replace: 'b' }],
    expect: { kind: 'output', content: 'b' },
  };

  it('accepts a minimal valid case', () => {
    expect(parseCase(valid, 'f.json', 0).id).toBe('x');
  });

  it('names the case and the file in an error', () => {
    // A contributor transcribing a real failure gets one field wrong. The message
    // has to say which field, in which case, in which file.
    expect(() => parseCase({ ...valid, path: '' }, 'f.json', 0)).toThrow(/f\.json \[x\]/);
    expect(() => parseCase({ ...valid, edits: 'nope' }, 'f.json', 0)).toThrow(/'edits' must be/);
  });

  it('requires content for an output expectation', () => {
    expect(() => parseCase({ ...valid, expect: { kind: 'output' } }, 'f.json', 0)).toThrow(
      /expect\.content is required/,
    );
  });

  it('requires a known reason for a refusal expectation', () => {
    expect(() => parseCase({ ...valid, expect: { kind: 'refusal' } }, 'f.json', 0)).toThrow(
      /expect\.reason is required/,
    );
    expect(() =>
      parseCase({ ...valid, expect: { kind: 'refusal', reason: 'made-up' } }, 'f.json', 0),
    ).toThrow(/expect\.reason/);
  });

  it('rejects content on a refusal expectation', () => {
    // Otherwise a case looks like it asserted the file was unchanged when it
    // asserted nothing at all.
    expect(() =>
      parseCase(
        { ...valid, expect: { kind: 'refusal', reason: 'ambiguous', content: 'a' } },
        'f.json',
        0,
      ),
    ).toThrow(/meaningless/);
  });

  it('rejects an unknown strategy or tier', () => {
    expect(() =>
      parseCase({ ...valid, expect: { kind: 'output', content: 'b', strategy: 'fuzzy' } }, 'f', 0),
    ).toThrow(/expect\.strategy/);
    expect(() =>
      parseCase({ ...valid, expect: { kind: 'output', content: 'b', tier: 'magic' } }, 'f', 0),
    ).toThrow(/expect\.tier/);
  });

  it('rejects a file that is not an object with a cases array', () => {
    expect(() => parseCaseFile('[]', 'f.json')).toThrow(CaseFormatError);
    expect(() => parseCaseFile('not json', 'f.json')).toThrow(/not valid JSON/);
  });
});

describe('the committed apply-bench suite', () => {
  it('loads, and every case parses', async () => {
    const cases = await loadCases(suiteDir);
    // The suite is required to be substantial: coverage is what someone thought to
    // write down, so a suite that shrank silently would be a real regression.
    expect(cases.length).toBeGreaterThanOrEqual(25);
  });

  it('gives every case a unique id', async () => {
    const cases = await loadCases(suiteDir);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('covers all four match strategies explicitly', async () => {
    // A case that merely produces the right answer does not prove which strategy
    // produced it. These assertions are what keep the per-strategy breakdown honest.
    const cases = await loadCases(suiteDir);
    const asserted = new Set<string>(
      cases.map((c) => c.expect.strategy).filter((s) => s !== undefined),
    );
    for (const strategy of ['exact', 'whitespace-normalized', 'indentation-tolerant', 'anchored']) {
      expect(asserted.has(strategy), `no case asserts strategy '${strategy}'`).toBe(true);
    }
  });

  it('covers every refusal reason', async () => {
    const cases = await loadCases(suiteDir);
    const reasons = new Set<string>(
      cases.map((c) => c.expect.reason).filter((r) => r !== undefined),
    );
    for (const reason of [
      'not-found',
      'ambiguous',
      'parse-broken',
      'file-too-large',
      'tier-unavailable',
      'no-op',
    ]) {
      expect(reasons.has(reason), `no case asserts refusal '${reason}'`).toBe(true);
    }
  });

  it('passes end to end', async () => {
    const cases = await loadCases(suiteDir);
    const { report } = await runSuite(cases, { suite: 'apply-bench', invocation: 'vitest' });

    // The severe class first: a case written to be refused that instead applied
    // means the applier wrote a file it was supposed to decline.
    expect(
      report.severeFailures.map((f) => `${f.id}: ${f.detail ?? ''}`),
      'applied an edit that required a refusal',
    ).toEqual([]);
    expect(
      report.results.filter((r) => r.outcome !== 'pass').map((r) => `${r.id}: ${r.detail ?? ''}`),
    ).toEqual([]);
    expect(report.totals.passRate).toBe(1);
  });

  it('produces per-tier and per-strategy breakdowns', async () => {
    const cases = await loadCases(suiteDir);
    const { report } = await runSuite(cases, { suite: 'apply-bench', invocation: 'vitest' });

    expect(Object.keys(report.byTier)).toContain('search-replace');
    expect(Object.keys(report.byTier)).toContain('whole-file');
    expect(Object.keys(report.byStrategy)).toContain('exact');
    expect(Object.keys(report.byStrategy)).toContain('indentation-tolerant');
    expect(Object.keys(report.byStrategy)).toContain('anchored');
    expect(Object.keys(report.byValidator)).toContain('structural');
    expect(Object.keys(report.byValidator)).toContain('none');
  });

  it('writes a trajectory for every case, failures included', async () => {
    const cases = await loadCases(suiteDir);
    const { trajectories } = await runSuite(cases, { suite: 'apply-bench', invocation: 'vitest' });
    expect(trajectories.length).toBe(cases.length);
  });
});

describe('classification', () => {
  async function outcomeOf(over: Record<string, unknown>): Promise<string> {
    const base = {
      id: 't',
      file: 'inline',
      description: 'd',
      path: 'a.ts',
      original: 'const a = 1;\n',
      edits: [{ search: 'const a = 1;', replace: 'const a = 2;' }],
      expect: { kind: 'output' as const, content: 'const a = 2;\n' },
    };
    const { result } = await runCase({ ...base, ...over } as Parameters<typeof runCase>[0]);
    return result.outcome;
  }

  it('passes when the output matches', async () => {
    expect(await outcomeOf({})).toBe('pass');
  });

  it('reports wrong-output on a content mismatch', async () => {
    expect(await outcomeOf({ expect: { kind: 'output', content: 'const a = 3;\n' } })).toBe(
      'wrong-output',
    );
  });

  it('reports unexpected-refusal when a valid edit was rejected', async () => {
    expect(
      await outcomeOf({
        edits: [{ search: 'not present', replace: 'x' }],
        expect: { kind: 'output', content: 'const a = 1;\n' },
      }),
    ).toBe('unexpected-refusal');
  });

  it('reports unexpected-success when a required refusal applied', async () => {
    // The severe class. Separated from ordinary failures because this is the one
    // that corrupts a file.
    expect(await outcomeOf({ expect: { kind: 'refusal', reason: 'ambiguous' } })).toBe(
      'unexpected-success',
    );
  });

  it('reports wrong-reason when refused for a different reason', async () => {
    expect(
      await outcomeOf({
        edits: [{ search: 'not present', replace: 'x' }],
        expect: { kind: 'refusal', reason: 'ambiguous' },
      }),
    ).toBe('wrong-reason');
  });

  it('reports wrong-strategy even when the output is right', async () => {
    expect(
      await outcomeOf({
        expect: { kind: 'output', content: 'const a = 2;\n', strategy: 'anchored' },
      }),
    ).toBe('wrong-strategy');
  });

  it('reports wrong-validator, so a case cannot silently stop checking evidence', async () => {
    expect(
      await outcomeOf({
        expect: { kind: 'output', content: 'const a = 2;\n', validator: 'tree-sitter' },
      }),
    ).toBe('wrong-validator');
  });
});

describe('report rendering', () => {
  async function report(): Promise<string> {
    const cases = await loadCases(suiteDir);
    const outcome = await runSuite(cases, {
      suite: 'apply-bench',
      invocation: 'node bench/harness/bin/adze-bench.mjs apply',
    });
    return renderReportMarkdown(outcome.report);
  }

  it('puts limitations before the first number', async () => {
    // ADR-0011 requires this to be a property of the generator, not of the author's
    // discipline. Moving the headline number above the caveats would take a
    // deliberate edit to report.ts plus deleting this test.
    const markdown = await report();
    const limitationsAt = markdown.indexOf('## Limitations');
    const firstPercentage = markdown.search(/\d+\.\d%/);

    expect(limitationsAt).toBeGreaterThan(-1);
    expect(firstPercentage).toBeGreaterThan(-1);
    expect(limitationsAt).toBeLessThan(firstPercentage);
  });

  it('puts limitations before the results section', async () => {
    const markdown = await report();
    expect(markdown.indexOf('## Limitations')).toBeLessThan(markdown.indexOf('## Results'));
  });

  it('states that the numbers measure the applier and not a model', async () => {
    const markdown = await report();
    expect(markdown).toContain('measure the applier, not any model');
    expect(markdown).toContain('hand-written');
    expect(markdown).toContain('must not be described as');
  });

  it('explains why there is no confidence interval instead of inventing one', async () => {
    const markdown = await report();
    expect(markdown).toContain('no confidence interval');
    expect(markdown).toContain('zero-variance');
    // The words "mean ± SEM" appear in the explanation of why the rule does not
    // apply here. What must never appear is an actual interval: a number, a ±, and
    // another number, which is what a reader would quote.
    expect(markdown).not.toMatch(/\d\s*±\s*\d/);
  });

  it('reports the severe class before the breakdowns', async () => {
    const markdown = await report();
    expect(markdown.indexOf('## Severe failures')).toBeLessThan(markdown.indexOf('## Breakdowns'));
  });

  it('includes a negative-results section and a reproduction block', async () => {
    const markdown = await report();
    expect(markdown).toContain('## Negative results');
    expect(markdown).toContain('## Reproduction');
    expect(markdown).toContain('node bench/harness/bin/adze-bench.mjs apply');
  });

  it('does not claim a 100% pass rate means correctness', async () => {
    const markdown = await report();
    expect(markdown).toContain('not that the applier is correct');
  });
});
