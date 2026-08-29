/**
 * The context assembler, in cache epochs.
 *
 * Provider prompt caching only pays if the prefix is **byte-identical**. The
 * obvious implementation — reassemble the system prompt each step, refresh a
 * timestamp, re-sort a file list, re-rank retrieval — invalidates the cache on
 * every single step. Cache economics move effective cost by more than 10×, and cost
 * per task is the axis an open-source tool can credibly win, so this is not a
 * micro-optimisation. It is the difference between competitive and uncompetitive.
 *
 * So the baseline system context is **frozen for a cache epoch**. Within an epoch
 * that prefix is immutable: new information arrives as ordered mid-conversation
 * messages, never as a change to the prefix. An epoch rolls only on a structural
 * change — a model switch, compaction, a permission-mode change, or a change to the
 * tool set, since tools are part of the cached prefix for most providers.
 *
 * The invariant worth testing is exactly one sentence: **assembling twice within an
 * epoch produces byte-identical baselines.** `test/context.test.ts` asserts it
 * across steps and asserts that each structural change rolls the epoch. That test
 * is the whole point of this design; without it the design is a comment.
 *
 * ### Why the baseline is built from a fixed field list
 *
 * {@link BaselineInputs} is a small, closed record, and {@link epochKey} enumerates
 * it. Anything not in that record cannot reach the prefix, which is what makes
 * "nothing volatile leaks in" checkable rather than aspirational. Adding a field is
 * a deliberate act that changes the key, and therefore rolls the epoch, which is
 * the correct consequence.
 */

import { createHash } from 'node:crypto';
import type { ApprovalPolicy, SandboxEnforcement, SandboxMode } from '@adze/protocol';
import type { ConversationMessage, SystemMessage } from './types.js';

/**
 * Why an epoch rolled.
 *
 * ADR-0003 names model switch, compaction, and permission-mode change. The other two
 * are the same class of thing and are enumerated rather than folded into one of the
 * named three: the tool catalog is part of the cached prefix for most providers, and
 * project instructions are part of the system message, so a change to either genuinely
 * invalidates the prefix. Reporting `permission-change` for a tool-set change would
 * make the most expensive event in a turn attributable to the wrong cause.
 */
export type EpochRollReason =
  | 'initial'
  | 'model-switch'
  | 'compaction'
  | 'permission-change'
  | 'tool-set-change'
  | 'instructions-change';

/** Everything the frozen prefix is allowed to depend on. */
export interface BaselineInputs {
  /** Dated snapshot id where the provider offers one. */
  readonly model: string;
  readonly workspaceRoot: string;
  readonly sandboxMode: SandboxMode;
  readonly approvals: ApprovalPolicy;
  /**
   * How the mode is actually enforced. In the prefix because the agent's behaviour
   * should differ when nothing is containing it — and because a user who switches
   * platforms should not silently get the same instructions.
   */
  readonly enforcement: SandboxEnforcement;
  /** Extra instructions, e.g. assembled from `AGENTS.md`. */
  readonly instructions?: string;
  /** Tool names. Sorted internally; caller order does not matter. */
  readonly toolNames: readonly string[];
}

export interface CacheEpoch {
  readonly index: number;
  readonly reason: EpochRollReason;
  /** Immutable for the life of the epoch. */
  readonly baseline: readonly ConversationMessage[];
  /** SHA-256 of the serialized baseline. Compared in tests and reported in logs. */
  readonly fingerprint: string;
  /** Structural key. A change here, and only here, rolls the epoch. */
  readonly key: string;
  /** The inputs that produced this epoch, so a roll can name its own cause. */
  readonly inputs: BaselineInputs;
}

/**
 * Stable serialization of the structural inputs.
 *
 * Tool names are sorted so a registry iteration order cannot roll an epoch, and
 * every field is named explicitly rather than `JSON.stringify(inputs)` — an object
 * literal's key order is stable in V8 but is not something a reader can verify, and
 * a silent reordering here is a cache miss on every step of every turn.
 */
export function epochKey(inputs: BaselineInputs): string {
  return [
    `model=${inputs.model}`,
    `root=${inputs.workspaceRoot}`,
    `mode=${inputs.sandboxMode}`,
    `approvals=${inputs.approvals}`,
    `enforcement=${inputs.enforcement}`,
    `instructions=${hash(inputs.instructions ?? '')}`,
    `tools=${[...inputs.toolNames].sort().join(',')}`,
  ].join('\n');
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The system prompt.
 *
 * Model-facing text, which is not the rendering the engine is forbidden to do: it
 * carries no terminal escapes, no HTML, and nothing intended for a human reader. A
 * surface never displays this.
 *
 * Deliberately short and deliberately free of anything that varies. No timestamp,
 * no directory listing, no retrieval results, no git status — every one of those is
 * a per-step cache invalidation, and each belongs in a mid-conversation message
 * where it costs one step's tokens instead of the whole prefix.
 */
export function renderBaseline(inputs: BaselineInputs): readonly SystemMessage[] {
  const lines: string[] = [
    'You are Adze, an agent that works in a real code repository through tools.',
    '',
    `workspace_root: ${inputs.workspaceRoot}`,
    `sandbox_mode: ${inputs.sandboxMode}`,
    `approval_policy: ${inputs.approvals}`,
    `containment: ${inputs.enforcement}`,
    '',
    'How this environment works:',
    '- Tool calls are stateless. One subprocess per command, nothing persists between',
    '  calls, so pass the working directory explicitly rather than relying on a cd.',
    '- Tool output is truncated to a budget. When a result says it was truncated, ask',
    '  for the rest rather than assuming you saw everything.',
    '- Edits are parse-validated and may be refused. A refusal explains what to change;',
    '  read it and retry rather than repeating the same edit.',
    '- Every tool call is authorized against the sandbox mode and approval policy above.',
    '  A denial is a boundary, not a transient failure.',
  ];

  if (inputs.enforcement === 'gate-only') {
    lines.push(
      '- There is no OS-level containment on this platform. Commands that are approved',
      '  run without confinement, so prefer the narrowest command that answers the',
      '  question.',
    );
  }

  if (inputs.instructions !== undefined && inputs.instructions.trim().length > 0) {
    lines.push('', 'Project instructions:', inputs.instructions.trim());
  }

  return [
    { role: 'system', origin: 'engine', content: [{ type: 'text', text: lines.join('\n') }] },
  ];
}

export interface AssembledContext {
  readonly messages: readonly ConversationMessage[];
  /**
   * How many leading messages form the cacheable prefix.
   *
   * Passed to the provider so it can place an explicit cache breakpoint — some
   * providers require the marker rather than inferring it. Without this the epoch
   * design would be correct and unrewarded.
   */
  readonly cachePrefixLength: number;
  readonly epoch: CacheEpoch;
}

export class ContextAssembler {
  private epoch: CacheEpoch;

  constructor(inputs: BaselineInputs) {
    this.epoch = buildEpoch(0, 'initial', inputs);
  }

  get current(): CacheEpoch {
    return this.epoch;
  }

  /**
   * Prefix plus history.
   *
   * The baseline array is reused rather than rebuilt, so the identity of the prefix
   * is stable as well as its bytes. Rebuilding an identical array each call would
   * still be byte-stable and would make it impossible to tell, from a debugger,
   * whether the epoch had rolled.
   */
  assemble(history: readonly ConversationMessage[]): AssembledContext {
    return {
      messages: [...this.epoch.baseline, ...history],
      cachePrefixLength: this.epoch.baseline.length,
      epoch: this.epoch,
    };
  }

  /**
   * Roll the epoch if — and only if — a structural input changed.
   *
   * Called before every model round-trip. Returning `undefined` on no change is
   * what makes the prefix stable across steps: the check is cheap, and doing it
   * every step is how a mid-turn model switch is caught without the caller having
   * to remember to announce it.
   *
   * The reason is derived from what actually differs rather than supplied by the
   * caller. An epoch roll is the single largest cost event in a turn, so a surface
   * reporting cost needs the cause to be true, and a caller that passed a
   * hard-coded reason would be right only by coincidence.
   */
  reconcile(inputs: BaselineInputs): CacheEpoch | undefined {
    const key = epochKey(inputs);
    if (key === this.epoch.key) return undefined;
    this.epoch = buildEpoch(this.epoch.index + 1, rollReason(this.epoch.inputs, inputs), inputs);
    return this.epoch;
  }

  /**
   * Roll unconditionally.
   *
   * For compaction, where the structural inputs are unchanged but the prefix must be
   * rebuilt because the history behind it was replaced.
   */
  roll(inputs: BaselineInputs, reason: EpochRollReason): CacheEpoch {
    this.epoch = buildEpoch(this.epoch.index + 1, reason, inputs);
    return this.epoch;
  }
}

/**
 * Name the most specific difference.
 *
 * Ordered by how much the difference costs to explain, not alphabetically: a model
 * switch is the thing an operator most needs to see, and a permission change is the
 * thing a security-conscious reader most needs to see.
 */
function rollReason(before: BaselineInputs, after: BaselineInputs): EpochRollReason {
  if (before.model !== after.model) return 'model-switch';
  if (
    before.sandboxMode !== after.sandboxMode ||
    before.approvals !== after.approvals ||
    before.enforcement !== after.enforcement
  ) {
    return 'permission-change';
  }
  if ((before.instructions ?? '') !== (after.instructions ?? '')) return 'instructions-change';
  return 'tool-set-change';
}

function buildEpoch(index: number, reason: EpochRollReason, inputs: BaselineInputs): CacheEpoch {
  const baseline = renderBaseline(inputs);
  return {
    index,
    reason,
    baseline,
    fingerprint: fingerprintOf(baseline),
    key: epochKey(inputs),
    inputs,
  };
}

/**
 * SHA-256 over the baseline's text.
 *
 * Over the *content* rather than over `JSON.stringify` of the messages, because the
 * claim being made is about the bytes the provider receives. A fingerprint that
 * covered wrapper fields would stay stable across a change that actually reached the
 * model, which would make the byte-stability test pass while the property failed.
 */
export function fingerprintOf(messages: readonly ConversationMessage[]): string {
  const hasher = createHash('sha256');
  for (const message of messages) {
    hasher.update(message.role, 'utf8');
    for (const block of message.content) {
      hasher.update(block.type === 'text' ? block.text : block.data, 'utf8');
    }
  }
  return hasher.digest('hex');
}

/**
 * Serialize history for replay comparison.
 *
 * Exported so a test can assert that a trajectory replayed through a fresh
 * assembler produces the same prompt — the concrete meaning of ADR-0003's
 * "the trajectory is the prompt".
 */
export function serializeHistory(messages: readonly ConversationMessage[]): string {
  return JSON.stringify(messages);
}
