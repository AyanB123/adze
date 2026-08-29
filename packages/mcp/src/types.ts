/**
 * MCP vocabulary for Adze.
 *
 * Two halves live in this package and they point in opposite directions.
 *
 * **The client half** consumes the existing ecosystem: thousands of MCP servers
 * already exist, so every one of them becomes an Adze tool without us inventing a
 * tool protocol (ADR-0008, surface 1 of 6).
 *
 * **The server half** exposes Adze so other agents — Claude Code, Codex, anything
 * that speaks MCP — can drive it. That half takes its tools by *injection*, because
 * service packages may not import each other: `@adze/mcp` cannot reach into
 * `@adze/apply` or `@adze/retrieval` to find something to expose. It declares
 * {@link AdzeToolImplementation} and a surface wires the concrete tools in.
 *
 * Nothing here bypasses the permission gate. A discovered MCP tool becomes a
 * {@link RegisteredTool} whose `execute` requires a `Grant`, which only
 * `PermissionGate.authorize` can mint, so architecture invariant 4 holds by
 * construction rather than by review.
 */

import type { JsonObject } from '@adze/protocol';

// ---------------------------------------------------------------------------
// Server configuration
// ---------------------------------------------------------------------------

/**
 * How to reach a server.
 *
 * Only two transports, deliberately. The standalone HTTP+SSE transport was removed
 * from the specification, so implementing it would mean shipping a client for a
 * transport no conforming server is required to speak. SSE survives only as a
 * request-scoped response stream *inside* Streamable HTTP, which the SDK's
 * Streamable HTTP transport handles internally and which is therefore not a
 * separate choice here.
 */
export type McpTransportKind = 'stdio' | 'http';

/**
 * A server Adze should connect to as a client.
 *
 * `command`/`args` are kept as separate fields all the way down to `spawn`, never
 * joined into a string. See {@link buildStdioParameters} for why that is a security
 * property rather than a style preference.
 */
export interface McpServerConfig {
  /** Stable local name. Used to namespace tool names, so it must be unique. */
  readonly name: string;
  readonly transport: McpTransportKind;

  /** stdio only: the executable. Never passed through a shell. */
  readonly command?: string;
  /** stdio only: argv after the executable. Each element stays one argument. */
  readonly args?: readonly string[];
  /** stdio only: working directory for the child. */
  readonly cwd?: string;
  /**
   * Extra environment for the child.
   *
   * Frequently credentials. Values here are never logged, never copied into a tool
   * descriptor, and never included in an error message — see {@link redactSecrets}.
   */
  readonly env?: Readonly<Record<string, string>>;

  /** http only: the Streamable HTTP endpoint. */
  readonly url?: string;
  /** http only: extra headers, e.g. an authorization header. Treated as secret. */
  readonly headers?: Readonly<Record<string, string>>;

  /**
   * Tools the operator is willing to have approved without being asked, provided
   * the server itself declares them read-only.
   *
   * This is *advice to the surface*, not a gate bypass. `@adze/mcp` never
   * short-circuits authorization; it records the request on the descriptor and the
   * surface decides how to feed it into an `ApprovalPolicy`. A name listed here
   * that the server does not mark `readOnlyHint` produces a warning and is not
   * honoured, because silently trusting a mutating tool because a config file
   * asked nicely is exactly the bypass invariant 4 exists to prevent.
   */
  readonly autoApprove?: readonly string[];

  /** Wall-clock ceiling for the connect handshake. */
  readonly connectTimeoutMs?: number;
  /** Wall-clock ceiling for one tool call. */
  readonly requestTimeoutMs?: number;
  /** Hard cap on the bytes one tool result may contribute to the context. */
  readonly maxResultBytes?: number;
}

// ---------------------------------------------------------------------------
// What discovery produces
// ---------------------------------------------------------------------------

/** A tool a server advertises, after name namespacing and read-only classification. */
export interface McpToolDescriptor {
  /** Namespaced, provider-safe Adze tool name. */
  readonly name: string;
  /** The name as the server knows it. What goes back over the wire. */
  readonly remoteName: string;
  readonly serverName: string;
  readonly description: string;
  /** The server's own JSON Schema, passed through unmodified. */
  readonly inputSchema: JsonObject;
  /** True only when the server declares `annotations.readOnlyHint`. */
  readonly readOnly: boolean;
  /** True when the operator listed it in `autoApprove` *and* `readOnly` holds. */
  readonly autoApprove: boolean;
}

export interface McpResourceDescriptor {
  readonly uri: string;
  readonly serverName: string;
  readonly name?: string;
  readonly description?: string;
  readonly mediaType?: string;
}

export interface McpPromptDescriptor {
  readonly name: string;
  readonly serverName: string;
  readonly description?: string;
}

/**
 * Everything one server offered, plus what went wrong.
 *
 * A server that advertises `tools` but fails `resources/list` still yields its
 * tools. Discovery is per-capability and partial failure is recorded rather than
 * thrown, because one broken capability on one server must not cost the user every
 * other server's tools.
 */
export interface McpDiscovery {
  readonly serverName: string;
  readonly tools: readonly McpToolDescriptor[];
  readonly resources: readonly McpResourceDescriptor[];
  readonly prompts: readonly McpPromptDescriptor[];
  /** Non-fatal problems, already redacted. Addressed to an operator. */
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// The server half's injection seam
// ---------------------------------------------------------------------------

/** What an injected tool returns. Mirrors MCP's `isError` convention. */
export interface AdzeToolOutcome {
  readonly ok: boolean;
  readonly text: string;
}

/**
 * One Adze capability, exposed over MCP.
 *
 * The interface exists so this package can expose `edit`, `grep`, or `read`
 * without importing the packages that implement them. `@adze/apply` and
 * `@adze/retrieval` are siblings, and siblings do not import each other — that is
 * what keeps them individually swappable. A surface holds references to both and
 * is the natural place to adapt them to this shape.
 */
export interface AdzeToolImplementation {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments. Advertised to the peer verbatim. */
  readonly inputSchema: JsonObject;
  /** Advertised as `annotations.readOnlyHint`. Defaults to false. */
  readonly readOnly?: boolean;
  invoke(args: JsonObject, signal: AbortSignal): Promise<AdzeToolOutcome>;
}
