/**
 * The event stream, folded into something a webview can render.
 *
 * This is where ADR-0001's "the engine renders nothing" is paid for: every event
 * arriving here is structured data, and turning it into a view is the surface's
 * job. Keeping the fold pure — no `vscode`, no DOM, no I/O — is what makes it
 * testable without an editor, and the mapping is the part most likely to be
 * silently wrong.
 *
 * Three things this deliberately does *not* do:
 *
 * - **It does not collapse `tool.denied` into a failed `tool.finished`.** A denial
 *   is not a tool that ran and failed. Rendering them the same would make a working
 *   permission gate indistinguishable from a broken tool.
 * - **It does not collapse `edit.refused` into an error.** A refusal is a good
 *   outcome — the alternative was a corrupted file — so it renders as its own state
 *   with the reason the applier gave.
 * - **It does not hide a gap in `seq`.** Events carry a monotonic sequence per turn
 *   precisely so a surface can notice a dropped one; a partial transcript that
 *   looks complete is indistinguishable from a model that stopped early.
 */

import type {
  AdzeEvent,
  AppliedEdit,
  EditAppliedEvent,
  EditProposedEvent,
  EditRefusedEvent,
  RefusedEdit,
  StopReason,
  TextDeltaEvent,
  TodoItem,
  TodoUpdatedEvent,
  ToolDeniedEvent,
  ToolFinishedEvent,
  ToolStartedEvent,
  TurnCompletedEvent,
  TurnStartedEvent,
  Usage,
  UsageUpdatedEvent,
  Warning,
} from '@adze/protocol';

export type TurnStatus = 'idle' | 'running' | 'finished';

export type ToolState = 'running' | 'ok' | 'failed' | 'denied';

export interface ToolActivity {
  readonly callId: string;
  readonly name: string;
  readonly step: number;
  readonly state: ToolState;
  /** Failure detail or denial reason. Never a stack trace. */
  readonly detail: string | undefined;
  readonly truncated: boolean;
}

export type EditState = 'proposed' | 'applied' | 'refused';

export interface EditActivity {
  readonly editId: string;
  readonly path: string;
  readonly state: EditState;
  /** `search-replace`, `whole-file`, `fast-apply`. Undefined until resolved. */
  readonly tier: string | undefined;
  /** How the block was located. Undefined for a whole-file rewrite. */
  readonly strategy: string | undefined;
  /** The level that actually ran: `tree-sitter`, `structural`, or `none`. */
  readonly validator: string | undefined;
  /** Present on a refusal: the applier's reason code. */
  readonly reason: string | undefined;
  /** Present on a refusal: the message the applier wrote for the model. */
  readonly message: string | undefined;
}

export interface ChatViewModel {
  readonly sessionId: string | undefined;
  readonly turnId: string | undefined;
  readonly status: TurnStatus;
  readonly model: string | undefined;
  readonly cacheEpoch: number | undefined;
  readonly assistantText: string;
  readonly tools: readonly ToolActivity[];
  readonly edits: readonly EditActivity[];
  readonly todos: readonly TodoItem[];
  readonly usage: Usage | undefined;
  readonly steps: number;
  readonly warnings: readonly Warning[];
  readonly stopReason: StopReason | undefined;
  readonly message: string | undefined;
  /** Non-zero means the transcript below is incomplete. Rendered, not smoothed over. */
  readonly droppedEvents: number;
  /** Next `seq` expected on the current turn. Internal to gap detection. */
  readonly expectedSeq: number;
}

export const INITIAL_VIEW_MODEL: ChatViewModel = {
  sessionId: undefined,
  turnId: undefined,
  status: 'idle',
  model: undefined,
  cacheEpoch: undefined,
  assistantText: '',
  tools: [],
  edits: [],
  todos: [],
  usage: undefined,
  steps: 0,
  warnings: [],
  stopReason: undefined,
  message: undefined,
  droppedEvents: 0,
  expectedSeq: 0,
};

/**
 * Account for the sequence number before anything else looks at the event.
 *
 * A new `turnId` resets the expectation rather than counting the whole previous
 * turn as dropped.
 */
function trackSequence(state: ChatViewModel, event: AdzeEvent): ChatViewModel {
  const sameTurn = state.turnId === event.turnId;
  const expected = sameTurn ? state.expectedSeq : 0;
  const gap = event.seq > expected ? event.seq - expected : 0;
  return {
    ...state,
    droppedEvents: sameTurn ? state.droppedEvents + gap : gap,
    expectedSeq: event.seq + 1,
  };
}

function upsertTool(
  tools: readonly ToolActivity[],
  callId: string,
  update: (previous: ToolActivity | undefined) => ToolActivity,
): readonly ToolActivity[] {
  const index = tools.findIndex((tool) => tool.callId === callId);
  if (index === -1) return [...tools, update(undefined)];
  const next = [...tools];
  next[index] = update(tools[index]);
  return next;
}

function upsertEdit(
  edits: readonly EditActivity[],
  activity: EditActivity,
): readonly EditActivity[] {
  const index = edits.findIndex((edit) => edit.editId === activity.editId);
  if (index === -1) return [...edits, activity];
  const next = [...edits];
  next[index] = activity;
  return next;
}

function onTurnStarted(state: ChatViewModel, event: TurnStartedEvent): ChatViewModel {
  return {
    ...state,
    sessionId: event.sessionId,
    turnId: event.turnId,
    status: 'running',
    model: event.model,
    cacheEpoch: event.cacheEpoch,
    assistantText: '',
    tools: [],
    edits: [],
    usage: undefined,
    steps: 0,
    warnings: event.warnings,
    stopReason: undefined,
    message: undefined,
  };
}

function onTextDelta(state: ChatViewModel, event: TextDeltaEvent): ChatViewModel {
  // Concatenate. The engine does not buffer, so the surface owns the whole string.
  return { ...state, assistantText: state.assistantText + event.text };
}

function onToolStarted(state: ChatViewModel, event: ToolStartedEvent): ChatViewModel {
  return {
    ...state,
    tools: upsertTool(state.tools, event.call.callId, () => ({
      callId: event.call.callId,
      name: event.call.name,
      step: event.step,
      state: 'running',
      detail: undefined,
      truncated: false,
    })),
  };
}

function onToolFinished(state: ChatViewModel, event: ToolFinishedEvent): ChatViewModel {
  const { result } = event;
  return {
    ...state,
    tools: upsertTool(state.tools, result.callId, (previous) => ({
      callId: result.callId,
      name: previous?.name ?? result.callId,
      step: previous?.step ?? 0,
      state: result.ok ? 'ok' : 'failed',
      detail: result.error,
      truncated: result.truncated,
    })),
  };
}

function onToolDenied(state: ChatViewModel, event: ToolDeniedEvent): ChatViewModel {
  return {
    ...state,
    tools: upsertTool(state.tools, event.callId, (previous) => ({
      callId: event.callId,
      name: previous?.name ?? event.name,
      step: previous?.step ?? 0,
      // Its own state, never a failed run. See the file comment.
      state: 'denied',
      detail: `${event.source}: ${event.reason}`,
      truncated: false,
    })),
  };
}

function onEditProposed(state: ChatViewModel, event: EditProposedEvent): ChatViewModel {
  return {
    ...state,
    edits: upsertEdit(state.edits, {
      editId: event.proposal.editId,
      path: event.proposal.path,
      state: 'proposed',
      tier: undefined,
      strategy: undefined,
      validator: undefined,
      reason: undefined,
      message: undefined,
    }),
  };
}

function appliedActivity(applied: AppliedEdit): EditActivity {
  return {
    editId: applied.editId,
    path: applied.path,
    state: 'applied',
    tier: applied.telemetry.tier,
    strategy: applied.telemetry.strategy,
    // Reported as it arrived. Widening `structural` to `tree-sitter` would claim a
    // parse that did not happen.
    validator: applied.telemetry.validation.validator,
    reason: undefined,
    message: undefined,
  };
}

function refusedActivity(refused: RefusedEdit): EditActivity {
  return {
    editId: refused.editId,
    path: refused.path,
    state: 'refused',
    tier: refused.telemetry.tier,
    strategy: refused.telemetry.strategy,
    validator: refused.telemetry.validation.validator,
    reason: refused.reason,
    message: refused.message,
  };
}

function onEditApplied(state: ChatViewModel, event: EditAppliedEvent): ChatViewModel {
  return { ...state, edits: upsertEdit(state.edits, appliedActivity(event.applied)) };
}

function onEditRefused(state: ChatViewModel, event: EditRefusedEvent): ChatViewModel {
  return { ...state, edits: upsertEdit(state.edits, refusedActivity(event.refused)) };
}

function onTodoUpdated(state: ChatViewModel, event: TodoUpdatedEvent): ChatViewModel {
  // The complete list, never a delta, so replacing is correct.
  return { ...state, todos: event.items };
}

function onUsageUpdated(state: ChatViewModel, event: UsageUpdatedEvent): ChatViewModel {
  return { ...state, usage: event.usage, steps: event.steps, model: event.model };
}

function onTurnCompleted(state: ChatViewModel, event: TurnCompletedEvent): ChatViewModel {
  return {
    ...state,
    status: 'finished',
    stopReason: event.stopReason,
    usage: event.usage,
    steps: event.steps,
    model: event.model,
    message: event.message,
  };
}

/**
 * Fold one event into the view model.
 *
 * A flat dispatcher to one function per event shape, rather than a switch with
 * bodies in it: the shapes fail for unrelated reasons and read better apart, and
 * the union's exhaustiveness is checked by the compiler either way.
 */
export function reduce(state: ChatViewModel, event: AdzeEvent): ChatViewModel {
  const tracked = trackSequence(state, event);
  switch (event.type) {
    case 'turn.started':
      return onTurnStarted(tracked, event);
    case 'text.delta':
      return onTextDelta(tracked, event);
    case 'tool.started':
      return onToolStarted(tracked, event);
    case 'tool.finished':
      return onToolFinished(tracked, event);
    case 'tool.denied':
      return onToolDenied(tracked, event);
    case 'edit.proposed':
      return onEditProposed(tracked, event);
    case 'edit.applied':
      return onEditApplied(tracked, event);
    case 'edit.refused':
      return onEditRefused(tracked, event);
    case 'todo.updated':
      return onTodoUpdated(tracked, event);
    case 'usage.updated':
      return onUsageUpdated(tracked, event);
    case 'turn.completed':
      return onTurnCompleted(tracked, event);
  }
}

/** Fold a whole stream. Convenient for tests and for replaying a transcript. */
export function reduceAll(
  events: readonly AdzeEvent[],
  initial: ChatViewModel = INITIAL_VIEW_MODEL,
): ChatViewModel {
  return events.reduce(reduce, initial);
}
