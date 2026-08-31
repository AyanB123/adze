/**
 * The permission gate.
 *
 * This is the single most important security property in the codebase: **every
 * tool call passes through here, including built-ins, and there is no code path
 * around it** (ADR-0007, architecture invariant 4).
 *
 * That is enforced structurally rather than by review. A tool's `execute` requires
 * a {@link Grant} in its context, `Grant` is branded with a symbol this module does
 * not export, and the only function that produces one is
 * {@link PermissionGate.authorize}. A tool cannot reach a subprocess or the
 * filesystem through the engine without one, because the grant *is* the
 * capability — not a token it presents to something else.
 *
 * ## Two axes, kept orthogonal
 *
 * Sandbox mode says what is permitted; approval policy says when the user is
 * asked. Collapsing them into a single "safety level" dial is what produces
 * approval fatigue, because the only way to reduce prompts becomes reducing
 * containment — and users who click through prompts blindly are in a worse
 * position than users who were never prompted, since the clicking manufactures
 * false confidence.
 *
 * ## `never` refuses
 *
 * `ApprovalPolicy: 'never'` does not silently widen the sandbox. When an action
 * would need approval and the policy forbids asking, the action is **refused**. A
 * policy that granted more than it advertised would make the entire model
 * untrustworthy, so this is the behaviour the gate is most explicitly tested for.
 *
 * The same rule applies when no approval channel is wired up at all: no channel
 * means no approval, which means refusal. Defaulting to allow there would turn a
 * missing surface callback into a silent full-access mode.
 *
 * ## Where containment actually comes from
 *
 * A command cannot be inspected for what it will do, so whether it needs approval
 * depends on whether anything is *containing* it. When the broker reports
 * `os-level` enforcement, `on-request` lets commands run: the sandbox is what
 * would stop them. When it reports `gate-only` — which is every platform today,
 * and Windows for the foreseeable future — the gate is all there is, so a command
 * is prompted. Command-prefix `allow` rules are the intended remedy: `npm test`
 * can be permitted without widening the boundary for everything.
 *
 * That is deliberately more conservative on Windows than on a platform with
 * containment, and it is the honest ordering. The alternative is claiming a
 * boundary that does not exist.
 */

import type {
  ApprovalDecision,
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalResponse,
  CommandRule,
  SandboxConfig,
  SandboxEnforcement,
  Warning,
} from '@adze/protocol';
import { refusesRatherThanPrompts, sandboxEnforcement } from '@adze/protocol';
import type { CommandOutcome, SandboxBroker } from './broker.js';
import { type EngineFileSystem, resolveWithinRoots } from './fs.js';
import type { Effect } from './types.js';

/**
 * Brand for {@link Grant}.
 *
 * Not exported. That is the whole mechanism: no module outside this file can name
 * this symbol, so no module outside this file can produce a value assignable to
 * `Grant`. A `as Grant` cast would still compile — TypeScript brands are not a
 * sandbox — but it is a single greppable lie rather than an accident, and the
 * accompanying source-level test asserts no built-in tool reaches for
 * `node:child_process` or `node:fs` directly.
 */
declare const GRANT_BRAND: unique symbol;

/** Options for a command a grant is executing. */
export interface GrantExecOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

/**
 * An authorization, and the capability it authorizes.
 *
 * Every method re-checks the operation against the effects the gate approved. That
 * is not redundant with the gate: it stops a tool that declared a read of `a.ts`
 * from writing `b.ts`, which the gate cannot catch because it only ever saw the
 * declaration. A tool whose declaration and behaviour disagree gets an error, not
 * a silent success.
 */
export interface Grant {
  readonly [GRANT_BRAND]: true;
  readonly callId: string;
  readonly effects: readonly Effect[];
  /** How the command will actually be contained. Reported, never assumed. */
  readonly enforcement: SandboxEnforcement;
  exec(command: readonly string[], options: GrantExecOptions): Promise<CommandOutcome>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
}

export interface AuthorizationRequest {
  readonly callId: string;
  readonly toolName: string;
  readonly effects: readonly Effect[];
  /** Shown to a human deciding in under two seconds. */
  readonly summary: string;
}

export type Authorization =
  | { readonly outcome: 'allow'; readonly grant: Grant }
  | {
      readonly outcome: 'deny';
      /** Written for the model: why, and what would work instead. */
      readonly reason: string;
      /** True when the turn must end rather than the agent adapting. */
      readonly abort: boolean;
    };

/** The surface-side approval channel. Maps to the protocol's `approval.request`. */
export type ApprovalRequester = (request: ApprovalRequest) => Promise<ApprovalResponse>;

export interface PermissionGateOptions {
  readonly workspaceRoot: string;
  readonly sandbox: SandboxConfig;
  readonly approvals: ApprovalPolicy;
  readonly broker: SandboxBroker;
  readonly fs: EngineFileSystem;
  readonly nextRequestId: () => string;
  readonly requestApproval?: ApprovalRequester;
  /** Defaults to `process.platform`. Injectable so both branches are testable. */
  readonly platform?: string;
}

type Verdict = 'allow' | 'prompt' | 'forbid';

interface EffectVerdict {
  readonly effect: Effect;
  readonly verdict: Verdict;
  /** Which rule or mode produced this verdict. Surfaced to the user and the model. */
  readonly reason: string;
}

export class PermissionGate {
  private readonly workspaceRoot: string;
  private readonly sandbox: SandboxConfig;
  private readonly approvals: ApprovalPolicy;
  private readonly broker: SandboxBroker;
  private readonly fs: EngineFileSystem;
  private readonly nextRequestId: () => string;
  private readonly requestApproval: ApprovalRequester | undefined;
  private readonly platform: string;
  /** Effect signatures the user approved for the whole session. */
  private readonly sessionAllowed = new Set<string>();

  constructor(options: PermissionGateOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.sandbox = options.sandbox;
    this.approvals = options.approvals;
    this.broker = options.broker;
    this.fs = options.fs;
    this.nextRequestId = options.nextRequestId;
    this.requestApproval = options.requestApproval;
    this.platform = options.platform ?? process.platform;
  }

  /** Roots a write may land in. Empty `writableRoots` means the workspace only. */
  private get writableRoots(): readonly string[] {
    return this.sandbox.writableRoots.length > 0
      ? this.sandbox.writableRoots
      : [this.workspaceRoot];
  }

  /** How this platform and broker actually contain the configured mode. */
  enforcement(): SandboxEnforcement {
    const declared = sandboxEnforcement(this.platform, this.sandbox.mode);
    if (declared !== 'os-level') return declared;
    // The platform could contain this, but the configured broker decides whether
    // it does. Reporting the platform's capability instead of the broker's would
    // claim containment nobody implemented.
    return this.broker.enforcement(this.sandbox.mode);
  }

  /**
   * Limitations this configuration carries, for `turn.started` and `initialize`.
   *
   * Emitted per turn rather than only at startup because a per-turn permission
   * override can introduce one.
   */
  warnings(): readonly Warning[] {
    const out: Warning[] = [];
    if (this.enforcement() === 'gate-only') {
      out.push({
        code: 'no-os-sandbox',
        message:
          `sandbox mode '${this.sandbox.mode}' is enforced by the permission gate only: ` +
          `there is no OS-level containment on this platform, so a command that is approved ` +
          `is not confined once it runs`,
        reference: 'docs/architecture/adr/0007-sandbox-and-permissions.md',
      });
    }
    if (this.sandbox.mode === 'full-access') {
      out.push({
        code: 'network-unrestricted',
        message: 'sandbox mode is full-access: filesystem and network are unrestricted',
        reference: 'docs/architecture/adr/0007-sandbox-and-permissions.md',
      });
    }
    return out;
  }

  /**
   * Authorize one tool call.
   *
   * The only producer of a {@link Grant}. Every branch either returns a denial or
   * mints exactly one grant scoped to the effects that were approved.
   */
  async authorize(request: AuthorizationRequest): Promise<Authorization> {
    const verdicts = await Promise.all(
      request.effects.map(async (effect) => await this.classify(effect)),
    );

    const forbidden = verdicts.find((v) => v.verdict === 'forbid');
    if (forbidden !== undefined) {
      // A `forbid` rule is absolute and is never offered for approval. Prompting
      // to override an explicit prohibition would make the rule advisory.
      return { outcome: 'deny', reason: forbidden.reason, abort: false };
    }

    const needsPrompt = this.promptRequired(verdicts);
    if (needsPrompt.length > 0) {
      const decision = await this.seekApproval(request, needsPrompt);
      if (decision.outcome === 'deny') return decision;
    }

    return { outcome: 'allow', grant: this.mintGrant(request) };
  }

  /**
   * Which effects require asking, given the policy.
   *
   * `untrusted` asks about everything the sandbox would have allowed too — that is
   * what the mode means. The other two policies only ask about effects the sandbox
   * would block.
   *
   * **A call that declares no effects is never prompted, including under
   * `untrusted`.** ADR-0007 words that policy as "approve every action", and this is
   * a deliberate narrowing to "every action that does something": `todo` changes
   * session state, and `task` runs a subagent whose own calls are each authorized
   * under this same policy. Prompting for those asks the user to decide something
   * with no security content, and manufacturing prompts nobody can act on is how
   * approval fatigue starts — which ADR-0007 names as the failure worse than not
   * prompting at all. The call still passes through the gate; it simply has nothing
   * to weigh.
   */
  private promptRequired(verdicts: readonly EffectVerdict[]): readonly EffectVerdict[] {
    if (verdicts.length === 0) return [];
    if (this.approvals === 'untrusted') return verdicts;
    return verdicts.filter((v) => v.verdict === 'prompt');
  }

  private async seekApproval(
    request: AuthorizationRequest,
    pending: readonly EffectVerdict[],
  ): Promise<Authorization> {
    const outstanding = pending.filter((v) => !this.sessionAllowed.has(signature(v.effect)));
    if (outstanding.length === 0) return { outcome: 'allow', grant: this.mintGrant(request) };

    const reason = outstanding.map((v) => v.reason).join('; ');

    // ADR-0007: `never` refuses rather than escalating.
    if (refusesRatherThanPrompts(this.approvals)) {
      return {
        outcome: 'deny',
        reason:
          `refused: this action needs approval (${reason}) and the approval policy is ` +
          `'never', which refuses rather than escalating. Widen the sandbox mode or add a ` +
          `command rule if this should be permitted.`,
        abort: false,
      };
    }

    if (this.requestApproval === undefined) {
      // No channel means no approval. Allowing here would turn a missing surface
      // callback into an undeclared full-access mode.
      return {
        outcome: 'deny',
        reason:
          `refused: this action needs approval (${reason}) but no approval channel is ` +
          `connected, so consent cannot be obtained.`,
        abort: false,
      };
    }

    const response = await this.requestApproval(
      buildApprovalRequest(this.nextRequestId(), request, outstanding, reason),
    );
    return this.applyDecision(request, outstanding, response);
  }

  private applyDecision(
    request: AuthorizationRequest,
    outstanding: readonly EffectVerdict[],
    response: ApprovalResponse,
  ): Authorization {
    const note = response.note === undefined ? '' : ` (${response.note})`;
    const decision: ApprovalDecision = response.decision;
    switch (decision) {
      case 'allow-session':
        for (const v of outstanding) this.sessionAllowed.add(signature(v.effect));
        return { outcome: 'allow', grant: this.mintGrant(request) };
      case 'allow-once':
        return { outcome: 'allow', grant: this.mintGrant(request) };
      case 'deny':
        return { outcome: 'deny', reason: `the user denied this action${note}`, abort: false };
      case 'abort':
        return {
          outcome: 'deny',
          reason: `the user aborted the turn${note}`,
          abort: true,
        };
    }
  }

  /** Decide one effect against the sandbox mode and the command rules. */
  private async classify(effect: Effect): Promise<EffectVerdict> {
    switch (effect.kind) {
      case 'command':
        return this.classifyCommand(effect);
      case 'file-read':
        return await this.classifyRead(effect);
      case 'file-write':
        return await this.classifyWrite(effect);
      case 'network':
        return this.classifyNetwork(effect);
    }
  }

  private classifyCommand(effect: Extract<Effect, { kind: 'command' }>): EffectVerdict {
    // Rules match what the model asked to run, not the argv we execute. Matching the
    // argv meant every shell command was tested as `bash -lc ...`, so `--forbid "rm "`
    // could not block `rm -rf /` and `--allow "npm test"` — the remedy this class
    // documents above — never fired. See ADR-0013.
    const command = effect.requested ?? effect.command.join(' ');
    const rule = matchCommandRule(this.sandbox.commandRules, command);
    if (rule !== undefined) {
      switch (rule.action) {
        case 'forbid':
          // Beats every mode, including full-access: an explicit prohibition is the
          // most specific statement of intent available.
          return {
            effect,
            verdict: 'forbid',
            reason: `command rule forbids the prefix '${rule.prefix}'`,
          };
        case 'allow':
          return {
            effect,
            verdict: 'allow',
            reason: `command rule allows the prefix '${rule.prefix}'`,
          };
        case 'prompt':
          return {
            effect,
            verdict: 'prompt',
            reason: `command rule requires approval for the prefix '${rule.prefix}'`,
          };
      }
    }

    if (this.sandbox.mode === 'full-access') {
      return { effect, verdict: 'allow', reason: 'sandbox mode is full-access' };
    }

    if (this.enforcement() === 'os-level') {
      return {
        effect,
        verdict: 'allow',
        reason: `command runs inside the '${this.sandbox.mode}' sandbox`,
      };
    }

    return {
      effect,
      verdict: 'prompt',
      reason:
        `running a command needs approval: sandbox mode '${this.sandbox.mode}' has no ` +
        `OS-level containment on this platform, so nothing would confine it`,
    };
  }

  private async classifyRead(
    effect: Extract<Effect, { kind: 'file-read' }>,
  ): Promise<EffectVerdict> {
    if (this.sandbox.mode === 'full-access') {
      return { effect, verdict: 'allow', reason: 'sandbox mode is full-access' };
    }
    // Reads are permitted anywhere the agent may also write, plus the workspace.
    const roots = [this.workspaceRoot, ...this.sandbox.writableRoots];
    const check = await resolveWithinRoots(effect.path, roots, this.fs);
    if (check.within) {
      return { effect, verdict: 'allow', reason: 'read inside the workspace' };
    }
    return {
      effect,
      verdict: 'prompt',
      reason: `reading '${check.path}' needs approval: it is outside the workspace`,
    };
  }

  private async classifyWrite(
    effect: Extract<Effect, { kind: 'file-write' }>,
  ): Promise<EffectVerdict> {
    if (this.sandbox.mode === 'full-access') {
      return { effect, verdict: 'allow', reason: 'sandbox mode is full-access' };
    }
    if (this.sandbox.mode === 'read-only') {
      return {
        effect,
        verdict: 'prompt',
        reason: `writing '${effect.path}' needs approval: sandbox mode is read-only`,
      };
    }
    const check = await resolveWithinRoots(effect.path, this.writableRoots, this.fs);
    if (check.within) {
      return { effect, verdict: 'allow', reason: `write inside '${check.root ?? ''}'` };
    }
    return {
      effect,
      verdict: 'prompt',
      reason:
        `writing '${check.path}' needs approval: it is outside the writable roots ` +
        `(${this.writableRoots.join(', ')})`,
    };
  }

  private classifyNetwork(effect: Extract<Effect, { kind: 'network' }>): EffectVerdict {
    if (this.sandbox.mode === 'full-access') {
      return { effect, verdict: 'allow', reason: 'sandbox mode is full-access' };
    }
    if (this.sandbox.allowedNetworkHosts.includes(effect.host)) {
      return { effect, verdict: 'allow', reason: `'${effect.host}' is on the network allowlist` };
    }
    return {
      effect,
      verdict: 'prompt',
      reason:
        `reaching '${effect.host}' needs approval: sandbox mode '${this.sandbox.mode}' ` +
        `denies network access unless the host is allowlisted`,
    };
  }

  /**
   * Create the one grant for this call.
   *
   * Private, and the only construction site of a `Grant` in the codebase. Each
   * capability closes over the approved effect list and refuses anything not in it.
   */
  private mintGrant(request: AuthorizationRequest): Grant {
    const { callId, effects } = request;
    const fs = this.fs;
    const broker = this.broker;
    const containment = {
      mode: this.sandbox.mode,
      writableRoots: this.writableRoots,
      allowedNetworkHosts: this.sandbox.allowedNetworkHosts,
    };
    const enforcement = this.enforcement();

    // Cast is confined to this one line and is what the unexported brand costs:
    // the object below satisfies every real member of `Grant`, and the brand exists
    // only to stop anything outside this module from doing the same.
    return {
      callId,
      effects,
      enforcement,
      async exec(command, options) {
        const joined = command.join(' ');
        const authorized = effects.some(
          (e) => e.kind === 'command' && e.command.join(' ') === joined,
        );
        if (!authorized) {
          throw new PermissionError(
            `tool '${request.toolName}' tried to run a command it did not declare: '${joined}'`,
          );
        }
        return await broker.exec({
          command,
          cwd: options.cwd,
          env: options.env ?? {},
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          containment,
          ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        });
      },
      async readFile(path) {
        assertDeclared(effects, 'file-read', path, request.toolName);
        return await fs.readFile(path);
      },
      async writeFile(path, contents) {
        assertDeclared(effects, 'file-write', path, request.toolName);
        await fs.writeFile(path, contents);
      },
    } as Grant;
  }
}

/** A tool acted outside what it declared. A bug in the tool, not a user decision. */
export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

function assertDeclared(
  effects: readonly Effect[],
  kind: 'file-read' | 'file-write',
  path: string,
  toolName: string,
): void {
  const declared = effects.some((e) => e.kind === kind && samePath(e.path, path));
  if (declared) return;
  throw new PermissionError(
    `tool '${toolName}' attempted a ${kind} on '${path}', which it did not declare`,
  );
}

function samePath(a: string, b: string): boolean {
  // Resolution only. Case folding is deliberately not applied: it would make two
  // distinct files on a case-sensitive filesystem look like one.
  return normalize(a) === normalize(b);
}

function normalize(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

/**
 * Longest matching prefix wins.
 *
 * `git push` must be able to override a broader `git` rule; taking the first
 * match in declaration order would make policy depend on config ordering, which
 * is the kind of rule nobody can reason about when it matters.
 */
export function matchCommandRule(
  rules: readonly CommandRule[],
  command: string,
): CommandRule | undefined {
  let best: CommandRule | undefined;
  for (const rule of rules) {
    if (!command.startsWith(rule.prefix)) continue;
    if (best === undefined || rule.prefix.length > best.prefix.length) best = rule;
  }
  return best;
}

/** Stable key for "the user already approved this exact thing". */
function signature(effect: Effect): string {
  switch (effect.kind) {
    case 'command':
      return `command:${effect.command.join(' ')}`;
    case 'file-read':
      return `file-read:${normalize(effect.path)}`;
    case 'file-write':
      return `file-write:${normalize(effect.path)}`;
    case 'network':
      return `network:${effect.host}`;
  }
}

function buildApprovalRequest(
  requestId: string,
  request: AuthorizationRequest,
  outstanding: readonly EffectVerdict[],
  reason: string,
): ApprovalRequest {
  const command = outstanding.find((v) => v.effect.kind === 'command')?.effect;
  const paths = outstanding
    .map((v) => v.effect)
    .filter(
      (e): e is Extract<Effect, { kind: 'file-read' | 'file-write' }> =>
        e.kind === 'file-read' || e.kind === 'file-write',
    )
    .map((e) => e.path);

  return {
    requestId,
    kind: approvalKind(outstanding),
    summary: request.summary,
    reason,
    ...(command !== undefined && command.kind === 'command'
      ? { command: [...command.command] }
      : {}),
    ...(paths.length > 0 ? { paths } : {}),
  };
}

function approvalKind(outstanding: readonly EffectVerdict[]): ApprovalRequest['kind'] {
  // Most specific first: a call that writes and also runs a command is reported as
  // a command, because that is the broader capability the user is being asked about.
  if (outstanding.some((v) => v.effect.kind === 'command')) return 'command';
  if (outstanding.some((v) => v.effect.kind === 'network')) return 'network';
  if (outstanding.some((v) => v.effect.kind === 'file-write')) return 'file-write';
  return 'tool-call';
}
