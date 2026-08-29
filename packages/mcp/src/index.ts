/**
 * `@adze/mcp` — Adze as an MCP client and an MCP server.
 *
 * MCP is extension surface 1 of 6 in ADR-0008, and the only one that ships a
 * settled external standard. Adze is deliberately on both ends of it:
 *
 * - **Client.** {@link McpClientHost} connects to configured servers, discovers
 *   their tools, resources, and prompts, and {@link mcpToolsFor} hands the tools to
 *   `EngineOptions.extraTools`. Thousands of existing servers work with no work
 *   from us, which is why Adze has no tool protocol of its own.
 * - **Server.** {@link AdzeMcpServer} exposes injected Adze capabilities so another
 *   agent can drive Adze. Tools arrive through {@link AdzeToolImplementation}
 *   because service packages do not import each other; a surface does the wiring.
 *
 * Transports are stdio and Streamable HTTP only. The standalone HTTP+SSE transport
 * was removed from the specification and is not offered.
 *
 * Nothing here reaches around the permission gate. A discovered MCP tool becomes a
 * `RegisteredTool` whose `execute` needs a `Grant`, and `PermissionGate.authorize`
 * is the only thing that can mint one.
 */

export type { ConnectDeps, ConnectOutcome, DeathCause } from './client.js';
export { connectServer, discoverServer, McpClientHost, McpConnection } from './client.js';
export type { MapResultOptions } from './content.js';
export { DEFAULT_MAX_RESULT_BYTES, mapCallToolResult } from './content.js';
export { adzeToolName, sanitizeSegment } from './naming.js';
export { describeEnvKeys, SecretRegistry } from './redact.js';
export type { AdzeMcpServerOptions } from './server.js';
export { AdzeMcpServer } from './server.js';
export type { StdioParametersOutcome } from './stdio.js';
export { buildStdioParameters } from './stdio.js';
export { mcpTool, mcpTools, mcpToolsFor } from './tools.js';
export type {
  AdzeToolImplementation,
  AdzeToolOutcome,
  McpDiscovery,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpServerConfig,
  McpToolDescriptor,
  McpTransportKind,
} from './types.js';
export type { RevisionOutcome } from './version.js';
export {
  ADZE_ACCEPTED_REVISIONS,
  ADZE_PREFERRED_REVISION,
  negotiateRevision,
  RevisionRecordingTransport,
} from './version.js';
