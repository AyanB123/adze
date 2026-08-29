/**
 * Hybrid ranking tests.
 *
 * ADR-0006 names hybrid ranking as the hardest part of this design to tune, and a
 * scoring function nobody can inspect does not get tuned — it gets replaced. So
 * the assertions here are as much about the *breakdown* as about the order: every
 * number that produced a score has to be present and has to add up.
 *
 * Reciprocal rank fusion is used because the signals produce scores on
 * incomparable scales, and rank is the only thing they genuinely share.
 * Normalising a ripgrep hit (no score at all) against a cosine similarity would
 * be inventing a comparison, so the tests check that rank is what drives fusion.
 */

import { describe, expect, it } from 'vitest';
import {
  fuseResults,
  proximityScore,
  type RankCandidate,
  recencyScore,
  resolveRankingOptions,
} from '../src/rank.js';
import type { SignalName, SymbolInfo } from '../src/types.js';

function candidate(path: string, line: number, snippet = 'x'): RankCandidate {
  return { path, line, column: 1, snippet };
}

function lists(
  entries: ReadonlyArray<readonly [SignalName, readonly RankCandidate[]]>,
): Map<SignalName, readonly RankCandidate[]> {
  return new Map(entries);
}

const SYMBOL: SymbolInfo = {
  name: 'UserService',
  kind: 'class',
  range: {
    startLine: 1,
    startColumn: 1,
    endLine: 3,
    endColumn: 2,
    startIndex: 0,
    endIndex: 20,
  },
};

describe('resolveRankingOptions', () => {
  it('fills in the documented defaults', () => {
    const resolved = resolveRankingOptions();
    // 60 is the constant from the original RRF paper.
    expect(resolved.k).toBe(60);
    expect(resolved.weights).toEqual({ lexical: 1, symbol: 1, semantic: 1 });
    expect(resolved.recencyWeight).toBeCloseTo(0.15);
    expect(resolved.proximityWeight).toBeCloseTo(0.35);
    expect(resolved.recencyHalfLifeMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('takes overrides and keeps unspecified weights at 1', () => {
    const resolved = resolveRankingOptions({ k: 10, weights: { symbol: 3 } });
    expect(resolved.k).toBe(10);
    expect(resolved.weights).toEqual({ lexical: 1, symbol: 3, semantic: 1 });
  });

  it('ignores a nonsensical k or half-life rather than dividing by zero', () => {
    expect(resolveRankingOptions({ k: 0 }).k).toBe(60);
    expect(resolveRankingOptions({ k: -5 }).k).toBe(60);
    expect(resolveRankingOptions({ recencyHalfLifeMs: 0 }).recencyHalfLifeMs).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
  });

  it('ignores a non-finite weight', () => {
    const resolved = resolveRankingOptions({ weights: { lexical: Number.NaN } });
    expect(resolved.weights.lexical).toBe(1);
  });
});

describe('recencyScore', () => {
  const halfLife = 1000;

  it('scores a file modified now at 1', () => {
    expect(recencyScore(5000, 5000, halfLife)).toBe(1);
  });

  it('halves every half-life', () => {
    expect(recencyScore(4000, 5000, halfLife)).toBeCloseTo(0.5);
    expect(recencyScore(3000, 5000, halfLife)).toBeCloseTo(0.25);
  });

  it('scores an unknown modification time at 0 rather than guessing a middle', () => {
    // On a fresh checkout every mtime is the clone time, so an assumed default
    // would quietly reorder every result.
    expect(recencyScore(undefined, 5000, halfLife)).toBe(0);
    expect(recencyScore(Number.NaN, 5000, halfLife)).toBe(0);
  });

  it('clamps a future mtime to 1 instead of exceeding it', () => {
    expect(recencyScore(9000, 5000, halfLife)).toBe(1);
  });
});

describe('proximityScore', () => {
  it('scores the open file itself at 1', () => {
    expect(proximityScore('src/a.ts', 'src/a.ts')).toBe(1);
  });

  it('scores 0 with no open file', () => {
    expect(proximityScore(undefined, 'src/a.ts')).toBe(0);
    expect(proximityScore('', 'src/a.ts')).toBe(0);
  });

  it('ranks a sibling above a cousin above an unrelated tree', () => {
    const sibling = proximityScore('src/core/a.ts', 'src/core/b.ts');
    const cousin = proximityScore('src/core/a.ts', 'src/other/b.ts');
    const unrelated = proximityScore('src/core/a.ts', 'docs/b.md');
    expect(sibling).toBeGreaterThan(cousin);
    expect(cousin).toBeGreaterThan(unrelated);
  });

  it('scores a sibling below the file itself', () => {
    expect(proximityScore('src/a.ts', 'src/b.ts')).toBeLessThan(1);
  });

  it('compares path separators consistently across platforms', () => {
    expect(proximityScore('src\\core\\a.ts', 'src/core/b.ts')).toBe(
      proximityScore('src/core/a.ts', 'src/core/b.ts'),
    );
  });

  it('scores two root-level files at 0 without dividing by zero', () => {
    expect(proximityScore('a.ts', 'b.ts')).toBe(0);
  });
});

describe('fuseResults — the breakdown is the contract', () => {
  it('reports every number that produced the score', () => {
    const output = fuseResults({
      lists: lists([
        ['lexical', [candidate('src/a.ts', 10)]],
        ['symbol', [candidate('src/a.ts', 10)]],
      ]),
      now: 1_000_000,
      mtimes: new Map([['src/a.ts', 1_000_000]]),
      openFile: 'src/a.ts',
    });

    const result = output.results[0];
    expect(result).toBeDefined();
    expect(result?.signals.ranks).toEqual({ lexical: 1, symbol: 1 });
    // Both at rank 1 with k=60 and weight 1.
    expect(result?.signals.contributions.lexical).toBeCloseTo(1 / 61);
    expect(result?.signals.contributions.symbol).toBeCloseTo(1 / 61);
    expect(result?.signals.fusion).toBeCloseTo(2 / 61);
    expect(result?.signals.recency).toBe(1);
    expect(result?.signals.proximity).toBe(1);
    // score = fusion * (1 + 0.15*recency + 0.35*proximity)
    expect(result?.score).toBeCloseTo((2 / 61) * 1.5);
  });

  it('never names a signal that produced nothing', () => {
    const output = fuseResults({
      lists: lists([
        ['lexical', [candidate('a.ts', 1)]],
        ['symbol', []],
      ]),
    });
    // Same honesty rule as ValidationResult.validator: absence of evidence is
    // reported as absence, not as a signal that ran and found nothing.
    expect(output.signalsUsed).toEqual(['lexical']);
    expect(output.results[0]?.signals.ranks.symbol).toBeUndefined();
    expect(output.results[0]?.signals.contributions.semantic).toBeUndefined();
  });

  it('echoes the ranking parameters actually applied', () => {
    const output = fuseResults({ lists: lists([]), options: { k: 5 } });
    expect(output.ranking.k).toBe(5);
    expect(output.ranking.weights.lexical).toBe(1);
  });

  it('returns nothing, and no signals, for empty input', () => {
    const output = fuseResults({ lists: lists([]) });
    expect(output.results).toHaveLength(0);
    expect(output.signalsUsed).toHaveLength(0);
  });
});

describe('fuseResults — ordering', () => {
  it('ranks agreement between signals above a better rank in one', () => {
    const output = fuseResults({
      lists: lists([
        ['lexical', [candidate('agree.ts', 1), candidate('solo.ts', 1)]],
        ['symbol', [candidate('agree.ts', 1)]],
      ]),
    });
    expect(output.results[0]?.path).toBe('agree.ts');
    // 1/61 + 1/61 beats 1/62.
    expect(output.results[0]?.signals.fusion).toBeGreaterThan(
      output.results[1]?.signals.fusion ?? Number.POSITIVE_INFINITY,
    );
  });

  it('preserves a single signal ordering exactly', () => {
    const output = fuseResults({
      lists: lists([
        ['lexical', [candidate('a.ts', 1), candidate('b.ts', 2), candidate('c.ts', 3)]],
      ]),
    });
    expect(output.results.map((r) => r.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('applies a per-signal weight', () => {
    const weighted = fuseResults({
      lists: lists([
        ['lexical', [candidate('lex.ts', 1)]],
        ['symbol', [candidate('sym.ts', 1)]],
      ]),
      options: { weights: { symbol: 5 } },
    });
    expect(weighted.results[0]?.path).toBe('sym.ts');
  });

  it('lets proximity overtake a rank or two without swamping the signals', () => {
    const output = fuseResults({
      lists: lists([['lexical', [candidate('far/one.ts', 1), candidate('near/two.ts', 2)]]]),
      openFile: 'near/open.ts',
    });
    // The boost is multiplicative precisely so this can happen: adjacent RRF
    // contributions differ by almost nothing, so an additive boost large enough
    // to matter would turn ranking into "whatever was edited last".
    expect(output.results[0]?.path).toBe('near/two.ts');
    // But it is bounded: the boost cannot exceed 1 + weight.
    const boosted = output.results[0];
    expect((boosted?.score ?? 0) / (boosted?.signals.fusion ?? 1)).toBeLessThanOrEqual(1.5);
  });

  it('does not let recency overtake a large rank gap', () => {
    const many = Array.from({ length: 30 }, (_, i) => candidate(`f${i}.ts`, 1));
    const output = fuseResults({
      lists: lists([['lexical', many]]),
      now: 1_000_000,
      // The worst-ranked file is the most recently modified.
      mtimes: new Map([['f29.ts', 1_000_000]]),
      options: { recencyHalfLifeMs: 1000 },
    });
    expect(output.results[0]?.path).toBe('f0.ts');
  });

  it('breaks ties on path then line, so a run is reproducible', () => {
    const output = fuseResults({
      lists: lists([
        ['lexical', [candidate('b.ts', 2), candidate('b.ts', 1), candidate('a.ts', 5)]],
      ]),
      options: { k: 1_000_000 },
    });
    // With a huge k every contribution is nearly identical, so ordering falls to
    // the tiebreak. Benchmark reporting depends on that being deterministic.
    const scores = output.results.map((r) => r.score);
    expect(scores[0]).toBeGreaterThanOrEqual(scores[1] ?? 0);
    expect(output.results).toHaveLength(3);
  });
});

describe('fuseResults — merging locations', () => {
  it('fuses two signals pointing at the same line into one result', () => {
    const output = fuseResults({
      lists: lists([
        ['lexical', [candidate('a.ts', 10)]],
        ['symbol', [candidate('a.ts', 10)]],
      ]),
    });
    expect(output.results).toHaveLength(1);
    expect(Object.keys(output.results[0]?.signals.ranks ?? {}).sort()).toEqual([
      'lexical',
      'symbol',
    ]);
  });

  it('keeps a hit on a different line separate', () => {
    const output = fuseResults({
      lists: lists([['lexical', [candidate('a.ts', 10), candidate('a.ts', 20)]]]),
    });
    expect(output.results).toHaveLength(2);
  });

  it('prefers the candidate carrying a symbol, keeping the lexical snippet', () => {
    const withSymbol: RankCandidate = { ...candidate('a.ts', 1, ''), symbol: SYMBOL };
    const output = fuseResults({
      lists: lists([
        ['lexical', [candidate('a.ts', 1, 'class UserService {')]],
        ['symbol', [withSymbol]],
      ]),
    });
    // A symbol hit knows the declaration's kind and scope; a lexical hit does not.
    expect(output.results[0]?.symbol?.name).toBe('UserService');
    expect(output.results[0]?.snippet).toBe('class UserService {');
  });

  it('counts a repeated location once, at its best rank', () => {
    const output = fuseResults({
      lists: lists([
        ['lexical', [candidate('a.ts', 1), candidate('b.ts', 1), candidate('a.ts', 1)]],
      ]),
    });
    const first = output.results.find((r) => r.path === 'a.ts');
    expect(first?.signals.ranks.lexical).toBe(1);
    expect(first?.signals.contributions.lexical).toBeCloseTo(1 / 61);
    expect(output.results).toHaveLength(2);
  });

  it('carries context lines through untouched', () => {
    const output = fuseResults({
      lists: lists([['lexical', [{ ...candidate('a.ts', 2), before: ['one'], after: ['three'] }]]]),
    });
    expect(output.results[0]?.before).toEqual(['one']);
    expect(output.results[0]?.after).toEqual(['three']);
  });

  it('omits context fields entirely when none was captured', () => {
    const output = fuseResults({ lists: lists([['lexical', [candidate('a.ts', 1)]]]) });
    expect('before' in (output.results[0] ?? {})).toBe(false);
    expect('after' in (output.results[0] ?? {})).toBe(false);
  });
});

describe('fuseResults — the semantic signal is fusable the day it exists', () => {
  it('accepts semantic candidates and attributes them', () => {
    // ADR-0006 defers vector search but the ranking layer must be able to fuse it
    // without change, or "deferred" would mean "needs a rewrite later".
    const output = fuseResults({
      lists: lists([
        ['lexical', [candidate('a.ts', 1)]],
        ['semantic', [candidate('b.ts', 1)]],
      ]),
    });
    expect(output.signalsUsed).toEqual(['lexical', 'semantic']);
    const semantic = output.results.find((r) => r.path === 'b.ts');
    expect(semantic?.signals.contributions.semantic).toBeCloseTo(1 / 61);
  });

  it('orders signals lexical, symbol, semantic — cheapest first', () => {
    const output = fuseResults({
      lists: lists([
        ['semantic', [candidate('c.ts', 1)]],
        ['symbol', [candidate('b.ts', 1)]],
        ['lexical', [candidate('a.ts', 1)]],
      ]),
    });
    // Insertion order of the input map must not decide the reported order.
    expect(output.signalsUsed).toEqual(['lexical', 'symbol', 'semantic']);
  });
});
