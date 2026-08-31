/**
 * Tests for the two publication rules from `docs/benchmarks/strategy.md`.
 *
 * Both rules exist to refuse something we would want to publish, so the tests are
 * written from that side: the interesting cases are the ones where refusing costs us
 * the better-sounding sentence. A test suite that only proved `ahead` works when we
 * are far ahead would not exercise either rule.
 */

import { describe, expect, it } from 'vitest';
import {
  type Baseline,
  type Citation,
  checkCitation,
  compareToBaseline,
  NOISE_FLOOR_POINTS,
  SEM_MULTIPLE,
  type SourceRegistry,
} from '../src/publication.js';
import { estimatePassRate, type PassRateEstimate } from '../src/statistics.js';

function estimate(rates: readonly number[]): PassRateEstimate {
  const summary = estimatePassRate(rates);
  if (summary.kind !== 'estimate') throw new Error(`expected an estimate, got ${summary.kind}`);
  return summary.estimate;
}

/** A citable baseline, so comparison tests are not also citation tests. */
const CITATION: Citation = {
  kind: 'first-party-harness',
  label: 'our own harbor run',
  harnessName: 'harbor',
  harnessVersion: '0.22.0',
  invocation: 'harbor run swe-rebench --agent adze',
};

function baseline(passRate: number, sem?: number): Baseline {
  return {
    label: 'Cursor',
    passRate,
    ...(sem === undefined ? {} : { sem }),
    citation: CITATION,
  };
}

describe('rule 1 — no win claimed inside three percentage points', () => {
  it('sets the floor at three points, with no way to pass a different one', () => {
    // Asserted as a constant because the absence of a `noiseFloor` parameter is the
    // actual guarantee. Relaxing this rule has to look like editing the source.
    expect(NOISE_FLOOR_POINTS).toBe(3);
    expect(SEM_MULTIPLE).toBe(2);
  });

  it('refuses a lead inside the floor even though the lead is ours', () => {
    // 53.0% against 51.7% is 1.3 points. This is the headline the rule costs us, and
    // it is the whole reason the rule is in an ADR rather than a style guide.
    const comparison = compareToBaseline(estimate([0.52, 0.53, 0.54]), baseline(0.517, 0.0084));

    expect(comparison.verdict).toBe('within-noise');
    expect(comparison.claimable).toBe(false);
    expect(comparison.deltaPoints).toBeCloseTo(1.3, 6);
    expect(comparison.explanation).toContain('infrastructure noise floor');
    expect(comparison.wording).toContain('within noise');
    // No sentence a reader could quote as a win.
    expect(comparison.wording).not.toContain('ahead of');
  });

  it('refuses a difference that clears the floor but not our own noise', () => {
    // 4 points clears the fixed 3-point floor, but our run varied from 40% to 60%, so
    // two times the combined standard error is far wider than the difference. The two
    // gates are independent and a report has to say which one it failed.
    const comparison = compareToBaseline(estimate([0.4, 0.5, 0.6]), baseline(0.46));

    expect(comparison.verdict).toBe('within-noise');
    expect(comparison.claimable).toBe(false);
    expect(comparison.deltaPoints).toBeCloseTo(4, 6);
    expect(comparison.explanation).toContain('combined standard error');
    expect(comparison.explanation).toContain('too noisy');
  });

  it('allows a directional claim only when both gates are cleared', () => {
    const comparison = compareToBaseline(estimate([0.6, 0.61, 0.62]), baseline(0.5));

    expect(comparison.verdict).toBe('ahead');
    expect(comparison.claimable).toBe(true);
    expect(comparison.deltaPoints).toBeCloseTo(11, 6);
    expect(comparison.wording).toContain('ahead of');
    expect(comparison.explanation).toContain('clearing both');
  });

  it('reports being behind with the same confidence it reports being ahead', () => {
    // Symmetry is the credibility signal: `behind` is claimable and gets published.
    const comparison = compareToBaseline(estimate([0.6, 0.61, 0.62]), baseline(0.72));

    expect(comparison.verdict).toBe('behind');
    expect(comparison.claimable).toBe(true);
    expect(comparison.deltaPoints).toBeCloseTo(-11, 6);
    expect(comparison.wording).toContain('behind');
  });

  it('reports no comparison at all when we have no estimate', () => {
    const comparison = compareToBaseline(null, baseline(0.517));

    expect(comparison.verdict).toBe('insufficient-evidence');
    expect(comparison.claimable).toBe(false);
    expect(comparison.deltaPoints).toBeNull();
    expect(comparison.wording).toContain('no published result');
  });
});

describe('rule 2 — no aggregator citations, ever', () => {
  it('refuses every leaderboard host by default, because the registry ships empty', () => {
    // The load-bearing test for default-deny. A plausible-looking official URL is
    // refused until a maintainer has personally verified the host and added it, which
    // is correct for a repository that has published no numbers.
    const check = checkCitation({
      kind: 'first-party-leaderboard',
      label: 'SWE-rebench leaderboard',
      url: 'https://swe-rebench.example/leaderboard',
      retrievedAt: '2026-08-30',
    });

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problems.join(' ')).toContain('not on the verified-leaderboard registry');
    expect(check.problems.join(' ')).toContain('default-deny');
  });

  it('accepts a leaderboard host a maintainer has added to the registry', () => {
    const registry: SourceRegistry = {
      verifiedLeaderboardHosts: ['swe-rebench.example'],
      knownAggregatorHosts: [],
    };
    const check = checkCitation(
      {
        kind: 'first-party-leaderboard',
        label: 'SWE-rebench leaderboard',
        url: 'https://swe-rebench.example/leaderboard',
        retrievedAt: '2026-08-30',
      },
      registry,
    );

    expect(check.ok).toBe(true);
  });

  it('matches a subdomain against a registry entry', () => {
    const registry: SourceRegistry = {
      verifiedLeaderboardHosts: ['example.com'],
      knownAggregatorHosts: [],
    };
    const check = checkCitation(
      {
        kind: 'first-party-leaderboard',
        label: 'a board',
        url: 'https://boards.example.com/x',
        retrievedAt: '2026-08-30',
      },
      registry,
    );

    expect(check.ok).toBe(true);
  });

  it('refuses a recorded aggregator by name, so the reason survives', () => {
    const registry: SourceRegistry = {
      verifiedLeaderboardHosts: ['ranks.example'],
      knownAggregatorHosts: ['ranks.example'],
    };
    const check = checkCitation(
      {
        kind: 'first-party-leaderboard',
        label: 'a ranking site',
        url: 'https://ranks.example/best-agents',
        retrievedAt: '2026-08-30',
      },
      registry,
    );

    // The denylist wins over the allowlist: a host caught fabricating numbers stays
    // refused even if somebody re-adds it.
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problems.join(' ')).toContain('recorded aggregator');
  });

  it('refuses a citation that is not https', () => {
    const registry: SourceRegistry = {
      verifiedLeaderboardHosts: ['example.com'],
      knownAggregatorHosts: [],
    };
    const check = checkCitation(
      {
        kind: 'first-party-leaderboard',
        label: 'a board',
        url: 'http://example.com/board',
        retrievedAt: '2026-08-30',
      },
      registry,
    );

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problems.join(' ')).toContain('not https');
  });

  it('refuses an unparseable URL', () => {
    const check = checkCitation({
      kind: 'first-party-leaderboard',
      label: 'a board',
      url: 'not a url',
      retrievedAt: '2026-08-30',
    });

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problems.join(' ')).toContain('not a parseable URL');
  });

  it('requires a retrieval date whenever a URL is cited', () => {
    const registry: SourceRegistry = {
      verifiedLeaderboardHosts: ['example.com'],
      knownAggregatorHosts: [],
    };
    const check = checkCitation(
      { kind: 'first-party-leaderboard', label: 'a board', url: 'https://example.com/board' },
      registry,
    );

    // Leaderboards change. An undated citation cannot be checked against what the
    // page actually said.
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problems.join(' ')).toContain('retrievedAt');
  });
});

describe('citing our own harness', () => {
  it('accepts a pinned, invocable first-party run', () => {
    expect(checkCitation(CITATION).ok).toBe(true);
  });

  it('refuses a harness citation with no version, because it is not reproducible', () => {
    const check = checkCitation({
      kind: 'first-party-harness',
      label: 'our run',
      harnessName: 'harbor',
      invocation: 'harbor run swe-rebench',
    });

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problems.join(' ')).toContain('harnessVersion');
  });

  it('refuses a harness citation with no invocation', () => {
    const check = checkCitation({
      kind: 'first-party-harness',
      label: 'our run',
      harnessName: 'harbor',
      harnessVersion: '0.22.0',
    });

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problems.join(' ')).toContain('invocation');
  });

  it('collects every problem rather than stopping at the first', () => {
    // A caller fixing a citation should see the whole list in one pass.
    const check = checkCitation({ kind: 'first-party-harness', label: '' });

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problems.length).toBeGreaterThanOrEqual(4);
    expect(check.problems.join(' ')).toContain('label');
  });
});

describe('citing an independent evaluator', () => {
  it('accepts a named evaluator with published methodology', () => {
    const check = checkCitation({
      kind: 'independent-evaluator',
      label: 'an independent evaluation',
      evaluator: 'A Named Lab',
      methodologyUrl: 'https://lab.example/method',
      retrievedAt: '2026-08-30',
    });

    expect(check.ok).toBe(true);
  });

  it('refuses an evaluation with a number and no method', () => {
    // Having a number and no method is the definition of the thing rule 2 blocks.
    const check = checkCitation({
      kind: 'independent-evaluator',
      label: 'some ranking',
      evaluator: 'A Named Lab',
    });

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problems.join(' ')).toContain('methodologyUrl');
  });

  it('refuses a site name in place of a named evaluator', () => {
    const check = checkCitation({
      kind: 'independent-evaluator',
      label: 'some ranking',
      methodologyUrl: 'https://lab.example/method',
      retrievedAt: '2026-08-30',
    });

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problems.join(' ')).toContain('named evaluator');
  });
});

describe('citations parsed off disk', () => {
  it('refuses an unknown kind, which is where one would actually come from', () => {
    // Unreachable for a well-typed caller and entirely reachable for JSON, so the
    // default branch is not dead code.
    const fromJson = {
      kind: 'seo-leaderboard',
      label: 'Top 10 Agents 2026',
    } as unknown as Citation;
    const check = checkCitation(fromJson);

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problems.join(' ')).toContain('unknown citation kind');
  });
});
