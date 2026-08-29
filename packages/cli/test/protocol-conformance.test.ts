/**
 * Conformance between `@adze/apply` and `@adze/protocol`.
 *
 * `@adze/protocol` depends on nothing but `zod` (ADR-0001), so it re-declares the
 * applier's vocabulary — tiers, match strategies, failure reasons, validator
 * levels — instead of importing it. That keeps the contract a contract, at the cost
 * of two definitions with no compiler link between them.
 *
 * This file is where that cost is paid down. `@adze/cli` is the only package that
 * legitimately depends on both, so it is the right place to assert that real
 * applier output parses against the published schemas. Without these tests the
 * duplication would drift, and the first symptom would be a surface silently
 * failing to display a refusal reason the engine had emitted.
 */

import type { ApplyFailureReason, ApplyTier, MatchStrategy } from '@adze/apply';
import { applyEdit } from '@adze/apply';
import {
  AppliedEditSchema,
  ApplyFailureReasonSchema,
  ApplyTelemetrySchema,
  ApplyTierSchema,
  MatchStrategySchema,
  RefusedEditSchema,
  ValidatorLevelSchema,
} from '@adze/protocol';
import { describe, expect, it } from 'vitest';

describe('enum parity', () => {
  it('declares the same apply tiers on both sides', () => {
    // Typed so that adding a tier to @adze/apply without adding it here is a
    // compile error, not only a test failure.
    const tiers: readonly ApplyTier[] = ['search-replace', 'whole-file', 'fast-apply'];
    expect([...ApplyTierSchema.options].sort()).toEqual([...tiers].sort());
  });

  it('declares the same match strategies, in the same escalation order', () => {
    // Order is meaningful: it is the escalation ladder, and it stops at `anchored`.
    // A fifth value here would be an ADR-0005 change rather than a protocol tweak.
    const strategies: readonly MatchStrategy[] = [
      'exact',
      'whitespace-normalized',
      'indentation-tolerant',
      'anchored',
    ];
    expect(MatchStrategySchema.options).toEqual(strategies);
  });

  it('declares the same failure reasons on both sides', () => {
    // Each reason maps to a distinct user-facing fix, so a reason present in one
    // package and absent from the other means a surface cannot report it at all.
    const reasons: readonly ApplyFailureReason[] = [
      'not-found',
      'ambiguous',
      'parse-broken',
      'file-too-large',
      'tier-unavailable',
      'no-op',
    ];
    expect([...ApplyFailureReasonSchema.options].sort()).toEqual([...reasons].sort());
  });

  it('declares the same validator levels on both sides', () => {
    expect([...ValidatorLevelSchema.options].sort()).toEqual(
      ['tree-sitter', 'structural', 'none'].sort(),
    );
  });
});

describe('real applier output parses against the protocol schemas', () => {
  it('parses successful telemetry', async () => {
    const result = await applyEdit({
      path: 'src/a.ts',
      original: 'let x = 1;\n',
      edits: [{ search: 'let x = 1;', replace: 'const x = 1;' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = ApplyTelemetrySchema.safeParse(JSON.parse(JSON.stringify(result.telemetry)));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('parses a whole applied-edit payload as a surface would receive it', async () => {
    const result = await applyEdit({
      path: 'src/a.ts',
      original: 'let x = 1;\n',
      edits: [{ search: 'let x = 1;', replace: 'const x = 1;' }],
    });
    if (!result.ok) throw new Error('expected success');

    const wire = {
      editId: 'e-1',
      path: 'src/a.ts',
      telemetry: result.telemetry,
      locations: result.locations,
    };
    const parsed = AppliedEditSchema.safeParse(JSON.parse(JSON.stringify(wire)));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('parses an ambiguous refusal, candidates included', async () => {
    const result = await applyEdit({
      path: 'src/a.ts',
      original: 'let x = 1;\nlet x = 1;\n',
      edits: [{ search: 'let x = 1;', replace: 'const x = 1;' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ambiguous');

    const wire = {
      editId: 'e-1',
      path: 'src/a.ts',
      reason: result.reason,
      message: result.message,
      ...(result.candidates === undefined ? {} : { candidates: result.candidates }),
      telemetry: result.telemetry,
    };
    const parsed = RefusedEditSchema.safeParse(JSON.parse(JSON.stringify(wire)));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('parses a parse-broken refusal, whose telemetry carries a failed validation', async () => {
    const result = await applyEdit({
      path: 'src/a.ts',
      original: 'function f() {\n  return 1;\n}\n',
      edits: [{ search: '}', replace: '' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const wire = {
      editId: 'e-1',
      path: 'src/a.ts',
      reason: result.reason,
      message: result.message,
      telemetry: result.telemetry,
    };
    const parsed = RefusedEditSchema.safeParse(JSON.parse(JSON.stringify(wire)));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.telemetry.validation.ok).toBe(false);
    // The level that actually ran, not the level we wish had run.
    expect(parsed.data.telemetry.validation.validator).toBe('structural');
  });

  it('parses every strategy the applier can report', async () => {
    const cases: { original: string; search: string; expected: MatchStrategy }[] = [
      { original: 'let x = 1;\n', search: 'let x = 1;', expected: 'exact' },
      { original: 'let  x  =  1;\n', search: 'let x = 1;', expected: 'whitespace-normalized' },
      {
        original: 'class A {\n  run() {\n    return 1;\n  }\n}\n',
        search: 'run() {\n  return 1;\n}',
        expected: 'indentation-tolerant',
      },
    ];

    for (const c of cases) {
      const result = await applyEdit({
        path: 'src/a.ts',
        original: c.original,
        edits: [{ search: c.search, replace: c.search.replace('1', '2') }],
      });
      expect(result.ok, `${c.expected} case did not apply`).toBe(true);
      if (!result.ok) continue;
      expect(result.telemetry.strategy).toBe(c.expected);
      expect(MatchStrategySchema.safeParse(result.telemetry.strategy).success).toBe(true);
    }
  });
});
