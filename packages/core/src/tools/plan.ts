/**
 * `todo` and `task` — explicit plan state, and delegation.
 *
 * **`todo`** keeps the plan out of prose. ADR-0004 keeps it as a real tool because
 * explicit plan state measurably improves long-horizon coherence *and* is visible
 * to the user, which a plan buried in a paragraph is not. The list is always
 * submitted whole, never as a delta: a delta stream can desynchronize and then
 * shows a plan that was never true.
 *
 * **`task`** is the delegation primitive, and it is the sanctioned answer to
 * everything ADR-0003 keeps out of the core loop. Anyone who wants a
 * planner/executor split or a reflection pass builds it here, with its own budget
 * and a narrowed tool allowlist, rather than in the turn machine.
 *
 * `task` declares no effects of its own, and that is correct rather than a gap: the
 * subagent's tool calls each pass the gate individually, under the same sandbox mode
 * and approval policy as the parent. Declaring the union of what a subagent *might*
 * do would produce one enormous prompt covering actions it may never take, which is
 * precisely the approval fatigue the two-axis model exists to avoid.
 */

import { z } from 'zod';
import { defineTool } from '../registry.js';
import type { RegisteredTool, ToolExecution } from '../types.js';

const TodoArgs = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        content: z.string().min(1),
        status: z.enum(['pending', 'in-progress', 'completed', 'cancelled']),
      }),
    )
    .describe('The complete list, every time. Not a delta.'),
});

export function createTodoTool(): RegisteredTool {
  return defineTool({
    name: 'todo',
    description:
      'Replace the plan with this list. Always send the complete list, including items that ' +
      'have not changed. Use it to track multi-step work so progress is visible.',
    schema: TodoArgs,

    effects() {
      // Plan state lives in the session, not on disk or in a subprocess.
      return [];
    },

    async execute(args): Promise<ToolExecution> {
      const counts = new Map<string, number>();
      for (const item of args.items) {
        counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
      }
      const summary = [...counts.entries()].map(([status, n]) => `${status}=${n}`).join(' ');
      return await Promise.resolve({
        ok: true,
        content: [
          {
            type: 'text',
            text: `items: ${args.items.length}\n${summary}`,
          },
        ],
        emissions: [{ kind: 'todo.updated', items: args.items }],
      });
    },
  });
}

const TaskArgs = z.object({
  prompt: z
    .string()
    .min(1)
    .describe('Self-contained instructions. The subagent sees none of this conversation.'),
  tools: z
    .array(z.string().min(1))
    .min(1)
    .describe('Tool names the subagent may use. Must be a subset of the tools you have.'),
  maxSteps: z.number().int().positive().max(50).optional(),
});

export function createTaskTool(): RegisteredTool {
  return defineTool({
    name: 'task',
    description:
      'Delegate a self-contained piece of work to a subagent with a narrowed tool list. ' +
      'The subagent runs its own turn and returns only its final text, so use it to keep ' +
      'a long search or a bounded experiment out of this conversation.',
    schema: TaskArgs,

    effects() {
      return [];
    },

    async execute(args, ctx): Promise<ToolExecution> {
      if (ctx.runSubagent === undefined) {
        return {
          ok: false,
          content: [
            {
              type: 'text',
              text:
                'task is unavailable: no subagent runner is attached to this engine. ' +
                'Do the work directly with the tools you have.',
            },
          ],
          error: 'no subagent runner',
        };
      }

      const result = await ctx.runSubagent({
        prompt: args.prompt,
        tools: args.tools,
        ...(args.maxSteps === undefined ? {} : { maxSteps: args.maxSteps }),
      });

      // The failure detail goes in the content, not only in `error`. Content is what
      // reaches the model, and a delegation that failed because a tool name was wrong is
      // only actionable if the model can read which name. Reported by
      // `test/engine.test.ts`, where a subagent's allowlist error arrived as
      // "(no output)".
      const detail =
        result.error === undefined || result.error.length === 0 ? '' : `\nerror: ${result.error}`;

      return {
        ok: result.ok,
        content: [
          {
            type: 'text',
            text:
              `status: ${result.ok ? 'completed' : 'failed'}\nstop_reason: ${result.stopReason}\n` +
              `steps: ${result.steps}${detail}\n\n` +
              `${result.text.length > 0 ? result.text : '(no output)'}`,
          },
        ],
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    },
  });
}
