/**
 * `edit` — the only path that changes part of a file.
 *
 * It exists because `sed` cannot refuse to corrupt a file. Every edit routes
 * through `@adze/apply`, which locates the search block through a bounded ladder —
 * exact, whitespace-normalized, indentation-tolerant, anchored, and nothing
 * looser — parse-validates the result, and **refuses** rather than writing a file
 * it has broken. A refusal is a good outcome; a corrupted file is the failure users
 * actually feel.
 *
 * Three behaviours are inherited from the applier and worth naming here because
 * this tool is where a model meets them:
 *
 * - An ambiguous match is an error, never a guess. The refusal names every
 *   candidate line, so the retry can add context or set `occurrence`.
 * - The refusal message is written for a model to act on. It is returned verbatim,
 *   because one round of feedback is the highest-value intervention in the loop.
 * - `telemetry.validation.validator` reports the level that actually ran. It is
 *   passed through untouched: widening `structural` to `tree-sitter` would imply a
 *   parse that did not happen, and benchmark reports depend on that field.
 */

import type { ApplyTelemetry as ApplyPackageTelemetry, ApplyResult } from '@adze/apply';
import { applyEdit } from '@adze/apply';
import type { ApplyTelemetry, MatchLocation, ProposedEdit, ValidationResult } from '@adze/protocol';
import { z } from 'zod';
import type { IdFactory } from '../ids.js';
import { defineTool } from '../registry.js';
import type { RegisteredTool, ToolEmission, ToolExecution } from '../types.js';
import { absolute } from './files.js';

const EditBlockArgs = z.object({
  search: z
    .string()
    .describe('Exact text to locate. Include enough surrounding lines to be unique.'),
  replace: z.string().describe('Replacement text. Empty deletes the matched region.'),
  occurrence: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('1-based selector when the search text appears more than once.'),
});

const EditArgs = z.object({
  path: z
    .string()
    .min(1)
    .describe('File to edit. Relative paths resolve against the workspace root.'),
  edits: z
    .array(EditBlockArgs)
    .min(1)
    .describe('Search/replace blocks, applied in order against the evolving file.'),
  replacement: z
    .string()
    .optional()
    .describe('Whole-file fallback, used only if the search/replace tier cannot apply safely.'),
});

export interface EditToolOptions {
  readonly nextId: IdFactory;
}

export function createEditTool(options: EditToolOptions): RegisteredTool {
  return defineTool({
    name: 'edit',
    description:
      'Apply search/replace edits to a file with parse validation. Refuses rather than ' +
      'writing a file it has broken, and refuses an ambiguous match instead of guessing. ' +
      'The refusal explains what to change and retry.',
    schema: EditArgs,

    effects(args, ctx) {
      const target = absolute(ctx.workspaceRoot, args.path);
      return [
        { kind: 'file-read', path: target },
        { kind: 'file-write', path: target },
      ];
    },

    async execute(args, ctx): Promise<ToolExecution> {
      const target = absolute(ctx.workspaceRoot, args.path);
      const editId = options.nextId('edit');

      let original: string;
      try {
        original = await ctx.grant.readFile(target);
      } catch (error) {
        return {
          ok: false,
          content: [
            {
              type: 'text',
              text:
                `could not read '${args.path}' to edit it: ` +
                `${error instanceof Error ? error.message : String(error)}. ` +
                `Use write to create a new file.`,
            },
          ],
          error: 'read failed',
        };
      }

      // Built once and used for both the proposal event and the applier, so the
      // event cannot describe an edit that differs from the one attempted.
      const editBlocks = args.edits.map((edit) => ({
        search: edit.search,
        replace: edit.replace,
        ...(edit.occurrence === undefined ? {} : { occurrence: edit.occurrence }),
      }));

      const proposal: ProposedEdit = {
        editId,
        path: args.path,
        edits: editBlocks,
        ...(args.replacement === undefined ? {} : { replacement: args.replacement }),
      };

      const result: ApplyResult = await applyEdit({
        path: args.path,
        original,
        edits: editBlocks,
        ...(args.replacement === undefined ? {} : { replacement: args.replacement }),
      });

      if (!result.ok) {
        const emissions: ToolEmission[] = [
          { kind: 'edit.proposed', proposal },
          {
            kind: 'edit.refused',
            refused: {
              editId,
              path: args.path,
              reason: result.reason,
              message: result.message,
              ...(result.candidates === undefined
                ? {}
                : { candidates: result.candidates.map(toProtocolLocation) }),
              telemetry: toProtocolTelemetry(result.telemetry),
            },
          },
        ];
        return {
          ok: false,
          content: [
            {
              type: 'text',
              text:
                `path: ${args.path}\nstatus: refused\nreason: ${result.reason}\n` +
                `tier: ${result.telemetry.tier}\n` +
                `validator: ${result.telemetry.validation.validator}\n\n${result.message}`,
            },
          ],
          error: result.reason,
          emissions,
        };
      }

      try {
        await ctx.grant.writeFile(target, result.content);
      } catch (error) {
        return {
          ok: false,
          content: [
            {
              type: 'text',
              text:
                `'${args.path}' applied cleanly but could not be written: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          error: 'write failed',
          emissions: [{ kind: 'edit.proposed', proposal }],
        };
      }

      const applied = {
        editId,
        path: args.path,
        telemetry: toProtocolTelemetry(result.telemetry),
        locations: result.locations.map(toProtocolLocation),
      };

      return {
        ok: true,
        content: [
          {
            type: 'text',
            text:
              `path: ${args.path}\nstatus: applied\ntier: ${result.telemetry.tier}\n` +
              `strategy: ${result.telemetry.strategy ?? 'n/a'}\n` +
              `validator: ${result.telemetry.validation.validator}\n` +
              `edits: ${result.telemetry.editCount}\n` +
              `bytes_changed: ${result.telemetry.bytesChanged}\n` +
              `lines: ${result.locations.map((l) => l.line).join(', ')}`,
          },
        ],
        emissions: [
          { kind: 'edit.proposed', proposal },
          { kind: 'edit.applied', applied },
        ],
      };
    },
  });
}

/**
 * Translate `@adze/apply`'s telemetry into the protocol's.
 *
 * The two types are structurally identical and deliberately separate: `protocol`
 * depends on nothing but `zod`, so it cannot import the applier, which means this
 * translation is the cost of that boundary. Written out field by field rather than
 * spread, so a field added on one side fails to compile here instead of silently
 * not crossing the wire.
 */
function toProtocolTelemetry(telemetry: ApplyPackageTelemetry): ApplyTelemetry {
  return {
    tier: telemetry.tier,
    ...(telemetry.strategy === undefined ? {} : { strategy: telemetry.strategy }),
    validation: toProtocolValidation(telemetry.validation),
    durationMs: telemetry.durationMs,
    tiersAttempted: telemetry.tiersAttempted,
    editCount: telemetry.editCount,
    bytesChanged: telemetry.bytesChanged,
  };
}

function toProtocolValidation(validation: ApplyPackageTelemetry['validation']): ValidationResult {
  return {
    ok: validation.ok,
    // Passed through, never widened. The field is a claim about evidence.
    validator: validation.validator,
    ...(validation.message === undefined ? {} : { message: validation.message }),
    ...(validation.line === undefined ? {} : { line: validation.line }),
  };
}

function toProtocolLocation(location: {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly strategy: MatchLocation['strategy'];
}): MatchLocation {
  return {
    start: location.start,
    end: location.end,
    line: location.line,
    strategy: location.strategy,
  };
}
