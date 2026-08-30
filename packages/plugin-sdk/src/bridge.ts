/**
 * The bridge from plugin hooks to `@adze/core`'s hook bus.
 *
 * ## Zero changes to `@adze/core`
 *
 * This was the surprise, and it is worth stating because the brief expected
 * otherwise. `@adze/core` already exposes exactly the seam this needs: `HookBus`
 * takes a `RegisteredHook` with `turnStart` / `toolPre` / `toolPost` / `turnEnd`,
 * `runTurn` fires the first and last, and `dispatchToolCall` — the *only* place in
 * the engine that calls a tool's `execute` — fires the middle two before the
 * permission gate. A plugin denial therefore stops a tool call on the real dispatch
 * path, and `test/dispatch-deny.test.ts` proves it against `dispatchToolCall`
 * rather than against a stand-in.
 *
 * ## `edit.pre` and `edit.post` are derived, not new hook points
 *
 * The spec lists nine events; core's bus has four. Five are handled here:
 *
 * | Spec event | How it fires |
 * | --- | --- |
 * | `session.turnStart` | core `turnStart` |
 * | `tool.pre` | core `toolPre` |
 * | `tool.post` | core `toolPost` |
 * | `session.turnEnd` | core `turnEnd` |
 * | `edit.pre` | **derived** from core `toolPre` on an edit-shaped tool |
 * | `edit.post` | **derived** from core `toolPost` on an edit-shaped tool |
 * | `session.start` | fired by the host, outside the bus |
 * | `context.pre` | **no seam in core** — see the README |
 * | `session.compact` | **no seam in core** — see the README |
 *
 * Deriving `edit.pre` from `tool.pre` is not a shortcut; it is the only place a
 * pre-edit veto can be enforced today. `core/src/tools/edit.ts` calls `applyEdit`
 * and then `grant.writeFile` *inside a single* `execute`, with no interior hook
 * point, so there is no moment between "the edit is known" and "the file is
 * written" that a hook could occupy. Dispatch is the moment before both. The
 * consequence is real and is reported rather than papered over: an `edit.pre` hook
 * sees the edit the model *proposed*, not the applier's resolved match locations,
 * because those do not exist yet.
 *
 * `edit.post` inherits a second limitation. Core's `tool.post` context carries a
 * `ToolResult`; the structured `AppliedEdit` — telemetry, tier, matched lines —
 * travels as a separate `ToolEmission` that never reaches the bus. So `edit.post`
 * can report the path and whether the write succeeded, and cannot report which
 * tier applied it. A formatter hook works. An "audit every applied edit with its
 * validator level" hook does not, and would need a core change.
 */

import type {
  Hooks,
  RegisteredHook,
  ToolPostContext,
  ToolPostOutcome,
  ToolPreContext,
  ToolPreOutcome,
  TurnEndContext,
  TurnStartContext,
  TurnStartOutcome,
} from '@adze/core';
import type { ContentBlock, JsonObject, ToolResult } from '@adze/protocol';
import type { EditPrePayload, HookDecision, HookHost } from './hooks.js';

/**
 * How a tool call is read as an edit.
 *
 * Keyed by tool name because the engine's edit surface is closed: `edit` and
 * `write` are the only built-ins that change file contents (ADR-0004). A host that
 * registers another writing tool declares it here rather than this package
 * guessing from argument names — a heuristic that matched `path` and `content`
 * would silently start firing `edit.pre` for an unrelated tool, and a policy hook
 * running against a payload it did not expect is worse than one that does not run.
 */
export interface EditShape {
  readonly path: string;
  readonly edits: readonly { readonly search: string; readonly replace: string }[];
  readonly wholeFile: boolean;
}

export type EditShapeReader = (args: JsonObject) => EditShape | undefined;

/** Reads core's `edit` tool arguments. */
export const readCoreEditArgs: EditShapeReader = (args) => {
  const path = args.path;
  if (typeof path !== 'string') return undefined;
  const rawEdits = args.edits;
  const edits: { search: string; replace: string }[] = [];
  if (Array.isArray(rawEdits)) {
    for (const entry of rawEdits) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const search = entry.search;
      const replace = entry.replace;
      if (typeof search !== 'string' || typeof replace !== 'string') continue;
      edits.push({ search, replace });
    }
  }
  return { path, edits, wholeFile: typeof args.replacement === 'string' };
};

/** Reads core's `write` tool arguments: a whole-file replacement. */
export const readCoreWriteArgs: EditShapeReader = (args) => {
  const path = args.path;
  if (typeof path !== 'string') return undefined;
  return { path, edits: [], wholeFile: true };
};

export const DEFAULT_EDIT_TOOLS: Readonly<Record<string, EditShapeReader>> = {
  edit: readCoreEditArgs,
  write: readCoreWriteArgs,
};

export interface BridgeOptions {
  readonly host: HookHost;
  /**
   * Tool name to edit-shape reader. Defaults to core's `edit` and `write`.
   *
   * Replacing this replaces the whole map rather than merging, so a host that
   * narrows it cannot be surprised by an inherited entry.
   */
  readonly editTools?: Readonly<Record<string, EditShapeReader>>;
  /**
   * Whether a human has already approved writing this path.
   *
   * The spec's own `edit.pre` example branches on `!ctx.approved_by_human`, and at
   * dispatch time nothing has been approved yet — the gate runs *after* hooks, so
   * a plugin can veto without the user being prompted first. A host with an
   * out-of-band signal supplies it; the default is `false`, which is the direction
   * that makes "migrations require review" hold rather than fail open.
   */
  readonly approvedByHuman?: (path: string) => boolean;
  /**
   * Extra milliseconds added to core's per-hook budget.
   *
   * The adapter fires every plugin hook for an event sequentially, each with its
   * own timeout, so its worst case is the sum. Core's bus applies one budget to the
   * whole call, and if that budget were smaller the *bus* would time out first —
   * and core's bus denies on timeout, which would reinstate the fail-closed
   * behaviour this package deliberately does not have. The margin makes core's
   * timeout unreachable rather than merely unlikely.
   */
  readonly marginMs?: number;
}

const DEFAULT_MARGIN_MS = 500;

/**
 * Build the single `RegisteredHook` that represents every loaded plugin.
 *
 * One adapter rather than one per plugin, because ordering and short-circuiting on
 * the first denial have to be decided across all plugins at once. Registering N
 * hooks on core's bus would give core the ordering decision, and core does not know
 * which of them are plugins.
 */
export function toRegisteredHook(options: BridgeOptions): RegisteredHook {
  const host = options.host;
  const editTools = options.editTools ?? DEFAULT_EDIT_TOOLS;
  const approvedByHuman = options.approvedByHuman ?? (() => false);
  const margin = options.marginMs ?? DEFAULT_MARGIN_MS;

  const budget =
    Math.max(
      host.budgetFor('session.turnStart'),
      host.budgetFor('tool.pre') + host.budgetFor('edit.pre'),
      host.budgetFor('tool.post') + host.budgetFor('edit.post'),
      host.budgetFor('session.turnEnd'),
    ) + margin;

  const implementation: Hooks = {
    async turnStart(context: TurnStartContext): Promise<TurnStartOutcome> {
      const blocks = await host.fireInjection('session.turnStart', {
        event: 'session.turnStart',
        data: {
          sessionId: context.sessionId,
          turnId: context.turnId,
          prompt: context.prompt,
          cacheEpoch: context.cacheEpoch,
        },
      });
      return blocks.length === 0 ? {} : { inject: blocks };
    },

    async toolPre(context: ToolPreContext): Promise<ToolPreOutcome> {
      const toolDecision = await host.fireDecision(
        'tool.pre',
        {
          sessionId: context.sessionId,
          turnId: context.turnId,
          callId: context.callId,
          name: context.name,
          arguments: context.arguments,
        },
        context.arguments,
      );
      if (toolDecision.kind === 'deny') return denyOutcome(toolDecision);

      let args = toolDecision.kind === 'modify' ? toolDecision.arguments : context.arguments;
      let rewritten = toolDecision.kind === 'modify';

      const reader = editTools[context.name];
      if (reader !== undefined && host.forEvent('edit.pre').length > 0) {
        const shape = reader(args);
        if (shape !== undefined) {
          const payload: EditPrePayload = {
            sessionId: context.sessionId,
            turnId: context.turnId,
            callId: context.callId,
            path: shape.path,
            edits: shape.edits,
            wholeFile: shape.wholeFile,
            approvedByHuman: approvedByHuman(shape.path),
          };
          const editDecision = await host.fireDecision('edit.pre', payload, args);
          if (editDecision.kind === 'deny') return denyOutcome(editDecision);
          if (editDecision.kind === 'modify') {
            args = editDecision.arguments;
            rewritten = true;
          }
        }
      }

      // A rewrite goes back through the tool's Zod schema in `dispatchToolCall`. A
      // plugin gets no more trust than the model does.
      return rewritten ? { kind: 'rewrite', arguments: args } : { kind: 'continue' };
    },

    async toolPost(context: ToolPostContext): Promise<ToolPostOutcome> {
      const original = textOf(context.result.content);
      const replaced = await host.fireToolPost({
        sessionId: context.sessionId,
        turnId: context.turnId,
        callId: context.callId,
        name: context.name,
        ok: context.result.ok,
        text: original,
      });

      const reader = editTools[context.name];
      if (reader !== undefined && host.forEvent('edit.post').length > 0) {
        const path = reader(editArgsFrom(context))?.path;
        if (path !== undefined) {
          await host.fireNotification('edit.post', {
            event: 'edit.post',
            data: {
              sessionId: context.sessionId,
              turnId: context.turnId,
              callId: context.callId,
              path,
              ok: context.result.ok,
            },
          });
        }
      }

      if (replaced === original) return { kind: 'continue' };
      return { kind: 'replace', result: withText(context.result, replaced) };
    },

    async turnEnd(context: TurnEndContext): Promise<void> {
      await host.fireNotification('session.turnEnd', {
        event: 'session.turnEnd',
        data: {
          sessionId: context.sessionId,
          turnId: context.turnId,
          stopReason: context.stopReason,
          steps: context.steps,
        },
      });
    },
  };

  return { name: 'adze.plugins', timeoutMs: budget, ...implementation };
}

function denyOutcome(decision: Extract<HookDecision, { kind: 'deny' }>): ToolPreOutcome {
  return { kind: 'deny', reason: `${decision.pluginId}: ${decision.reason}` };
}

/**
 * The path an `edit.post` hook is told about.
 *
 * Core's `tool.post` context does not carry the call's arguments, so the path has
 * to come from the result. `edit` and `write` both put `path: <p>` on the first line
 * of their output, which is a genuine coupling to two tools' text format and is why
 * this is a named function rather than an inline regex — if it breaks, it breaks
 * visibly here. The correct fix is a core change that puts the arguments on
 * `ToolPostContext`; see the README's list of what the spec cannot express today.
 */
function editArgsFrom(context: ToolPostContext): JsonObject {
  const text = textOf(context.result.content);
  const match = /^path:\s*(.+)$/m.exec(text);
  const path = match?.[1]?.trim();
  return path === undefined ? {} : { path };
}

function textOf(content: readonly ContentBlock[]): string {
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((part) => part.length > 0)
    .join('\n');
}

function withText(result: ToolResult, text: string): ToolResult {
  return { ...result, content: [{ type: 'text', text }] };
}
