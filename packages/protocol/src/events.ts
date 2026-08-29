/**
 * The streamed event union.
 *
 * This is the whole of what the engine tells a surface while a turn runs, and it
 * is where ADR-0001's "the engine renders nothing" becomes concrete. Every event
 * here is structured data. None carries a pre-rendered string, terminal escape, or
 * markdown intended for display — the moment one does, the engine has an opinion
 * about presentation, and the CLI, the extension, and the IDE start diverging into
 * three products.
 *
 * The exception that proves the rule: `RefusedEdit.message` is prose, but it is
 * addressed to the *model* rather than to a human reader. That distinction is why
 * it is allowed.
 */

import { z } from 'zod';
import {
  AppliedEditSchema,
  ProposedEditSchema,
  RefusedEditSchema,
  TodoItemSchema,
  ToolCallSchema,
  ToolResultSchema,
  UsageSchema,
  WarningSchema,
} from './primitives.js';

/** Present on every event, so a surface can order and attribute without lookups. */
const EventBase = {
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  /**
   * Monotonic per turn, starting at 0.
   *
   * Lets a surface notice a dropped event instead of silently rendering a partial
   * turn — which is indistinguishable, from the surface's side, from a model that
   * stopped early.
   */
  seq: z.number().int().nonnegative(),
} as const;

export const TurnStartedEventSchema = z.strictObject({
  type: z.literal('turn.started'),
  ...EventBase,
  model: z.string().min(1),
  /**
   * Which cache epoch this turn runs in. The baseline system context is immutable
   * within an epoch so the provider's cache prefix stays byte-identical; an epoch
   * roll is therefore the single largest cost event in a turn, and a surface that
   * reports cost has to be able to see it.
   */
  cacheEpoch: z.number().int().nonnegative(),
  /**
   * Limitations in force for this turn — `no-os-sandbox` on Windows, a degraded
   * provider, a downgraded validator. Carried per turn rather than only at
   * startup because a per-turn permission override can introduce one.
   */
  warnings: z.array(WarningSchema).default([]),
});

export const TextDeltaEventSchema = z.strictObject({
  type: z.literal('text.delta'),
  ...EventBase,
  /** An incremental fragment. Surfaces concatenate; the engine does not buffer. */
  text: z.string(),
});

export const ToolStartedEventSchema = z.strictObject({
  type: z.literal('tool.started'),
  ...EventBase,
  call: ToolCallSchema,
  /** Step index within the turn, so a step budget is reportable as it is spent. */
  step: z.number().int().nonnegative(),
});

export const ToolFinishedEventSchema = z.strictObject({
  type: z.literal('tool.finished'),
  ...EventBase,
  result: ToolResultSchema,
});

/**
 * A tool call the gate or a hook stopped.
 *
 * Separate from `tool.finished` with `ok: false`, because a denial is not a tool
 * that ran and failed. Conflating them would let a denied action appear in a
 * trajectory log as an execution, which would quietly corrupt exactly the
 * artifact benchmark claims are checked against.
 */
export const ToolDeniedEventSchema = z.strictObject({
  type: z.literal('tool.denied'),
  ...EventBase,
  callId: z.string().min(1),
  name: z.string().min(1),
  /** `gate` for the permission gate, `hook` for a plugin veto. */
  source: z.enum(['gate', 'hook']),
  reason: z.string().min(1),
});

export const EditProposedEventSchema = z.strictObject({
  type: z.literal('edit.proposed'),
  ...EventBase,
  proposal: ProposedEditSchema,
});

export const EditAppliedEventSchema = z.strictObject({
  type: z.literal('edit.applied'),
  ...EventBase,
  applied: AppliedEditSchema,
});

export const EditRefusedEventSchema = z.strictObject({
  type: z.literal('edit.refused'),
  ...EventBase,
  refused: RefusedEditSchema,
});

export const TodoUpdatedEventSchema = z.strictObject({
  type: z.literal('todo.updated'),
  ...EventBase,
  /**
   * The complete list, never a delta. A delta stream can desynchronize and then
   * shows a plan that was never true; a full list cannot.
   */
  items: z.array(TodoItemSchema),
});

export const UsageUpdatedEventSchema = z.strictObject({
  type: z.literal('usage.updated'),
  ...EventBase,
  model: z.string().min(1),
  /** Cumulative for the turn so far, not per-call. */
  usage: UsageSchema,
  /** Model round-trips so far. Cheap proxy for token efficiency. */
  steps: z.number().int().nonnegative(),
});

/**
 * Why the loop stopped.
 *
 * `refused` is distinct from `error`: the former means the gate or the applier did
 * its job, and collapsing the two would make a working safety mechanism
 * indistinguishable from a crash in the metrics.
 */
export const StopReasonSchema = z.enum([
  'end-turn',
  'max-steps',
  'budget-exhausted',
  'cancelled',
  'refused',
  'error',
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

export const TurnCompletedEventSchema = z.strictObject({
  type: z.literal('turn.completed'),
  ...EventBase,
  stopReason: StopReasonSchema,
  model: z.string().min(1),
  usage: UsageSchema,
  steps: z.number().int().nonnegative(),
  /** Set when `stopReason` is `error` or `refused`. */
  message: z.string().optional(),
});

export const AdzeEventSchema = z.discriminatedUnion('type', [
  TurnStartedEventSchema,
  TextDeltaEventSchema,
  ToolStartedEventSchema,
  ToolFinishedEventSchema,
  ToolDeniedEventSchema,
  EditProposedEventSchema,
  EditAppliedEventSchema,
  EditRefusedEventSchema,
  TodoUpdatedEventSchema,
  UsageUpdatedEventSchema,
  TurnCompletedEventSchema,
]);
export type AdzeEvent = z.infer<typeof AdzeEventSchema>;
export type AdzeEventType = AdzeEvent['type'];

export type TurnStartedEvent = z.infer<typeof TurnStartedEventSchema>;
export type TextDeltaEvent = z.infer<typeof TextDeltaEventSchema>;
export type ToolStartedEvent = z.infer<typeof ToolStartedEventSchema>;
export type ToolFinishedEvent = z.infer<typeof ToolFinishedEventSchema>;
export type ToolDeniedEvent = z.infer<typeof ToolDeniedEventSchema>;
export type EditProposedEvent = z.infer<typeof EditProposedEventSchema>;
export type EditAppliedEvent = z.infer<typeof EditAppliedEventSchema>;
export type EditRefusedEvent = z.infer<typeof EditRefusedEventSchema>;
export type TodoUpdatedEvent = z.infer<typeof TodoUpdatedEventSchema>;
export type UsageUpdatedEvent = z.infer<typeof UsageUpdatedEventSchema>;
export type TurnCompletedEvent = z.infer<typeof TurnCompletedEventSchema>;

/**
 * Every event type, for exhaustiveness checks in surfaces.
 *
 * Derived from the union's own options rather than hand-listed. A hand-written
 * list would be a second place to forget a new event, and a surface's `switch`
 * would then skip it without any compiler complaint.
 */
export const ADZE_EVENT_TYPES: readonly AdzeEventType[] = AdzeEventSchema.options.map(
  (option) => option.shape.type.value,
);

/** True for the last event of a turn. Nothing follows it on that `turnId`. */
export function isTerminalEvent(event: AdzeEvent): event is TurnCompletedEvent {
  return event.type === 'turn.completed';
}
