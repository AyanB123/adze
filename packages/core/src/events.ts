/**
 * The event stream.
 *
 * ADR-0001's "the engine renders nothing" is enforced here by construction: an
 * event is protocol-typed structured data, and the only way to produce one is
 * through {@link TurnEmitter}, which no surface-shaped string can pass through.
 *
 * `seq` is the reason this is a class rather than a helper function. It is
 * monotonic per turn starting at 0, so a surface can detect a dropped event
 * instead of rendering a partial turn — which is indistinguishable, from the
 * surface's side, from a model that stopped early. One counter in one place is
 * what makes that guarantee true; a `seq` argument threaded through call sites is
 * what makes it a bug waiting to happen.
 *
 * Each method builds its event as a full literal and spreads {@link stamp}, so a
 * new event type that forgets the identity fields fails to compile rather than
 * emitting an unattributable event.
 */

import type {
  AdzeEvent,
  AppliedEdit,
  ProposedEdit,
  RefusedEdit,
  StopReason,
  TodoItem,
  ToolCall,
  ToolResult,
  Usage,
  Warning,
} from '@adze/protocol';

/**
 * Where events go.
 *
 * Synchronous and returning nothing on purpose. Events are notifications, so a
 * slow surface must not be able to stall the loop by failing to acknowledge
 * output — the protocol makes `event` a JSON-RPC notification for the same
 * reason. A sink that needs to do I/O queues internally.
 */
export type EventSink = (event: AdzeEvent) => void;

/** Collects events in order. For tests, replay, and trajectory logging. */
export class EventLog {
  private readonly events: AdzeEvent[] = [];

  readonly sink: EventSink = (event) => {
    this.events.push(event);
  };

  all(): readonly AdzeEvent[] {
    return this.events;
  }

  ofType<T extends AdzeEvent['type']>(type: T): readonly Extract<AdzeEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<AdzeEvent, { type: T }> => e.type === type);
  }

  /**
   * True when `seq` runs 0, 1, 2, … with no gaps, per turn.
   *
   * A property a surface is entitled to rely on, so it is checkable from the
   * engine's own tests rather than only observable as a rendering bug.
   */
  sequenceIsContiguous(): boolean {
    const nextByTurn = new Map<string, number>();
    for (const event of this.events) {
      const expected = nextByTurn.get(event.turnId) ?? 0;
      if (event.seq !== expected) return false;
      nextByTurn.set(event.turnId, expected + 1);
    }
    return true;
  }
}

interface EventIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly seq: number;
}

/** Emits events for one turn, stamping identity and sequence. */
export class TurnEmitter {
  private seq = 0;

  constructor(
    private readonly sink: EventSink,
    private readonly sessionId: string,
    private readonly turnId: string,
  ) {}

  /** Consumes the next sequence number. Called exactly once per emitted event. */
  private stamp(): EventIdentity {
    const identity = { sessionId: this.sessionId, turnId: this.turnId, seq: this.seq };
    this.seq += 1;
    return identity;
  }

  turnStarted(model: string, cacheEpoch: number, warnings: readonly Warning[]): void {
    this.sink({
      type: 'turn.started',
      ...this.stamp(),
      model,
      cacheEpoch,
      warnings: [...warnings],
    });
  }

  textDelta(text: string): void {
    // Guarded before stamping: an empty delta carries no information, and burning
    // a sequence number on it would look like a dropped event.
    if (text.length === 0) return;
    this.sink({ type: 'text.delta', ...this.stamp(), text });
  }

  toolStarted(call: ToolCall, step: number): void {
    this.sink({ type: 'tool.started', ...this.stamp(), call, step });
  }

  toolFinished(result: ToolResult): void {
    this.sink({ type: 'tool.finished', ...this.stamp(), result });
  }

  /**
   * A call the gate or a hook stopped.
   *
   * Never accompanied by `tool.finished`, and `tool.started` is emitted only after
   * authorization succeeds. So in a trajectory `tool.started` means the tool
   * actually ran, which is what keeps a denial from being counted as an execution
   * in exactly the artifact benchmark claims are checked against.
   */
  toolDenied(callId: string, name: string, source: 'gate' | 'hook', reason: string): void {
    this.sink({ type: 'tool.denied', ...this.stamp(), callId, name, source, reason });
  }

  editProposed(proposal: ProposedEdit): void {
    this.sink({ type: 'edit.proposed', ...this.stamp(), proposal });
  }

  editApplied(applied: AppliedEdit): void {
    this.sink({ type: 'edit.applied', ...this.stamp(), applied });
  }

  editRefused(refused: RefusedEdit): void {
    this.sink({ type: 'edit.refused', ...this.stamp(), refused });
  }

  todoUpdated(items: readonly TodoItem[]): void {
    this.sink({ type: 'todo.updated', ...this.stamp(), items: [...items] });
  }

  usageUpdated(model: string, usage: Usage, steps: number): void {
    this.sink({ type: 'usage.updated', ...this.stamp(), model, usage, steps });
  }

  turnCompleted(
    stopReason: StopReason,
    model: string,
    usage: Usage,
    steps: number,
    message?: string,
  ): void {
    this.sink({
      type: 'turn.completed',
      ...this.stamp(),
      stopReason,
      model,
      usage,
      steps,
      ...(message === undefined ? {} : { message }),
    });
  }
}
