/**
 * Shared vocabulary for the wire contract.
 *
 * Everything here is deliberately re-declared rather than imported from the
 * package that implements it. `@adze/protocol` depends on nothing but `zod`,
 * because a contract with dependencies is not a contract — if `protocol`
 * imported `@adze/apply`, then every surface would transitively depend on a
 * specific applier implementation and the boundary would be decorative.
 *
 * The cost of that rule is real: the apply vocabulary below must stay in step
 * with `@adze/apply`'s own types by hand. The check lives where both packages
 * are already present — see `packages/cli/test/protocol-conformance.test.ts`,
 * which parses real `@adze/apply` output against these schemas.
 *
 * Every object here is a `strictObject`: an unknown key is rejected, not
 * silently stripped. That is a deliberate trade. Stripping would give free
 * forward compatibility, at the price of an older surface quietly discarding a
 * field a newer engine considered important — the exact class of failure that is
 * impossible to diagnose from the receiving end. Rejecting is only safe because
 * version negotiation exists: both peers agree on one version before any other
 * message is sent (see `version.ts`), so after that point an unexpected key is a
 * bug rather than evolution. The cost we accept is that adding a field is a
 * minor-version change, which it should have been anyway.
 *
 * Design rationale: docs/architecture/README.md §4.
 */

import { z } from 'zod';
import { JsonObjectSchema } from './json.js';

// ---------------------------------------------------------------------------
// Sandbox and approvals — ADR-0007
// ---------------------------------------------------------------------------

/**
 * What the process is permitted to do. Orthogonal to {@link ApprovalPolicySchema}
 * on purpose: collapsing the two axes into one "safety level" dial is what
 * produces approval fatigue, because the only way to reduce prompts becomes
 * reducing containment.
 */
export const SandboxModeSchema = z.enum(['read-only', 'workspace-write', 'full-access']);
export type SandboxMode = z.infer<typeof SandboxModeSchema>;

/** When the user is asked. `never` refuses rather than escalating. */
export const ApprovalPolicySchema = z.enum(['untrusted', 'on-request', 'never']);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

/** ADR-0007's default: prompt only for what the sandbox would otherwise block. */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = 'on-request';
export const DEFAULT_SANDBOX_MODE: SandboxMode = 'workspace-write';

/**
 * True when the policy forbids prompting, in which case the gate must refuse.
 *
 * A named predicate so no call site re-derives the rule and the ADR-0007 refusal
 * semantics live in exactly one place. A policy that silently granted more than
 * it advertised would make the entire model untrustworthy, so this is the one
 * behaviour that must not be reimplemented per surface.
 */
export function refusesRatherThanPrompts(policy: ApprovalPolicy): boolean {
  return policy === 'never';
}

/**
 * How a sandbox mode is actually enforced on a given platform.
 *
 * Deliberately not a boolean. A boolean forces each call site to decide what
 * `false` means, and the two false-ish cases need different words in front of a
 * user: `gate-only` is a real, documented reduction in protection, while
 * `not-applicable` means the user asked for no containment and got exactly that.
 *
 * Returns `gate-only` on Windows for both containment modes. There is no
 * OS-level containment there yet — not in Adze and not in any open-source coding
 * agent (ADR-0007). This is a shared function rather than a per-surface
 * `if (process.platform === 'win32')` precisely so that one surface cannot
 * quietly forget to warn.
 */
export type SandboxEnforcement = 'os-level' | 'gate-only' | 'not-applicable';

export function sandboxEnforcement(platform: string, mode: SandboxMode): SandboxEnforcement {
  if (mode === 'full-access') return 'not-applicable';
  // darwin: Seatbelt. linux: bubblewrap. Everything else, win32 included: none.
  return platform === 'darwin' || platform === 'linux' ? 'os-level' : 'gate-only';
}

/** Per-command override, so `npm test` can be allowed without widening the mode. */
export const CommandRuleSchema = z.strictObject({
  /** Matched against the start of the argv-joined command string. */
  prefix: z.string().min(1),
  action: z.enum(['allow', 'prompt', 'forbid']),
});
export type CommandRule = z.infer<typeof CommandRuleSchema>;

export const SandboxConfigSchema = z.strictObject({
  mode: SandboxModeSchema,
  /**
   * Absolute paths the agent may write to under `workspace-write`. Empty means
   * the workspace root only. Listing this explicitly rather than deriving it is
   * what lets a caller widen writes without widening the mode.
   */
  writableRoots: z.array(z.string()).default([]),
  /** Hosts reachable when the mode would otherwise deny network. */
  allowedNetworkHosts: z.array(z.string()).default([]),
  commandRules: z.array(CommandRuleSchema).default([]),
});
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

// ---------------------------------------------------------------------------
// Attachments — ADR-0004 requires vision as a first-class path
// ---------------------------------------------------------------------------

/**
 * Image formats every supported provider accepts. Narrow on purpose: an
 * attachment the gateway cannot forward is better rejected at the protocol
 * boundary than three layers later.
 */
export const ImageMediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export type ImageMediaType = z.infer<typeof ImageMediaTypeSchema>;

export const TextAttachmentSchema = z.strictObject({
  type: z.literal('text'),
  /** Display name or path. Advisory only; never used to read from disk. */
  name: z.string().optional(),
  text: z.string(),
});

export const ImageAttachmentSchema = z.strictObject({
  type: z.literal('image'),
  name: z.string().optional(),
  mediaType: ImageMediaTypeSchema,
  /**
   * Base64 with no `data:` prefix.
   *
   * Bytes rather than a path because the engine may be out-of-process — the IDE
   * runs it as a sidecar so a closing window does not kill a running agent — and
   * a local path is not necessarily resolvable by the peer.
   */
  data: z.string(),
});

/**
 * Text or image. Text-only harnesses lose image-bearing tasks by roughly 12 to 1,
 * so images are part of the contract rather than an extension of it (ADR-0004).
 */
export const AttachmentSchema = z.discriminatedUnion('type', [
  TextAttachmentSchema,
  ImageAttachmentSchema,
]);
export type Attachment = z.infer<typeof AttachmentSchema>;

/**
 * Tool results carry the same block shape as user attachments, because ADR-0004
 * requires images to flow out of tools as well as in — a screenshot tool that
 * could only return text would defeat the point.
 */
export const ContentBlockSchema = AttachmentSchema;
export type ContentBlock = Attachment;

// ---------------------------------------------------------------------------
// Tools — ADR-0004
// ---------------------------------------------------------------------------

export const ToolCallSchema = z.strictObject({
  /** Provider-assigned id. Correlates a call with its result. */
  callId: z.string().min(1),
  name: z.string().min(1),
  /**
   * Arguments as the model produced them, already parsed by the provider's
   * native tool-calling path. There is deliberately no JSON-in-a-string variant:
   * that transport carries a measured ~7% invalid-JSON rejection tax on
   * open-weight models, concentrated in exactly the cheap models we care about.
   *
   * Typed as JSON rather than `Record<string, unknown>` so that a value which
   * cannot survive the wire — a `Date`, a class instance, a function — is
   * rejected here instead of arriving at the peer as `{}`.
   */
  arguments: JsonObjectSchema,
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** Present when and only when `ToolResult.truncated` is true. */
export const TruncationSchema = z.strictObject({
  originalBytes: z.number().int().nonnegative(),
  returnedBytes: z.number().int().nonnegative(),
  /**
   * Opaque token for requesting the next chunk. ADR-0004 requires truncation to
   * come with a way to ask for more; without it, truncation is data loss.
   */
  continuation: z.string().optional(),
});
export type Truncation = z.infer<typeof TruncationSchema>;

export const ToolResultSchema = z.strictObject({
  callId: z.string().min(1),
  ok: z.boolean(),
  content: z.array(ContentBlockSchema),
  /**
   * Explicit marker, never inferred by a surface from content length. Unbounded
   * tool output is a context-window denial-of-service, so the engine truncates —
   * and a silent truncation would make the model reason about a file it cannot
   * see the end of.
   */
  truncated: z.boolean(),
  truncation: TruncationSchema.optional(),
  durationMs: z.number().nonnegative().optional(),
  /** Failure detail when `ok` is false. Never a stack trace. */
  error: z.string().optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

/**
 * True when a result's truncation fields agree with its `truncated` marker.
 *
 * Kept as a predicate rather than a `.refine()` on {@link ToolResultSchema}
 * because JSON Schema cannot express the dependency, and a Zod schema that is
 * stricter than its published JSON Schema makes the generated artifact a lie
 * about what the wire accepts.
 */
export function toolResultTruncationIsConsistent(result: ToolResult): boolean {
  return result.truncated === (result.truncation !== undefined);
}

/**
 * Explicit plan state. ADR-0004 keeps `todo` as a real tool rather than letting
 * the model keep its plan in prose, because explicit plan state measurably
 * improves long-horizon coherence *and* is visible to the user, which a plan
 * buried in a paragraph is not.
 */
export const TodoStatusSchema = z.enum(['pending', 'in-progress', 'completed', 'cancelled']);
export type TodoStatus = z.infer<typeof TodoStatusSchema>;

export const TodoItemSchema = z.strictObject({
  id: z.string().min(1),
  content: z.string().min(1),
  status: TodoStatusSchema,
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

// ---------------------------------------------------------------------------
// Edits — the protocol half of ADR-0005
// ---------------------------------------------------------------------------

export const ApplyTierSchema = z.enum(['search-replace', 'whole-file', 'fast-apply']);
export type ApplyTier = z.infer<typeof ApplyTierSchema>;

/**
 * How a search block was located. The ladder stops at `anchored`; there is no
 * edit-distance strategy, because a near-miss on source code is a different
 * program.
 */
export const MatchStrategySchema = z.enum([
  'exact',
  'whitespace-normalized',
  'indentation-tolerant',
  'anchored',
]);
export type MatchStrategy = z.infer<typeof MatchStrategySchema>;

export const ApplyFailureReasonSchema = z.enum([
  'not-found',
  'ambiguous',
  'parse-broken',
  'file-too-large',
  'tier-unavailable',
  'no-op',
]);
export type ApplyFailureReason = z.infer<typeof ApplyFailureReasonSchema>;

/**
 * Which validator actually ran.
 *
 * `tree-sitter` is a real parse, `structural` is the always-available balance
 * check, `none` means the language was unknown and we declined to guess. This
 * field is a claim about evidence: widening a `structural` result to
 * `tree-sitter` would imply a parse that did not happen.
 */
export const ValidatorLevelSchema = z.enum(['tree-sitter', 'structural', 'none']);
export type ValidatorLevel = z.infer<typeof ValidatorLevelSchema>;

export const ValidationResultSchema = z.strictObject({
  ok: z.boolean(),
  validator: ValidatorLevelSchema,
  message: z.string().optional(),
  /** 1-based line where validation failed, when known. */
  line: z.number().int().positive().optional(),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export const MatchLocationSchema = z.strictObject({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  line: z.number().int().positive(),
  strategy: MatchStrategySchema,
});
export type MatchLocation = z.infer<typeof MatchLocationSchema>;

/**
 * Per-attempt telemetry. Aggregated across runs this is what produces "apply
 * success rate per model per tier" — a metric no other open-source tool
 * publishes, which makes it both a differentiator and an accountability
 * mechanism. It rides on the wire so surfaces can show it, not only benchmarks.
 */
export const ApplyTelemetrySchema = z.strictObject({
  tier: ApplyTierSchema,
  strategy: MatchStrategySchema.optional(),
  validation: ValidationResultSchema,
  durationMs: z.number().nonnegative(),
  tiersAttempted: z.number().int().nonnegative(),
  editCount: z.number().int().nonnegative(),
  bytesChanged: z.number().int().nonnegative(),
});
export type ApplyTelemetry = z.infer<typeof ApplyTelemetrySchema>;

export const EditBlockSchema = z.strictObject({
  /** Empty string means "insert at top of file". */
  search: z.string(),
  /** Empty string means "delete the matched region". */
  replace: z.string(),
  /**
   * 1-based occurrence selector. Omitting it makes a non-unique match an
   * `ambiguous` failure rather than a silent choice of the first match.
   */
  occurrence: z.number().int().positive().optional(),
});
export type EditBlock = z.infer<typeof EditBlockSchema>;

export const ProposedEditSchema = z.strictObject({
  editId: z.string().min(1),
  /** Workspace-relative path. */
  path: z.string().min(1),
  edits: z.array(EditBlockSchema),
  /** Whole-file replacement, when the model produced one for the Tier-2 path. */
  replacement: z.string().optional(),
});
export type ProposedEdit = z.infer<typeof ProposedEditSchema>;

/**
 * What a successful apply reports.
 *
 * The telemetry is contract, not diagnostics: aggregated across runs, `tier`,
 * `strategy`, and `validation.validator` are what produce "apply success rate per
 * model per tier" — the novel metric in docs/benchmarks/strategy.md. A surface may
 * choose not to display them; the protocol may not omit them.
 */
export const AppliedEditSchema = z.strictObject({
  editId: z.string().min(1),
  path: z.string().min(1),
  telemetry: ApplyTelemetrySchema,
  /** Where each edit landed. Empty for a whole-file rewrite, which locates nothing. */
  locations: z.array(MatchLocationSchema).default([]),
});
export type AppliedEdit = z.infer<typeof AppliedEditSchema>;

/**
 * What a refusal reports. A refusal is a **good** outcome — the alternative was a
 * corrupted file — so it travels as a normal result rather than as an error.
 */
export const RefusedEditSchema = z.strictObject({
  editId: z.string().min(1),
  path: z.string().min(1),
  reason: ApplyFailureReasonSchema,
  /**
   * Written for a **model** to read and retry against: what was tried, and what
   * would disambiguate. One round of feedback is the highest-value intervention
   * in the whole loop, which makes this string a functional part of the contract
   * rather than a log line.
   */
  message: z.string().min(1),
  /** Populated for `ambiguous`, so the caller can pick an occurrence. */
  candidates: z.array(MatchLocationSchema).optional(),
  telemetry: ApplyTelemetrySchema,
});
export type RefusedEdit = z.infer<typeof RefusedEditSchema>;

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export const ApprovalKindSchema = z.enum([
  'tool-call',
  'command',
  'file-write',
  'network',
  'escalate-sandbox',
]);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalRequestSchema = z.strictObject({
  requestId: z.string().min(1),
  kind: ApprovalKindSchema,
  /** One line, written for a human deciding in under two seconds. */
  summary: z.string().min(1),
  /** Why the gate stopped here — which rule or mode triggered the prompt. */
  reason: z.string().min(1),
  /** The command as it would run, for `command` requests. */
  command: z.array(z.string()).optional(),
  /** Paths the action would write, for `file-write` requests. */
  paths: z.array(z.string()).optional(),
  toolCall: ToolCallSchema.optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionSchema = z.enum([
  'allow-once',
  'allow-session',
  'deny',
  /** Deny and end the turn. Distinct from `deny`, which lets the agent adapt. */
  'abort',
]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalResponseSchema = z.strictObject({
  requestId: z.string().min(1),
  decision: ApprovalDecisionSchema,
  /** Surfaced back to the model when denied, so it can choose another route. */
  note: z.string().optional(),
});
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;

// ---------------------------------------------------------------------------
// Usage and cost — first-class because cost is the axis we intend to win
// ---------------------------------------------------------------------------

/**
 * Token accounting with the cache split kept explicit.
 *
 * `inputTokens` counts prompt tokens billed at the full rate. `cachedInputTokens`
 * counts prompt tokens served from the provider's cache. **They do not overlap**,
 * so the total prompt size is their sum. Getting that wrong double-counts the
 * cached tokens and makes reported cost diverge from the invoice, which is why
 * the split is in the contract rather than left to each surface.
 */
export const UsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Reported separately when a provider bills reasoning apart from output. */
  reasoningTokens: z.number().int().nonnegative().optional(),
  /**
   * Fraction of prompt tokens served from cache, in [0, 1].
   *
   * Present as a field rather than left to the consumer because it is a cost
   * metric disguised as a performance metric: cache economics move effective
   * cost by more than 10×, and the steady-state target is > 85%. Producers
   * should build this with {@link makeUsage} rather than by hand.
   */
  cacheHitRate: z.number().min(0).max(1),
});
export type Usage = z.infer<typeof UsageSchema>;

/**
 * Derive the cache hit rate from the token split.
 *
 * Zero when there were no prompt tokens at all — a turn that sent nothing has no
 * hit rate, and reporting 0% would read as a cache miss rather than as "not
 * applicable".
 */
export function computeCacheHitRate(inputTokens: number, cachedInputTokens: number): number {
  const prompt = inputTokens + cachedInputTokens;
  return prompt === 0 ? 0 : cachedInputTokens / prompt;
}

/**
 * Canonical {@link Usage} constructor.
 *
 * `cacheHitRate` is computed here rather than validated by a `.refine()`, so a
 * provider that rounds its own rate cannot fail an entire turn over a float
 * comparison. The schema checks the range; this function makes it correct.
 */
export function makeUsage(counts: {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
}): Usage {
  return {
    inputTokens: counts.inputTokens,
    cachedInputTokens: counts.cachedInputTokens,
    outputTokens: counts.outputTokens,
    ...(counts.reasoningTokens === undefined ? {} : { reasoningTokens: counts.reasoningTokens }),
    cacheHitRate: computeCacheHitRate(counts.inputTokens, counts.cachedInputTokens),
  };
}

export const CostSchema = z.strictObject({
  /** ISO 4217. Providers price in USD today; the field exists so that is checkable. */
  currency: z.string().length(3),
  inputUsd: z.number().nonnegative(),
  cachedInputUsd: z.number().nonnegative(),
  outputUsd: z.number().nonnegative(),
  totalUsd: z.number().nonnegative(),
});
export type Cost = z.infer<typeof CostSchema>;

// ---------------------------------------------------------------------------
// Budgets and models
// ---------------------------------------------------------------------------

/** Every budget is enforced and reported. An unenforced budget is a suggestion. */
export const TurnBudgetSchema = z.strictObject({
  maxSteps: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  maxWallClockMs: z.number().int().positive().optional(),
  maxSpendUsd: z.number().nonnegative().optional(),
});
export type TurnBudget = z.infer<typeof TurnBudgetSchema>;

export const ModelSelectionSchema = z.strictObject({
  /** Provider id as configured locally, e.g. `anthropic`. */
  provider: z.string().min(1),
  /**
   * A dated snapshot wherever the provider offers one. Benchmark reports are
   * required to pin this, so an alias here is a reproducibility hole.
   */
  model: z.string().min(1),
  /** Reasoning effort where the provider exposes it. */
  effort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  /** Omitted means "provider default", which reports must state explicitly. */
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/**
 * A limitation the user is entitled to know about, carried on the wire so every
 * surface reports it identically.
 *
 * `no-os-sandbox` exists because on Windows the permission gate and approval
 * policy apply but there is no OS-level containment (ADR-0007). Letting a user
 * infer containment that does not exist would be the worst kind of quiet
 * failure, so the engine says so and every surface has to render it.
 */
export const WarningCodeSchema = z.enum([
  'no-os-sandbox',
  'degraded-provider',
  'validator-downgraded',
  'network-unrestricted',
]);
export type WarningCode = z.infer<typeof WarningCodeSchema>;

export const WarningSchema = z.strictObject({
  code: WarningCodeSchema,
  message: z.string().min(1),
  /** Where to read the reasoning, e.g. an ADR path. */
  reference: z.string().optional(),
});
export type Warning = z.infer<typeof WarningSchema>;
