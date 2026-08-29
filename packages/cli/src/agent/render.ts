/**
 * Rendering the event stream.
 *
 * ADR-0001's "the engine renders nothing" is only true if the rendering exists somewhere,
 * and this is that somewhere. The engine emits structured `AdzeEvent`s; every string a
 * user sees about a turn is produced here.
 *
 * Two modes, and the JSON one is not a lesser version. `--json` emits one event per line,
 * verbatim, so a script can consume the same stream the engine produced without this file
 * getting a vote on what matters. Plain text is for a human and is allowed to summarise;
 * JSONL is for a program and is not.
 *
 * `seq` gaps are reported rather than smoothed over. A dropped event renders as a partial
 * turn, which from the surface's side is indistinguishable from a model that stopped
 * early — and that ambiguity is exactly what the engine's monotonic counter exists to
 * remove.
 */

import type { AdzeEvent, AppliedEdit, RefusedEdit, TodoItem, Warning } from '@adze/protocol';
import type { Io, Style } from '../output.js';

export interface RenderOptions {
  readonly io: Io;
  readonly style: Style;
  /** One JSON document per line, verbatim. */
  readonly json: boolean;
  /** Suppress tool and progress lines; keep assistant text and the summary. */
  readonly quiet: boolean;
}

/**
 * Stateful because text deltas are a stream.
 *
 * The renderer has to know whether it is mid-paragraph in order to place a newline before
 * a tool line, and threading that through a function argument is how one call site forgets
 * and produces output with a tool banner spliced into a sentence.
 */
export class EventRenderer {
  private inText = false;
  private nextSeq = new Map<string, number>();
  private gaps = 0;

  constructor(private readonly options: RenderOptions) {}

  /** Events lost in transit. Non-zero means the transcript is incomplete. */
  get droppedEvents(): number {
    return this.gaps;
  }

  readonly sink = (event: AdzeEvent): void => {
    this.trackSequence(event);
    if (this.options.json) {
      this.options.io.out(`${JSON.stringify(event)}\n`);
      return;
    }
    this.renderPlain(event);
  };

  private trackSequence(event: AdzeEvent): void {
    const expected = this.nextSeq.get(event.turnId) ?? 0;
    if (event.seq !== expected) this.gaps += 1;
    this.nextSeq.set(event.turnId, event.seq + 1);
  }

  /** End any in-progress assistant paragraph before writing a structured line. */
  private breakText(): void {
    if (!this.inText) return;
    this.options.io.out('\n');
    this.inText = false;
  }

  /**
   * Dispatch only.
   *
   * Each case that needs a loop or a condition delegates to a method below. Keeping the
   * switch a flat dispatcher is what holds this function under the complexity ceiling
   * without suppressing the rule — the branching still exists, it just lives next to the
   * one event shape it reasons about instead of in a single 100-line switch.
   */
  private renderPlain(event: AdzeEvent): void {
    switch (event.type) {
      case 'turn.started':
        this.renderWarnings(event.warnings);
        break;

      case 'text.delta':
        this.inText = true;
        this.options.io.out(event.text);
        break;

      case 'tool.started':
        this.renderToolStarted(event.call.name, event.call.arguments);
        break;

      case 'tool.finished':
        this.renderToolFinished(event.result.ok, event.result.error);
        break;

      case 'tool.denied':
        // Never suppressed by `--quiet`. A denial changes what the agent did, and hiding
        // it makes the transcript describe a run that did not happen.
        this.breakText();
        this.options.io.err(
          `${this.options.style.bad('denied')} ${event.name} (${event.source}): ${event.reason}\n`,
        );
        break;

      case 'edit.applied':
        this.renderEditApplied(event.applied);
        break;

      case 'edit.refused':
        this.renderEditRefused(event.refused);
        break;

      case 'todo.updated':
        this.renderTodo(event.items);
        break;

      case 'turn.completed':
        this.renderCompleted(event.stopReason, event.message);
        break;

      // Progress-only. `usage.updated` arrives every step and its content is reported once
      // at the end, where it can be read; per-step spam would bury the assistant's text.
      case 'edit.proposed':
      case 'usage.updated':
        break;
    }
  }

  /**
   * Warnings first, and always — not behind `--verbose`.
   *
   * A `no-os-sandbox` warning the user has to opt into seeing is a warning that does not
   * exist.
   */
  private renderWarnings(warnings: readonly Warning[]): void {
    const { io, style } = this.options;
    for (const warning of warnings) {
      io.err(`${style.warn(`warning [${warning.code}]`)} ${warning.message}\n`);
      if (warning.reference !== undefined) io.err(`  ${style.dim(warning.reference)}\n`);
    }
  }

  private renderToolStarted(name: string, args: Readonly<Record<string, unknown>>): void {
    if (this.options.quiet) return;
    this.breakText();
    const { io, style } = this.options;
    io.err(`${style.info('·')} ${name} ${style.dim(describeArgs(args))}\n`);
  }

  private renderToolFinished(ok: boolean, error: string | undefined): void {
    if (this.options.quiet || ok) return;
    this.breakText();
    this.options.io.err(`  ${this.options.style.bad('failed')} ${error ?? 'no detail'}\n`);
  }

  private renderEditApplied(applied: AppliedEdit): void {
    this.breakText();
    const { io, style } = this.options;
    const { telemetry } = applied;
    io.err(
      `${style.good('edited')} ${applied.path} ` +
        // The validator level that actually ran. `structural` is never widened to
        // `tree-sitter`: the field is a claim about evidence.
        `${style.dim(
          `(${telemetry.tier}, ${telemetry.strategy ?? 'whole-file'}, validated: ${telemetry.validation.validator})`,
        )}\n`,
    );
  }

  private renderEditRefused(refused: RefusedEdit): void {
    // A refusal is the applier working correctly — the alternative was a corrupted file —
    // so it is reported as a result rather than as an error.
    this.breakText();
    const { io, style } = this.options;
    io.err(`${style.warn('refused')} ${refused.path}: ${refused.reason}\n`);
    io.err(`  ${refused.message}\n`);
  }

  private renderTodo(items: readonly TodoItem[]): void {
    if (this.options.quiet) return;
    this.breakText();
    const { io, style } = this.options;
    io.err(`${style.info('plan')}\n`);
    for (const item of items) io.err(`  ${MARK[item.status]} ${item.content}\n`);
  }

  private renderCompleted(stopReason: string, message: string | undefined): void {
    this.breakText();
    if (stopReason === 'end-turn') return;
    const { io, style } = this.options;
    io.err(
      `${style.warn(`stopped: ${stopReason}`)}${message === undefined ? '' : ` — ${message}`}\n`,
    );
  }
}

const MARK: Readonly<Record<string, string>> = {
  pending: '[ ]',
  'in-progress': '[~]',
  completed: '[x]',
  cancelled: '[-]',
};

/**
 * A one-line argument summary.
 *
 * Truncated, because a `write` call carries a whole file and a terminal that scrolls the
 * transcript off the screen is not a transcript. The full arguments are in the JSONL
 * stream, which is what a program should be reading.
 */
function describeArgs(args: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${key}=${clip(rendered ?? '', 60)}`);
    if (parts.join(' ').length > 100) break;
  }
  return clip(parts.join(' '), 120);
}

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}
