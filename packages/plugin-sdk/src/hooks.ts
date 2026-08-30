/**
 * Surface 4 — hooks. The surface that makes Adze policy-extensible.
 *
 * A hook can *veto* an action, which is the difference between extensible and
 * configurable: a team that needs "no writes under `infra/`" or "migrations require
 * human review" gets it by writing nine lines, not by waiting for us to ship a
 * policy feature and not by forking.
 *
 * ## Timeout is `allow`, and that is a deliberate reversal of `@adze/core`
 *
 * The spec is explicit: a hook that times out is treated as `allow` and logged
 * loudly, because failing closed on a slow hook makes the agent unusable and
 * failing silently hides a broken policy. **`@adze/core`'s `HookBus` does the
 * opposite** — its `tool.pre` timeout denies, and its header argues the case at
 * length: an unanswered veto is not consent.
 *
 * Both arguments are correct about different populations, so this package does not
 * change core. It resolves the conflict by *never letting a plugin timeout reach
 * core's bus*:
 *
 * - {@link HookHost} enforces each plugin's own `timeoutMs` and always answers.
 * - The adapter in `bridge.ts` registers with a budget larger than the sum of the
 *   plugin timeouts it owns, so core's outer timeout is unreachable rather than
 *   merely unlikely.
 * - Core's fail-closed rule still governs hooks a *surface* registers directly,
 *   which is where the "unanswered veto" argument holds: those are first-party.
 *
 * The consequence is stated rather than hidden: **a third-party hook that hangs
 * does not block the action it was installed to police.** The defence is that the
 * failure is loud — every timeout produces a diagnostic naming the plugin, the
 * event, and the budget it missed — plus {@link HookHostOptions.onFailure}, so an
 * operator who would rather stop the agent can say so.
 *
 * ## An erroring hook is treated the same as a slow one
 *
 * The spec does not say what happens when a hook throws. Core denies. This package
 * allows, because the spec's own reasoning does not distinguish the two: a hook
 * that cannot answer has not withheld consent, and an agent that stops working
 * because a plugin has a typo is the failure the spec chose to avoid. It is
 * reported at the same volume as a timeout, and `onFailure: 'deny'` covers the
 * operator who disagrees.
 *
 * ## Ordering, and why priorities are the wrong fix
 *
 * The spec lists hook ordering as an open question and worries that explicit
 * priority invites priority inflation. Implementing it makes the question smaller
 * than it looks: **ordering is only observable for `modify`.** Denials are
 * order-independent — if any hook denies, the outcome is a denial, and running the
 * remaining hooks could only change which reason is quoted. So this package uses
 * plain deterministic order (plugin load order, then declaration order within a
 * plugin), short-circuits on the first denial, and chains modifications. No
 * priority field, and none needed until someone shows two `modify` hooks whose
 * order actually matters.
 *
 * ## No hook may inject UI
 *
 * Architecture invariant 3. A hook returns data — text to inject, replacement
 * arguments, a denial reason — and there is no output shape in {@link HookOutput}
 * that can carry a widget, a panel, or markup. UI extension is per-surface.
 */

import type { ContentBlock, JsonObject, JsonValue } from '@adze/protocol';
import type { HookEvent, PluginDiagnostic } from './manifest.js';
import { canVeto, errorDiagnostic, warningDiagnostic } from './manifest.js';
import { callGuest, type GuestModule } from './wasm.js';

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export interface SessionStartPayload {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly model: string;
}

export interface TurnStartPayload {
  readonly sessionId: string;
  readonly turnId: string;
  readonly prompt: string;
  readonly cacheEpoch: number;
}

export interface ContextPrePayload {
  readonly sessionId: string;
  readonly turnId: string;
  /** Number of assembled blocks. The content itself is not sent; see below. */
  readonly blockCount: number;
  readonly estimatedTokens: number;
}

export interface ToolPrePayload {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

export interface ToolPostPayload {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly name: string;
  readonly ok: boolean;
  readonly text: string;
}

/**
 * What an `edit.pre` hook sees.
 *
 * `approvedByHuman` is the field the spec's own example depends on
 * (`!ctx.approved_by_human`), and it is supplied by the host rather than inferred:
 * plugin-sdk sits in front of the permission gate, so at `edit.pre` time no human
 * has been asked anything yet. A host that has an out-of-band approval — a signed
 * commit trailer, a ticket state — passes it in. It defaults to `false`, which is
 * the safe direction for a policy that requires review.
 */
export interface EditPrePayload {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly path: string;
  readonly edits: readonly { readonly search: string; readonly replace: string }[];
  readonly wholeFile: boolean;
  readonly approvedByHuman: boolean;
}

export interface EditPostPayload {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly path: string;
  readonly ok: boolean;
}

export interface SessionCompactPayload {
  readonly sessionId: string;
  readonly messageCount: number;
}

export interface TurnEndPayload {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stopReason: string;
  readonly steps: number;
}

export type HookPayload =
  | { readonly event: 'session.start'; readonly data: SessionStartPayload }
  | { readonly event: 'session.turnStart'; readonly data: TurnStartPayload }
  | { readonly event: 'context.pre'; readonly data: ContextPrePayload }
  | { readonly event: 'tool.pre'; readonly data: ToolPrePayload }
  | { readonly event: 'tool.post'; readonly data: ToolPostPayload }
  | { readonly event: 'edit.pre'; readonly data: EditPrePayload }
  | { readonly event: 'edit.post'; readonly data: EditPostPayload }
  | { readonly event: 'session.compact'; readonly data: SessionCompactPayload }
  | { readonly event: 'session.turnEnd'; readonly data: TurnEndPayload };

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/**
 * Everything a hook may return.
 *
 * Nothing here is display-shaped. `inject` carries text destined for the *model*,
 * which is a functional part of the loop rather than presentation — the same
 * distinction `@adze/core`'s types file draws.
 */
export type HookOutput =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  /** Replacement tool arguments. Re-validated against the tool's schema by core. */
  | { readonly kind: 'modify'; readonly arguments: JsonObject }
  /** Extra context for the model, as plain text. */
  | { readonly kind: 'inject'; readonly text: string }
  /** Replacement result text, for `tool.post`. */
  | { readonly kind: 'replace'; readonly text: string };

/** The resolved outcome of firing every hook for a veto event. */
export type HookDecision =
  | { readonly kind: 'allow' }
  | {
      readonly kind: 'deny';
      readonly reason: string;
      /** Which plugin said no, so a blocked action names what blocked it. */
      readonly pluginId: string;
    }
  | {
      readonly kind: 'modify';
      readonly arguments: JsonObject;
      /** Every plugin that contributed a rewrite, in the order applied. */
      readonly by: readonly string[];
    };

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

export type HookRecord =
  | {
      readonly kind: 'timeout';
      readonly pluginId: string;
      readonly event: HookEvent;
      readonly module: string;
      readonly timeoutMs: number;
      readonly elapsedMs: number;
      /** What the host did about it. */
      readonly treatedAs: 'allow' | 'deny';
    }
  | {
      readonly kind: 'error';
      readonly pluginId: string;
      readonly event: HookEvent;
      readonly module: string;
      readonly message: string;
      readonly treatedAs: 'allow' | 'deny';
    }
  | {
      readonly kind: 'malformed';
      readonly pluginId: string;
      readonly event: HookEvent;
      readonly message: string;
      readonly treatedAs: 'allow' | 'deny';
    }
  | {
      readonly kind: 'denied';
      readonly pluginId: string;
      readonly event: HookEvent;
      readonly reason: string;
    }
  | {
      readonly kind: 'modified';
      readonly pluginId: string;
      readonly event: HookEvent;
    }
  | {
      /** A rewrite that a later denial threw away. Spec open question 2. */
      readonly kind: 'modification-discarded';
      readonly pluginId: string;
      readonly event: HookEvent;
      readonly discardedBecause: string;
    };

/**
 * Where "logged loudly" goes.
 *
 * An observer rather than a `console` call, because this package is engine-side and
 * the engine renders nothing (ADR-0001). That is a real constraint rather than
 * pedantry: a `console.warn` from here would appear in a VS Code extension host log
 * nobody reads, which is precisely the silent failure the spec is trying to avoid.
 * A surface wires this to the thing its users actually see.
 *
 * The default is {@link recordingObserver}, which retains everything so
 * {@link HookHost.records} is never empty when something went wrong even if no
 * surface bothered. {@link consoleHookObserver} exists for a CLI.
 */
export interface HookObserver {
  record(record: HookRecord): void;
}

export interface RecordingObserver extends HookObserver {
  readonly records: readonly HookRecord[];
  clear(): void;
}

export function recordingObserver(): RecordingObserver {
  const records: HookRecord[] = [];
  return {
    records,
    record(record) {
      records.push(record);
    },
    clear() {
      records.length = 0;
    },
  };
}

/** For a surface that has a terminal. Only failures are surfaced. */
export function consoleHookObserver(): HookObserver {
  return {
    record(record) {
      if (record.kind === 'denied' || record.kind === 'modified') return;
      if (record.kind === 'timeout') {
        console.warn(
          `[adze:plugin] hook timeout: '${record.pluginId}' did not answer ${record.event} ` +
            `within ${record.timeoutMs} ms (took ${record.elapsedMs} ms). ` +
            `Treated as ${record.treatedAs}. The policy this hook enforces did not run.`,
        );
        return;
      }
      if (record.kind === 'modification-discarded') {
        console.warn(
          `[adze:plugin] '${record.pluginId}' rewrote ${record.event} and the rewrite was ` +
            `discarded: ${record.discardedBecause}`,
        );
        return;
      }
      console.warn(
        `[adze:plugin] hook ${record.kind}: '${record.pluginId}' on ${record.event}: ` +
          `${record.message}. Treated as ${record.treatedAs}.`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Registered hooks
// ---------------------------------------------------------------------------

export interface HookInstance {
  readonly pluginId: string;
  readonly event: HookEvent;
  /** Manifest-relative, for diagnostics that point at a file. */
  readonly module: string;
  readonly runtime: 'wasm' | 'js' | 'native';
  readonly timeoutMs: number;
  readonly exportName: string;
  readonly guest: GuestModule;
}

export interface HookHostOptions {
  readonly observer?: HookObserver;
  /**
   * What a timeout, a throw, or a malformed return means on a veto event.
   *
   * `'allow'` follows the spec and is the default. `'deny'` is for an operator who
   * would rather stop the agent than proceed past a policy hook that did not run —
   * a legitimate choice this package refuses to make on their behalf.
   */
  readonly onFailure?: 'allow' | 'deny';
}

export class HookHost {
  private readonly hooks: HookInstance[] = [];
  private readonly observer: HookObserver;
  private readonly onFailure: 'allow' | 'deny';
  private readonly collected: RecordingObserver;

  constructor(options: HookHostOptions = {}) {
    this.collected = recordingObserver();
    const external = options.observer;
    this.observer =
      external === undefined
        ? this.collected
        : {
            record: (record) => {
              this.collected.record(record);
              external.record(record);
            },
          };
    this.onFailure = options.onFailure ?? 'allow';
  }

  register(hook: HookInstance): void {
    this.hooks.push(hook);
  }

  get size(): number {
    return this.hooks.length;
  }

  /** Everything the host saw, whether or not a surface was listening. */
  get records(): readonly HookRecord[] {
    return this.collected.records;
  }

  /** Hooks bound to one event, in deterministic order. See the header. */
  forEvent(event: HookEvent): readonly HookInstance[] {
    return this.hooks.filter((hook) => hook.event === event);
  }

  /** Longest a single fire of `event` can take. Used to size core's budget. */
  budgetFor(event: HookEvent): number {
    return this.forEvent(event).reduce((total, hook) => total + hook.timeoutMs, 0);
  }

  /**
   * Fire a veto-capable event and resolve one decision.
   *
   * First denial wins and short-circuits. Modifications chain: each hook sees the
   * arguments the previous one produced, which is what lets a normalizing hook and
   * a policy hook compose without knowing about each other.
   */
  async fireDecision(
    event: 'tool.pre' | 'edit.pre',
    payload: ToolPrePayload | EditPrePayload,
    currentArguments: JsonObject,
  ): Promise<HookDecision> {
    const hooks = this.forEvent(event);
    if (hooks.length === 0) return { kind: 'allow' };

    let args = currentArguments;
    const modifiedBy: string[] = [];

    for (const hook of hooks) {
      const output = await this.invoke(hook, toJson(event, payload, args));

      if (output.kind === 'failure') {
        if (output.treatedAs === 'deny') {
          return {
            kind: 'deny',
            pluginId: hook.pluginId,
            reason:
              `hook '${hook.pluginId}' on ${event} ${output.summary}, and this host is ` +
              `configured to deny when a policy hook does not run`,
          };
        }
        continue;
      }

      const value = output.value;
      if (value.kind === 'deny') {
        // Spec open question 2: a discarded rewrite must be visible.
        for (const pluginId of modifiedBy) {
          this.observer.record({
            kind: 'modification-discarded',
            pluginId,
            event,
            discardedBecause: `'${hook.pluginId}' denied the action`,
          });
        }
        this.observer.record({ kind: 'denied', pluginId: hook.pluginId, event, reason: value.reason });
        return { kind: 'deny', pluginId: hook.pluginId, reason: value.reason };
      }

      if (value.kind === 'modify') {
        args = value.arguments;
        modifiedBy.push(hook.pluginId);
        this.observer.record({ kind: 'modified', pluginId: hook.pluginId, event });
        continue;
      }

      if (value.kind !== 'allow') {
        this.recordMalformed(
          hook,
          event,
          `returned '${value.kind}', which ${event} does not accept. Return allow, deny, or modify.`,
        );
      }
    }

    return modifiedBy.length === 0 ? { kind: 'allow' } : { kind: 'modify', arguments: args, by: modifiedBy };
  }

  /**
   * Fire an observe-or-enrich event and collect injected text.
   *
   * A denial from one of these is not honoured — `session.turnStart` is not a
   * permission boundary and treating it as one would give a hook a veto the spec
   * did not grant it. The attempt is recorded so the author finds out.
   */
  async fireInjection(
    event: 'session.start' | 'session.turnStart' | 'context.pre' | 'session.compact',
    payload: HookPayload,
  ): Promise<readonly ContentBlock[]> {
    const blocks: ContentBlock[] = [];
    for (const hook of this.forEvent(event)) {
      const output = await this.invoke(hook, payloadJson(payload));
      if (output.kind === 'failure') continue;
      const value = output.value;
      if (value.kind === 'inject') {
        blocks.push({ type: 'text', text: value.text });
        continue;
      }
      if (value.kind === 'allow') continue;
      this.recordMalformed(
        hook,
        event,
        `returned '${value.kind}'. ${event} may only return inject or allow; it is not a ` +
          `permission boundary, so a denial here is ignored.`,
      );
    }
    return blocks;
  }

  /** Fire `tool.post` and resolve the final text. Last replacement wins. */
  async fireToolPost(payload: ToolPostPayload): Promise<string> {
    let text = payload.text;
    for (const hook of this.forEvent('tool.post')) {
      const output = await this.invoke(
        hook,
        payloadJson({ event: 'tool.post', data: { ...payload, text } }),
      );
      if (output.kind === 'failure') continue;
      const value = output.value;
      if (value.kind === 'replace') {
        text = value.text;
        continue;
      }
      if (value.kind === 'allow') continue;
      this.recordMalformed(hook, 'tool.post', `returned '${value.kind}'; expected replace or allow.`);
    }
    return text;
  }

  /** Fire a notify-only event. Nothing a hook returns is honoured. */
  async fireNotification(event: 'edit.post' | 'session.turnEnd', payload: HookPayload): Promise<void> {
    for (const hook of this.forEvent(event)) {
      await this.invoke(hook, payloadJson(payload));
    }
  }

  /** Diagnostics for a surface, derived from what was recorded. */
  diagnostics(): readonly PluginDiagnostic[] {
    return this.collected.records.flatMap((record) => {
      if (record.kind === 'timeout') {
        return [
          errorDiagnostic(
            'hook-timeout',
            `plugin '${record.pluginId}' hook ${record.event} (${record.module}) did not answer ` +
              `within ${record.timeoutMs} ms and was treated as ${record.treatedAs}. ` +
              `The policy it enforces did not run for that action.`,
          ),
        ];
      }
      if (record.kind === 'error' || record.kind === 'malformed') {
        return [
          errorDiagnostic(
            'hook-error',
            `plugin '${record.pluginId}' hook ${record.event} failed: ${record.message}. ` +
              `Treated as ${record.treatedAs}.`,
          ),
        ];
      }
      if (record.kind === 'modification-discarded') {
        return [
          warningDiagnostic(
            'hook-error',
            `plugin '${record.pluginId}' rewrote ${record.event}, and the rewrite was discarded ` +
              `because ${record.discardedBecause}.`,
          ),
        ];
      }
      return [];
    });
  }

  private recordMalformed(hook: HookInstance, event: HookEvent, message: string): void {
    this.observer.record({
      kind: 'malformed',
      pluginId: hook.pluginId,
      event,
      message,
      treatedAs: canVeto(event) ? this.onFailure : 'allow',
    });
  }

  private async invoke(
    hook: HookInstance,
    input: JsonValue,
  ): Promise<
    | { readonly kind: 'value'; readonly value: HookOutput }
    | { readonly kind: 'failure'; readonly treatedAs: 'allow' | 'deny'; readonly summary: string }
  > {
    const treatedAs = canVeto(hook.event) ? this.onFailure : 'allow';
    const outcome = await callGuest(hook.guest, hook.exportName, input, hook.timeoutMs);

    if (outcome.kind === 'timeout') {
      this.observer.record({
        kind: 'timeout',
        pluginId: hook.pluginId,
        event: hook.event,
        module: hook.module,
        timeoutMs: hook.timeoutMs,
        elapsedMs: outcome.elapsedMs,
        treatedAs,
      });
      return { kind: 'failure', treatedAs, summary: `timed out after ${hook.timeoutMs} ms` };
    }

    if (outcome.kind === 'error') {
      this.observer.record({
        kind: 'error',
        pluginId: hook.pluginId,
        event: hook.event,
        module: hook.module,
        message: outcome.message,
        treatedAs,
      });
      return { kind: 'failure', treatedAs, summary: `failed: ${outcome.message}` };
    }

    const decoded = decodeHookOutput(outcome.value);
    if (!decoded.ok) {
      this.recordMalformed(hook, hook.event, decoded.message);
      return { kind: 'failure', treatedAs, summary: `returned an unusable value: ${decoded.message}` };
    }
    return { kind: 'value', value: decoded.output };
  }
}

// ---------------------------------------------------------------------------
// Decoding what a guest returned
// ---------------------------------------------------------------------------

export type DecodeOutcome =
  | { readonly ok: true; readonly output: HookOutput }
  | { readonly ok: false; readonly message: string };

/**
 * Parse a guest's return value.
 *
 * Strict on purpose. A guest that returns `{"kind":"denied"}` — plausible typo, and
 * the shape a model would generate — must not be read as a denial *or* silently
 * ignored: it is a malformed answer, reported as one. Accepting near-misses here
 * would make the deny contract depend on spelling.
 */
export function decodeHookOutput(value: JsonValue): DecodeOutcome {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      message: `expected an object such as {"kind":"allow"}, received ${describeJson(value)}`,
    };
  }

  const kind = value.kind;
  if (typeof kind !== 'string') {
    return { ok: false, message: 'the returned object has no string "kind" field' };
  }

  switch (kind) {
    case 'allow':
      return { ok: true, output: { kind: 'allow' } };
    case 'deny': {
      const reason = value.reason;
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        return {
          ok: false,
          message:
            'a denial must carry a non-empty "reason". A blocked action with no explanation ' +
            'is indistinguishable from a bug, and the model cannot adapt to it.',
        };
      }
      return { ok: true, output: { kind: 'deny', reason } };
    }
    case 'modify': {
      const args = value.arguments;
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        return { ok: false, message: 'a modification must carry an "arguments" object' };
      }
      return { ok: true, output: { kind: 'modify', arguments: args } };
    }
    case 'inject': {
      const text = value.text;
      if (typeof text !== 'string') {
        return { ok: false, message: 'an injection must carry "text"' };
      }
      return { ok: true, output: { kind: 'inject', text } };
    }
    case 'replace': {
      const text = value.text;
      if (typeof text !== 'string') {
        return { ok: false, message: 'a replacement must carry "text"' };
      }
      return { ok: true, output: { kind: 'replace', text } };
    }
    default:
      return {
        ok: false,
        message:
          `"${kind}" is not a hook result. Use allow, deny, modify, inject, or replace. ` +
          `Near-misses are refused rather than guessed at, because a denial that depends ` +
          `on spelling is not a policy.`,
      };
  }
}

function describeJson(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

// ---------------------------------------------------------------------------
// Payload serialization
// ---------------------------------------------------------------------------

function toJson(
  event: 'tool.pre' | 'edit.pre',
  payload: ToolPrePayload | EditPrePayload,
  args: JsonObject,
): JsonValue {
  if (event === 'tool.pre') {
    const data = payload as ToolPrePayload;
    return {
      event,
      sessionId: data.sessionId,
      turnId: data.turnId,
      callId: data.callId,
      name: data.name,
      arguments: args,
    };
  }
  const data = payload as EditPrePayload;
  return {
    event,
    sessionId: data.sessionId,
    turnId: data.turnId,
    callId: data.callId,
    path: data.path,
    edits: data.edits.map((edit) => ({ search: edit.search, replace: edit.replace })),
    wholeFile: data.wholeFile,
    approvedByHuman: data.approvedByHuman,
    arguments: args,
  };
}

/**
 * Serialize a payload for a guest.
 *
 * Written out per event rather than spread, so adding a field to a payload
 * interface fails to compile here instead of silently not reaching plugins — the
 * same reason `@adze/core`'s telemetry translation is written by hand.
 *
 * `context.pre` deliberately sends counts rather than the assembled context.
 * Shipping the whole prompt into every plugin on every turn is a data-egress
 * decision, not a convenience, and this package does not get to make it quietly.
 * That is a real limitation of `context.pre` as specified: see the README.
 */
function payloadJson(payload: HookPayload): JsonValue {
  switch (payload.event) {
    case 'session.start':
      return {
        event: payload.event,
        sessionId: payload.data.sessionId,
        workspaceRoot: payload.data.workspaceRoot,
        model: payload.data.model,
      };
    case 'session.turnStart':
      return {
        event: payload.event,
        sessionId: payload.data.sessionId,
        turnId: payload.data.turnId,
        prompt: payload.data.prompt,
        cacheEpoch: payload.data.cacheEpoch,
      };
    case 'context.pre':
      return {
        event: payload.event,
        sessionId: payload.data.sessionId,
        turnId: payload.data.turnId,
        blockCount: payload.data.blockCount,
        estimatedTokens: payload.data.estimatedTokens,
      };
    case 'tool.pre':
      return {
        event: payload.event,
        sessionId: payload.data.sessionId,
        turnId: payload.data.turnId,
        callId: payload.data.callId,
        name: payload.data.name,
        arguments: payload.data.arguments,
      };
    case 'tool.post':
      return {
        event: payload.event,
        sessionId: payload.data.sessionId,
        turnId: payload.data.turnId,
        callId: payload.data.callId,
        name: payload.data.name,
        ok: payload.data.ok,
        text: payload.data.text,
      };
    case 'edit.pre':
      return {
        event: payload.event,
        sessionId: payload.data.sessionId,
        turnId: payload.data.turnId,
        callId: payload.data.callId,
        path: payload.data.path,
        edits: payload.data.edits.map((edit) => ({ search: edit.search, replace: edit.replace })),
        wholeFile: payload.data.wholeFile,
        approvedByHuman: payload.data.approvedByHuman,
      };
    case 'edit.post':
      return {
        event: payload.event,
        sessionId: payload.data.sessionId,
        turnId: payload.data.turnId,
        callId: payload.data.callId,
        path: payload.data.path,
        ok: payload.data.ok,
      };
    case 'session.compact':
      return {
        event: payload.event,
        sessionId: payload.data.sessionId,
        messageCount: payload.data.messageCount,
      };
    case 'session.turnEnd':
      return {
        event: payload.event,
        sessionId: payload.data.sessionId,
        turnId: payload.data.turnId,
        stopReason: payload.data.stopReason,
        steps: payload.data.steps,
      };
  }
}
