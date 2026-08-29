/**
 * @adze/apply — three-tier edit applier with parse validation.
 *
 * The failure users actually feel is not a wrong answer, it is a mangled file.
 * This package exists so that a bad edit becomes a *refusal* instead of a
 * corrupted file, and so that the refusal rate is measurable.
 *
 * ```ts
 * import { applyEdit } from '@adze/apply';
 *
 * const result = await applyEdit({
 *   path: 'src/server.ts',
 *   original: source,
 *   edits: [{ search: 'const port = 3000', replace: 'const port = env.PORT ?? 3000' }],
 * });
 *
 * if (result.ok) {
 *   await writeFile('src/server.ts', result.content);
 *   console.log(result.telemetry.tier, result.telemetry.strategy);
 * } else {
 *   // Give this message back to the model. One round of feedback is the
 *   // highest-value intervention available.
 *   console.error(result.reason, result.message);
 * }
 * ```
 *
 * Design rationale: docs/architecture/adr/0005-edit-application.md
 */

export { applyEdit, applySearchReplace } from './applier.js';
export type { FindResult, RawMatch } from './match.js';
export { findMatch, indexLines, reindentReplacement } from './match.js';
export type {
  ApplyFailureReason,
  ApplyOptions,
  ApplyRequest,
  ApplyResult,
  ApplyTelemetry,
  ApplyTier,
  EditBlock,
  FastApplyProvider,
  MatchLocation,
  MatchStrategy,
  ValidationResult,
} from './types.js';
export { detectLanguage, validate, validateStructure } from './validate.js';
