/**
 * `bash` — the workhorse.
 *
 * ADR-0004 exposes one general tool rather than a large bespoke catalog, because
 * the minimal reference harness does exactly that and scores above 74% on
 * SWE-bench Verified. Two properties make it safe enough to be the workhorse.
 *
 * **Stateless.** One subprocess per call, no persistent shell session. The
 * reference harness's maintainers identify this as their single largest stability
 * win: a persistent session feels better and produces hung processes, state
 * leaking between calls, and failures nobody can reproduce. The working directory
 * is therefore an argument, not a remembered fact.
 *
 * **Gated.** The command is declared as an effect before it runs, which is what
 * lets a command-prefix rule permit `npm test` without widening the sandbox, and
 * what lets the gate refuse under `never`.
 *
 * ### The shell is `bash` everywhere, including Windows
 *
 * The argv prefix defaults to `['bash', '-lc']` on every platform. That is a
 * deliberate refusal to be clever: substituting PowerShell or `cmd.exe` when
 * `bash` is missing would run model-authored bash syntax through an interpreter
 * with different quoting, different globbing, and different redirection semantics,
 * and some of those differences are destructive rather than merely broken. When
 * `bash` is absent the tool reports that the program could not be launched and
 * says so plainly — `shellPrefix` exists for a user who wants a different shell to
 * choose one on purpose.
 */

import { resolve } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../registry.js';
import { renderCommandResult, renderSpawnFailure } from '../test-feedback.js';
import type { RegisteredTool, ToolExecution } from '../types.js';

const BashArgs = z.object({
  command: z.string().min(1).describe('Shell command to run. Runs in a fresh subprocess.'),
  cwd: z
    .string()
    .optional()
    .describe('Working directory. Relative paths resolve against the workspace root.'),
  timeoutMs: z.number().int().positive().max(600_000).optional().describe('Per-call timeout.'),
  stdin: z.string().optional().describe('Text piped to the command on standard input.'),
});

export interface BashToolOptions {
  /** argv prefix the command string is appended to. Defaults to `['bash', '-lc']`. */
  readonly shellPrefix?: readonly string[];
  /** Fallback timeout when the model does not set one. */
  readonly defaultTimeoutMs?: number;
  /** Byte ceiling for the retained output excerpt. */
  readonly maxOutputBytes?: number;
}

const DEFAULT_SHELL_PREFIX: readonly string[] = ['bash', '-lc'];
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 24 * 1024;

export function createBashTool(options: BashToolOptions = {}): RegisteredTool {
  const shellPrefix = options.shellPrefix ?? DEFAULT_SHELL_PREFIX;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return defineTool({
    name: 'bash',
    description:
      'Run a shell command in a fresh subprocess. Stateless: nothing persists between ' +
      'calls, so pass cwd explicitly rather than relying on a previous cd. Output is ' +
      'returned structured, with failure lines extracted and the middle elided if long.',
    schema: BashArgs,

    effects(args, ctx) {
      const cwd = resolve(ctx.workspaceRoot, args.cwd ?? '.');
      return [
        { kind: 'command', command: [...shellPrefix, args.command], cwd },
        // Declared so a working directory outside the workspace is a decision the
        // user makes rather than one the tool takes.
        { kind: 'file-read', path: cwd },
      ];
    },

    async execute(args, ctx): Promise<ToolExecution> {
      const cwd = resolve(ctx.workspaceRoot, args.cwd ?? '.');
      const command = [...shellPrefix, args.command];
      const timeoutMs = Math.min(args.timeoutMs ?? defaultTimeoutMs, ctx.limits.timeoutMs);

      const outcome = await ctx.grant.exec(command, {
        cwd,
        timeoutMs,
        signal: ctx.signal,
        ...(args.stdin === undefined ? {} : { stdin: args.stdin }),
      });

      if (outcome.kind === 'spawn-failed') {
        return {
          ok: false,
          content: renderSpawnFailure(outcome, args.command),
          error: outcome.message,
        };
      }

      const rendered = renderCommandResult(outcome, {
        maxOutputBytes,
        command: args.command,
      });

      const full = `${outcome.stdout}\n${outcome.stderr}`.trimEnd();

      return {
        ok: rendered.structure.ok,
        content: rendered.content,
        ...(rendered.structure.ok
          ? {}
          : { error: failureSummary(rendered.structure.exitCode, rendered.structure.timedOut) }),
        // Retained only when something was actually elided, so a continuation token
        // is never issued for output the model already has in full.
        ...(rendered.outputTruncated
          ? { continuable: { label: `bash: ${args.command}`, text: full } }
          : {}),
      };
    },
  });
}

function failureSummary(exitCode: number | null, timedOut: boolean): string {
  if (timedOut) return 'command exceeded its timeout and was killed';
  return `command exited with ${exitCode === null ? 'a signal' : `code ${exitCode}`}`;
}
