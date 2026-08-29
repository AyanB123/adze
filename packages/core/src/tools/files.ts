/**
 * `read` and `write`.
 *
 * Both exist rather than being `bash` for reasons ADR-0004 states as one line
 * each, and both lines are about a failure that is invisible until it has already
 * happened.
 *
 * **`read` is line-addressed with a token budget.** `cat` on a 40 000-line file
 * destroys the context window, and the model has no way to know that happened —
 * it simply has less room for everything afterwards. So a read returns a bounded
 * window, says how much of the file it is, and says how to get the next window.
 *
 * **`write` is atomic and gate-checked.** A whole-file replacement interrupted
 * halfway leaves neither the old file nor the new one. Atomicity lives in the
 * filesystem layer (`writeFile` is temp-then-rename), and this tool's job is to
 * declare the effect so the gate can refuse a path outside the writable roots.
 */

import { isAbsolute, resolve } from 'node:path';
import type { ContentBlock } from '@adze/protocol';
import { z } from 'zod';
import { defineTool } from '../registry.js';
import { estimateTokens } from '../truncate.js';
import type { RegisteredTool, ToolExecution } from '../types.js';

const DEFAULT_LINE_LIMIT = 2_000;
const DEFAULT_TOKEN_BUDGET = 8_000;

const ReadArgs = z.object({
  path: z
    .string()
    .min(1)
    .optional()
    .describe('File to read. Relative paths resolve against the workspace root.'),
  offset: z.number().int().positive().optional().describe('1-based first line to return.'),
  limit: z.number().int().positive().optional().describe('Maximum number of lines to return.'),
  continuation: z
    .string()
    .min(1)
    .optional()
    .describe('Token from a truncated earlier result, to retrieve the rest of that output.'),
});

export interface ReadToolOptions {
  readonly lineLimit?: number;
  /** Estimated-token ceiling for one read. Sized before the call, not after. */
  readonly tokenBudget?: number;
}

export function createReadTool(options: ReadToolOptions = {}): RegisteredTool {
  const lineLimit = options.lineLimit ?? DEFAULT_LINE_LIMIT;
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;

  return defineTool({
    name: 'read',
    description:
      'Read a window of a file, with line numbers. Returns at most a bounded number of ' +
      'lines and reports the total, so a large file does not consume the context window. ' +
      'Pass `offset` to continue, or `continuation` to retrieve the rest of a truncated ' +
      'earlier result.',
    schema: ReadArgs,

    effects(args, ctx) {
      // A continuation reads data the engine already holds and which already crossed
      // the gate once, so it declares nothing. The call is still authorized — every
      // tool call is — it simply has no effects to weigh.
      if (args.continuation !== undefined) return [];
      if (args.path === undefined) return [];
      return [{ kind: 'file-read', path: absolute(ctx.workspaceRoot, args.path) }];
    },

    async execute(args, ctx): Promise<ToolExecution> {
      if (args.continuation !== undefined) {
        const held = ctx.continuations.resolve(args.continuation);
        if (held === undefined) {
          return {
            ok: false,
            content: [
              {
                type: 'text',
                text:
                  `continuation token '${args.continuation}' is no longer held. ` +
                  `Re-run the command that produced it, narrowing its output.`,
              },
            ],
            error: 'unknown continuation token',
          };
        }
        return window(held.text, held.label, args.offset ?? 1, args.limit, lineLimit, tokenBudget);
      }

      if (args.path === undefined) {
        return {
          ok: false,
          content: [
            {
              type: 'text',
              text: 'read needs either `path` or `continuation`; neither was given.',
            },
          ],
          error: 'missing path',
        };
      }

      const target = absolute(ctx.workspaceRoot, args.path);
      let contents: string;
      try {
        contents = await ctx.grant.readFile(target);
      } catch (error) {
        return {
          ok: false,
          content: [
            {
              type: 'text',
              text: `could not read '${args.path}': ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          error: 'read failed',
        };
      }

      return window(contents, args.path, args.offset ?? 1, args.limit, lineLimit, tokenBudget);
    },
  });
}

/**
 * Return a bounded window with 1-based line numbers.
 *
 * Line numbers are addressing, not decoration: the model uses them to place edits
 * and to ask for the next window. They are `N\tcontent`, which is the cheapest form
 * that a model parses unambiguously and which no surface has to strip.
 */
function window(
  contents: string,
  label: string,
  offset: number,
  limit: number | undefined,
  lineLimit: number,
  tokenBudget: number,
): ToolExecution {
  const lines = contents.split('\n');
  const total = lines.length;
  const start = Math.min(Math.max(1, offset), Math.max(1, total));
  const maxLines = Math.min(limit ?? lineLimit, lineLimit);

  const kept: string[] = [];
  let tokens = 0;
  let index = start;
  while (index <= total && kept.length < maxLines) {
    const line = lines[index - 1] ?? '';
    const cost = estimateTokens(line) + 1;
    // Always keep at least one line: returning an empty window because the first
    // line is over budget tells the model nothing and costs it a step.
    if (kept.length > 0 && tokens + cost > tokenBudget) break;
    kept.push(`${index}\t${line}`);
    tokens += cost;
    index += 1;
  }

  const last = start + kept.length - 1;
  const complete = start === 1 && last >= total;
  const header =
    `path: ${label}\nlines: ${start}-${last} of ${total}` +
    (complete ? '' : `\nnext_offset: ${last + 1}`);

  const content: ContentBlock[] = [{ type: 'text', text: `${header}\n\n${kept.join('\n')}` }];

  // Deliberately not marked `continuable`. A partial window is not the engine
  // truncating: the tool chose the window on purpose and reported its bounds and the
  // next offset. Registering the whole file here would hand the model a token that
  // pulls the 40 000 lines this budget exists to prevent.
  return { ok: true, content };
}

const WriteArgs = z.object({
  path: z
    .string()
    .min(1)
    .describe('File to create or replace. Relative paths resolve against the workspace root.'),
  content: z.string().describe('Complete new contents. This is a whole-file replacement.'),
});

export function createWriteTool(): RegisteredTool {
  return defineTool({
    name: 'write',
    description:
      'Create or replace a file with the given contents, atomically. Use `edit` to change ' +
      'part of an existing file — this replaces the whole thing, and does not parse-validate ' +
      'the result.',
    schema: WriteArgs,

    effects(args, ctx) {
      return [{ kind: 'file-write', path: absolute(ctx.workspaceRoot, args.path) }];
    },

    async execute(args, ctx): Promise<ToolExecution> {
      const target = absolute(ctx.workspaceRoot, args.path);
      try {
        await ctx.grant.writeFile(target, args.content);
      } catch (error) {
        return {
          ok: false,
          content: [
            {
              type: 'text',
              text: `could not write '${args.path}': ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          error: 'write failed',
        };
      }
      return {
        ok: true,
        content: [
          {
            type: 'text',
            text:
              `path: ${args.path}\nbytes: ${Buffer.byteLength(args.content, 'utf8')}\n` +
              `lines: ${args.content.length === 0 ? 0 : args.content.split('\n').length}\n` +
              `status: written`,
          },
        ],
      };
    },
  });
}

export function absolute(workspaceRoot: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path);
}
