/**
 * Sessions and the thread store.
 *
 * A session owns the one thing ADR-0003 is most emphatic about: a **strictly linear
 * history**. It is an append-only array of plain JSON messages, and it is the whole
 * of what the model sees. There is no parallel state, no summary cache, no side
 * channel — which is what makes a run replayable, diffable, and directly usable as
 * fine-tuning or RL data.
 *
 * The store is an interface with an in-memory implementation, which is all M1 needs.
 * Persistence is a later milestone (`docs/roadmap.md`); putting the interface in now
 * costs nothing and means the turn machine never learns where sessions live.
 */

import type {
  ApprovalPolicy,
  ModelSelection,
  SandboxConfig,
  TodoItem,
  Usage,
} from '@adze/protocol';
import { addUsage, ZERO_USAGE } from './cost.js';
import type { ConversationMessage } from './types.js';

/** A turn in flight, so `turn.cancel` has something to cancel. */
export interface ActiveTurn {
  readonly turnId: string;
  readonly controller: AbortController;
}

/**
 * Everything a session is, serializable.
 *
 * Exported because it is the replay artifact: a snapshot plus the same script
 * reproduces a run, and that is the property that makes a trajectory checkable by
 * someone who was not there.
 */
export interface SessionSnapshot {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly model: ModelSelection;
  readonly sandbox: SandboxConfig;
  readonly approvals: ApprovalPolicy;
  readonly instructions?: string;
  readonly history: readonly ConversationMessage[];
  readonly todos: readonly TodoItem[];
  readonly usage: Usage;
  readonly turns: number;
}

export interface SessionInit {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly model: ModelSelection;
  readonly sandbox: SandboxConfig;
  readonly approvals: ApprovalPolicy;
  readonly instructions?: string;
}

export class Session {
  readonly id: string;
  readonly workspaceRoot: string;
  model: ModelSelection;
  sandbox: SandboxConfig;
  approvals: ApprovalPolicy;
  readonly instructions: string | undefined;
  todos: readonly TodoItem[] = [];
  usage: Usage = ZERO_USAGE;
  turns = 0;
  activeTurn: ActiveTurn | undefined;

  /** Append-only. The array is private so nothing can splice history. */
  private readonly messages: ConversationMessage[] = [];

  constructor(init: SessionInit) {
    this.id = init.id;
    this.workspaceRoot = init.workspaceRoot;
    this.model = init.model;
    this.sandbox = init.sandbox;
    this.approvals = init.approvals;
    this.instructions = init.instructions;
  }

  get history(): readonly ConversationMessage[] {
    return this.messages;
  }

  append(...messages: readonly ConversationMessage[]): void {
    this.messages.push(...messages);
  }

  /**
   * Replace history with a summary.
   *
   * The only operation that is not an append, and it is deliberately explicit: the
   * caller supplies the summary text rather than the engine inventing a
   * summarization strategy. Automatic compaction needs a model round-trip and a
   * policy for what survives, and both are decisions worth making visibly rather
   * than burying in the loop. See `docs/roadmap.md`.
   *
   * The caller must roll the cache epoch alongside this, since the prefix now sits
   * in front of different history.
   */
  compact(summary: string): void {
    this.messages.length = 0;
    this.messages.push({
      role: 'user',
      origin: 'engine',
      content: [{ type: 'text', text: summary }],
    });
  }

  recordUsage(usage: Usage): void {
    this.usage = addUsage(this.usage, usage);
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      workspaceRoot: this.workspaceRoot,
      model: this.model,
      sandbox: this.sandbox,
      approvals: this.approvals,
      ...(this.instructions === undefined ? {} : { instructions: this.instructions }),
      history: [...this.messages],
      todos: [...this.todos],
      usage: this.usage,
      turns: this.turns,
    };
  }

  /**
   * True when every assistant tool call has a matching tool message, in order.
   *
   * The linearity invariant, checkable. A history where an assistant asked for three
   * tools and two answered is rejected by most providers and is unreplayable, so the
   * turn machine guarantees the shape even when a turn is cancelled mid-flight — and
   * this is how that guarantee is asserted rather than assumed.
   */
  historyIsLinear(): boolean {
    for (let index = 0; index < this.messages.length; index += 1) {
      const message = this.messages[index];
      if (message?.role !== 'assistant') continue;
      const expected = message.toolCalls;
      for (let offset = 0; offset < expected.length; offset += 1) {
        const follower = this.messages[index + 1 + offset];
        if (follower?.role !== 'tool') return false;
        if (follower.callId !== expected[offset]?.callId) return false;
      }
      index += expected.length;
    }
    return true;
  }
}

export interface SessionStore {
  create(session: Session): Promise<void>;
  get(id: string): Promise<Session | undefined>;
  delete(id: string): Promise<void>;
  list(): Promise<readonly Session[]>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  async create(session: Session): Promise<void> {
    if (this.sessions.has(session.id)) {
      throw new Error(`session '${session.id}' already exists`);
    }
    this.sessions.set(session.id, session);
    await Promise.resolve();
  }

  async get(id: string): Promise<Session | undefined> {
    return await Promise.resolve(this.sessions.get(id));
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
    await Promise.resolve();
  }

  async list(): Promise<readonly Session[]> {
    return await Promise.resolve([...this.sessions.values()]);
  }
}
