/**
 * The three-tier applier.
 *
 * Tier 1  bounded-fuzzy search/replace   cheap, deterministic, no extra model
 * Tier 2  whole-file rewrite             reliable, costs tokens
 * Tier 3  pluggable fast-apply provider  optional, never a hard dependency
 *
 * Every tier parse-validates before returning success. A validation failure
 * falls through to the next tier rather than writing a broken file, and if every
 * tier fails the edit is *refused*. A refusal is a good outcome.
 *
 * See docs/architecture/adr/0005-edit-application.md
 */

import { findMatch, reindentReplacement } from './match.js';
import type {
  ApplyFailureReason,
  ApplyOptions,
  ApplyRequest,
  ApplyResult,
  ApplyTelemetry,
  ApplyTier,
  MatchLocation,
  ValidationResult,
} from './types.js';
import { detectLanguage, validate } from './validate.js';

const DEFAULT_TIERS: readonly ApplyTier[] = ['search-replace', 'whole-file'];
const DEFAULT_MAX_WHOLE_FILE_BYTES = 256 * 1024;

const SKIPPED_VALIDATION: ValidationResult = {
  ok: true,
  validator: 'none',
  message: 'validation skipped by caller',
};

interface TierAttempt {
  readonly content: string;
  readonly locations: readonly MatchLocation[];
  readonly strategy?: MatchLocation['strategy'];
}

/** Result of a single tier attempt, before validation. */
export type TierOutcome =
  | { readonly kind: 'ok'; readonly attempt: TierAttempt }
  | {
      readonly kind: 'fail';
      readonly reason: ApplyFailureReason;
      readonly message: string;
      readonly candidates?: readonly MatchLocation[];
    };

/**
 * Tier 1: apply search/replace blocks in order.
 *
 * Each block is located independently against the *current* content, so later
 * blocks see the effects of earlier ones. That matches how models reason about
 * sequential edits.
 */
export function applySearchReplace(request: ApplyRequest): TierOutcome {
  let content = request.original;
  const locations: MatchLocation[] = [];
  let broadestStrategy: MatchLocation['strategy'] | undefined;

  for (const [index, edit] of request.edits.entries()) {
    if (edit.search === edit.replace) {
      return {
        kind: 'fail',
        reason: 'no-op',
        message: `edit ${index + 1} has identical search and replace text`,
      };
    }

    // An empty search block means "prepend to file", which is unambiguous.
    if (edit.search.length === 0) {
      content = edit.replace + content;
      locations.push({ start: 0, end: 0, line: 1, strategy: 'exact' });
      broadestStrategy ??= 'exact';
      continue;
    }

    const { matches, strategy } = findMatch(content, edit.search);
    if (matches.length === 0 || strategy === undefined) {
      return {
        kind: 'fail',
        reason: 'not-found',
        message:
          `edit ${index + 1}: search text not found. ` +
          `Tried exact, whitespace-normalized, indentation-tolerant, and anchored matching.`,
      };
    }

    let chosen = matches[0];
    if (matches.length > 1) {
      if (edit.occurrence === undefined) {
        // Deliberate: picking the first match silently is a corruption vector.
        return {
          kind: 'fail',
          reason: 'ambiguous',
          message:
            `edit ${index + 1}: search text matched ${matches.length} times ` +
            `(lines ${matches.map((m) => m.line).join(', ')}). ` +
            `Add more surrounding context, or set 'occurrence' to disambiguate.`,
          candidates: matches.map(toLocation),
        };
      }
      chosen = matches[edit.occurrence - 1];
      if (chosen === undefined) {
        return {
          kind: 'fail',
          reason: 'not-found',
          message:
            `edit ${index + 1}: occurrence ${edit.occurrence} requested but only ` +
            `${matches.length} match(es) found.`,
        };
      }
    }
    if (chosen === undefined) {
      return { kind: 'fail', reason: 'not-found', message: `edit ${index + 1}: no usable match` };
    }

    const replacement = reindentReplacement(edit.replace, chosen);
    content = content.slice(0, chosen.start) + replacement + content.slice(chosen.end);
    locations.push(toLocation(chosen));
    broadestStrategy = widest(broadestStrategy, chosen.strategy);
  }

  return {
    kind: 'ok',
    attempt: { content, locations, ...(broadestStrategy ? { strategy: broadestStrategy } : {}) },
  };
}

/** Tier 2: replace the whole file with model-provided content. */
function applyWholeFile(request: ApplyRequest, maxBytes: number): TierOutcome {
  if (request.replacement === undefined) {
    return {
      kind: 'fail',
      reason: 'tier-unavailable',
      message: 'whole-file tier requires a full replacement, which was not supplied',
    };
  }
  if (Buffer.byteLength(request.replacement, 'utf8') > maxBytes) {
    return {
      kind: 'fail',
      reason: 'file-too-large',
      message: `replacement exceeds the ${maxBytes} byte whole-file limit`,
    };
  }
  return {
    kind: 'ok',
    attempt: {
      content: request.replacement,
      locations: [{ start: 0, end: request.original.length, line: 1, strategy: 'exact' }],
    },
  };
}

/** Dispatch a single tier. Extracted so `applyEdit` stays a readable loop. */
async function runTier(
  tier: ApplyTier,
  request: ApplyRequest,
  options: ApplyOptions,
  maxBytes: number,
): Promise<TierOutcome> {
  switch (tier) {
    case 'search-replace':
      return applySearchReplace(request);
    case 'whole-file':
      return applyWholeFile(request, maxBytes);
    case 'fast-apply':
      return runFastApply(request, options);
  }
}

function parseBrokenFailure(
  tier: ApplyTier,
  validation: ValidationResult,
): Extract<TierOutcome, { kind: 'fail' }> {
  const where = validation.line !== undefined ? ` at line ${validation.line}` : '';
  return {
    kind: 'fail',
    reason: 'parse-broken',
    message:
      `${tier}: edit rejected because the result no longer parses ` +
      `(${validation.message ?? 'structural check failed'}${where}).`,
  };
}

function successTelemetry(
  tier: ApplyTier,
  attempt: TierAttempt,
  request: ApplyRequest,
  validation: ValidationResult,
  startedAt: number,
  tiersAttempted: number,
): ApplyTelemetry {
  return {
    tier,
    ...(attempt.strategy ? { strategy: attempt.strategy } : {}),
    validation,
    durationMs: performance.now() - startedAt,
    tiersAttempted,
    editCount: request.edits.length,
    bytesChanged: Math.abs(
      Buffer.byteLength(attempt.content, 'utf8') - Buffer.byteLength(request.original, 'utf8'),
    ),
  };
}

/**
 * Apply an edit, escalating through configured tiers.
 *
 * Returns a refusal rather than a broken file. Callers should surface the
 * `message` to the model so it can retry with better context — one round of
 * feedback is the single highest-value intervention in the whole loop.
 */
export async function applyEdit(
  request: ApplyRequest,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const startedAt = performance.now();
  const language = options.language ?? detectLanguage(request.path);
  const maxBytes = options.maxWholeFileBytes ?? DEFAULT_MAX_WHOLE_FILE_BYTES;
  const tiers = options.tiers ?? DEFAULT_TIERS;

  let tiersAttempted = 0;
  let lastFailure: Extract<TierOutcome, { kind: 'fail' }> | undefined;
  /**
   * The tier that produced `lastFailure`. Tracked alongside it rather than taken
   * from whichever tier ran last, because on a refusal the *result* is the
   * diagnosis, and `ApplyTelemetry.tier` documents itself as the tier that
   * produced the result. Reading the last tier instead moved every tier-1 refusal
   * into the tier-2 column of the per-tier breakdown in apply-bench, which made a
   * published metric wrong in a way no single-tier test would surface.
   */
  let lastFailureTier: ApplyTier | undefined;
  let lastValidation: ValidationResult | undefined;
  let lastTier: ApplyTier = tiers[0] ?? 'search-replace';

  /**
   * Prefer the last *substantive* failure. `tier-unavailable` means the tier
   * never really ran (no replacement supplied, no provider configured), so it
   * must not mask a real diagnosis like `ambiguous` from an earlier tier — that
   * message is what the model needs in order to retry usefully.
   */
  const recordFailure = (
    outcome: Extract<TierOutcome, { kind: 'fail' }>,
    tier: ApplyTier,
  ): void => {
    if (lastFailure === undefined || outcome.reason !== 'tier-unavailable') {
      lastFailure = outcome;
      lastFailureTier = tier;
    }
  };

  for (const tier of tiers) {
    if (tier === 'fast-apply' && options.fastApplyProvider === undefined) continue;
    tiersAttempted++;
    lastTier = tier;

    const outcome = await runTier(tier, request, options, maxBytes);
    if (outcome.kind === 'fail') {
      recordFailure(outcome, tier);
      continue;
    }

    // A fast-apply model is still a model, so its output is untrusted and gets
    // validated exactly like Tier 1's.
    const validation = options.skipValidation
      ? SKIPPED_VALIDATION
      : validate(outcome.attempt.content, language);
    lastValidation = validation;

    if (!validation.ok) {
      recordFailure(parseBrokenFailure(tier, validation), tier);
      continue;
    }

    return {
      ok: true,
      content: outcome.attempt.content,
      locations: outcome.attempt.locations,
      telemetry: successTelemetry(
        tier,
        outcome.attempt,
        request,
        validation,
        startedAt,
        tiersAttempted,
      ),
    };
  }

  const telemetry: ApplyTelemetry = {
    tier: lastFailureTier ?? lastTier,
    validation: lastValidation ?? {
      ok: false,
      validator: 'none',
      message: 'no tier produced output',
    },
    durationMs: performance.now() - startedAt,
    tiersAttempted,
    editCount: request.edits.length,
    bytesChanged: 0,
  };

  return {
    ok: false,
    reason: lastFailure?.reason ?? 'tier-unavailable',
    message: lastFailure?.message ?? 'no configured tier could apply this edit',
    ...(lastFailure?.candidates ? { candidates: lastFailure.candidates } : {}),
    telemetry,
  };
}

async function runFastApply(request: ApplyRequest, options: ApplyOptions): Promise<TierOutcome> {
  const provider = options.fastApplyProvider;
  if (provider === undefined) {
    return {
      kind: 'fail',
      reason: 'tier-unavailable',
      message: 'no fast-apply provider configured',
    };
  }
  try {
    const content = await provider.apply(request);
    return {
      kind: 'ok',
      attempt: {
        content,
        locations: [{ start: 0, end: request.original.length, line: 1, strategy: 'exact' }],
      },
    };
  } catch (error) {
    return {
      kind: 'fail',
      reason: 'tier-unavailable',
      message: `fast-apply provider '${provider.name}' failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

const STRATEGY_ORDER: readonly MatchLocation['strategy'][] = [
  'exact',
  'whitespace-normalized',
  'indentation-tolerant',
  'anchored',
];

/** Report the least-strict strategy used across a multi-block edit. */
function widest(
  a: MatchLocation['strategy'] | undefined,
  b: MatchLocation['strategy'],
): MatchLocation['strategy'] {
  if (a === undefined) return b;
  return STRATEGY_ORDER.indexOf(b) > STRATEGY_ORDER.indexOf(a) ? b : a;
}

function toLocation(m: {
  start: number;
  end: number;
  line: number;
  strategy: MatchLocation['strategy'];
}): MatchLocation {
  return { start: m.start, end: m.end, line: m.line, strategy: m.strategy };
}
