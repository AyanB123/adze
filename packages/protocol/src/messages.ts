/**
 * The Adze message set.
 *
 * ADR-0001 rule 2: surfaces reach the engine *only* through this contract. So when
 * the CLI can do something the extension cannot, the missing piece is a message in
 * this file rather than a private back channel. That is the rule that keeps three
 * surfaces from becoming three products, and it is why this file — not a surface —
 * is the place to extend when a capability is missing.
 *
 * Direction is encoded in the two method lists at the bottom: `initialize`,
 * `session.*`, and `turn.*` go surface to engine; `approval.request` goes engine to
 * surface; `event` is an engine-to-surface notification with no reply.
 */

import { z } from 'zod';
import { AdzeEventSchema } from './events.js';
import {
  ApprovalPolicySchema,
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  AttachmentSchema,
  ModelSelectionSchema,
  SandboxConfigSchema,
  TurnBudgetSchema,
  UsageSchema,
  WarningSchema,
} from './primitives.js';
import { ProtocolVersionSchema } from './version.js';

export const METHOD = {
  Initialize: 'initialize',
  SessionCreate: 'session.create',
  SessionClose: 'session.close',
  TurnSubmit: 'turn.submit',
  TurnCancel: 'turn.cancel',
  ApprovalRequest: 'approval.request',
  Event: 'event',
} as const;

export type MethodName = (typeof METHOD)[keyof typeof METHOD];

// --------------------------------------------------------------- initialize

export const PeerInfoSchema = z.strictObject({
  /** e.g. `adze-cli`, `adze-vscode`. Appears in trajectory logs. */
  name: z.string().min(1),
  version: z.string().min(1),
  /** `process.platform`. Determines whether OS containment is available at all. */
  platform: z.string().min(1).optional(),
});
export type PeerInfo = z.infer<typeof PeerInfoSchema>;

export const InitializeParamsSchema = z.strictObject({
  /**
   * Every version the client speaks, not only its preferred one. Negotiation
   * intersects the two advertised sets — see `negotiateProtocolVersion`.
   */
  protocolVersions: z.array(ProtocolVersionSchema).min(1),
  client: PeerInfoSchema,
});
export type InitializeParams = z.infer<typeof InitializeParamsSchema>;

/**
 * What this engine build can actually do.
 *
 * Advertised rather than assumed, so a surface degrades deliberately instead of
 * calling a method that answers "not implemented". This is also how the roadmap
 * stays honest at runtime: a capability that is not built yet reports `false` here
 * instead of being quietly missing.
 */
export const EngineCapabilitiesSchema = z.strictObject({
  /** Model round-trips are available. False in an apply-only build. */
  turns: z.boolean(),
  /** The three-tier applier is available. */
  edits: z.boolean(),
  /** Retrieval (ripgrep, symbols) is available. */
  retrieval: z.boolean(),
  /**
   * The configured provider does native tool calling. False means `degraded`, and
   * ADR-0004 requires the surface to say so — we ship no JSON-in-a-string
   * fallback, because that path is where the measured ~7% rejection tax lives.
   */
  nativeToolCalling: z.boolean(),
  /** Images accepted as attachments and returned in tool results. */
  vision: z.boolean(),
  /** MCP servers can be attached as tools. */
  mcpClient: z.boolean(),
  /** Adze is addressable by other agents as an MCP server. */
  mcpServer: z.boolean(),
  /**
   * OS-level sandbox containment is available on this platform. False on Windows
   * today, and the surface must say so rather than let a user infer a boundary
   * that is not there (ADR-0007).
   */
  osSandbox: z.boolean(),
});
export type EngineCapabilities = z.infer<typeof EngineCapabilitiesSchema>;

export const InitializeResultSchema = z.strictObject({
  /** The single agreed version. Both peers speak exactly this afterwards. */
  protocolVersion: ProtocolVersionSchema,
  engine: PeerInfoSchema,
  capabilities: EngineCapabilitiesSchema,
  /** Startup-time limitations, reported once so every surface renders the same set. */
  warnings: z.array(WarningSchema).default([]),
});
export type InitializeResult = z.infer<typeof InitializeResultSchema>;

// ------------------------------------------------------------------ session

export const SessionCreateParamsSchema = z.strictObject({
  /**
   * Absolute path. Passed explicitly rather than inferred from the engine's own
   * cwd, because the engine may be a sidecar started from somewhere unrelated.
   */
  workspaceRoot: z.string().min(1),
  model: ModelSelectionSchema.optional(),
  sandbox: SandboxConfigSchema.optional(),
  approvals: ApprovalPolicySchema.optional(),
  /** Extra instructions, e.g. assembled from `AGENTS.md`. */
  instructions: z.string().optional(),
});
export type SessionCreateParams = z.infer<typeof SessionCreateParamsSchema>;

export const SessionCreateResultSchema = z.strictObject({
  sessionId: z.string().min(1),
  /**
   * The settings actually in force, which can differ from what was requested. A
   * surface must render what is real rather than what it asked for — showing the
   * requested mode when the engine narrowed it would be the worst possible lie in
   * a security display.
   */
  sandbox: SandboxConfigSchema,
  approvals: ApprovalPolicySchema,
  model: ModelSelectionSchema,
  warnings: z.array(WarningSchema).default([]),
});
export type SessionCreateResult = z.infer<typeof SessionCreateResultSchema>;

export const SessionCloseParamsSchema = z.strictObject({
  sessionId: z.string().min(1),
});
export type SessionCloseParams = z.infer<typeof SessionCloseParamsSchema>;

export const SessionCloseResultSchema = z.strictObject({
  /** Session totals, so a surface reports cost without accumulating it itself. */
  usage: UsageSchema.optional(),
  turns: z.number().int().nonnegative().default(0),
});
export type SessionCloseResult = z.infer<typeof SessionCloseResultSchema>;

// --------------------------------------------------------------------- turn

export const TurnSubmitParamsSchema = z.strictObject({
  sessionId: z.string().min(1),
  prompt: z.string().min(1),
  attachments: z.array(AttachmentSchema).default([]),
  budget: TurnBudgetSchema.optional(),
  /** Per-turn override. Absent means the session's settings apply unchanged. */
  sandbox: SandboxConfigSchema.optional(),
  approvals: ApprovalPolicySchema.optional(),
});
export type TurnSubmitParams = z.infer<typeof TurnSubmitParamsSchema>;

export const TurnSubmitResultSchema = z.strictObject({
  turnId: z.string().min(1),
});
export type TurnSubmitResult = z.infer<typeof TurnSubmitResultSchema>;

export const TurnCancelParamsSchema = z.strictObject({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
});
export type TurnCancelParams = z.infer<typeof TurnCancelParamsSchema>;

export const TurnCancelResultSchema = z.strictObject({
  /**
   * False when the turn had already finished. Not an error: a cancel racing a
   * completion is normal, and making it an error would force every surface to
   * special-case a race it cannot avoid.
   */
  cancelled: z.boolean(),
});
export type TurnCancelResult = z.infer<typeof TurnCancelResultSchema>;

// ----------------------------------------------------------------- streaming

/**
 * Notification, not a request. No reply is permitted, so a slow surface cannot
 * stall the engine's loop by failing to acknowledge output.
 */
export const EventParamsSchema = z.strictObject({
  event: AdzeEventSchema,
});
export type EventParams = z.infer<typeof EventParamsSchema>;

// ------------------------------------------------------------------ registry

/**
 * Params and result schema for every method, keyed by name.
 *
 * One table rather than schemas scattered across call sites: a transport can then
 * validate both directions generically, and "which methods exist" has exactly one
 * answer instead of one per surface.
 */
export const METHOD_SCHEMAS = {
  [METHOD.Initialize]: { params: InitializeParamsSchema, result: InitializeResultSchema },
  [METHOD.SessionCreate]: { params: SessionCreateParamsSchema, result: SessionCreateResultSchema },
  [METHOD.SessionClose]: { params: SessionCloseParamsSchema, result: SessionCloseResultSchema },
  [METHOD.TurnSubmit]: { params: TurnSubmitParamsSchema, result: TurnSubmitResultSchema },
  [METHOD.TurnCancel]: { params: TurnCancelParamsSchema, result: TurnCancelResultSchema },
  [METHOD.ApprovalRequest]: { params: ApprovalRequestSchema, result: ApprovalResponseSchema },
  /**
   * `result: null` marks a notification. Different from a request whose result
   * happens to be empty: replying to this at all is a protocol violation.
   */
  [METHOD.Event]: { params: EventParamsSchema, result: null },
} as const;

/** Surface to engine. */
export const CLIENT_METHODS: readonly MethodName[] = [
  METHOD.Initialize,
  METHOD.SessionCreate,
  METHOD.SessionClose,
  METHOD.TurnSubmit,
  METHOD.TurnCancel,
];

/** Engine to surface. */
export const ENGINE_METHODS: readonly MethodName[] = [METHOD.ApprovalRequest, METHOD.Event];

export function isMethodName(value: string): value is MethodName {
  return Object.hasOwn(METHOD_SCHEMAS, value);
}

export type ParseOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly z.core.$ZodIssue[] };

/**
 * Parse a method's params.
 *
 * Returns a discriminated result rather than throwing, because the caller has to
 * turn a failure into a JSON-RPC `InvalidParams` error carrying the issue list.
 * An exception would discard the structure that makes that error useful to whoever
 * has to fix the caller.
 */
export function parseParams<M extends MethodName>(
  method: M,
  params: unknown,
): ParseOutcome<z.infer<(typeof METHOD_SCHEMAS)[M]['params']>> {
  const schema: (typeof METHOD_SCHEMAS)[M]['params'] = METHOD_SCHEMAS[method].params;
  const parsed = schema.safeParse(params);
  if (parsed.success) {
    return { ok: true, value: parsed.data as z.infer<(typeof METHOD_SCHEMAS)[M]['params']> };
  }
  return { ok: false, issues: parsed.error.issues };
}

/** One line per issue, `path: message`. Suitable for a JSON-RPC error `data`. */
export function formatIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}
