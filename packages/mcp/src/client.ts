/**
 * The MCP client: consuming the existing ecosystem.
 *
 * This is the high-value half of the package. Thousands of MCP servers already
 * exist, so making them work as Adze tools is worth more than any tool we could
 * write ourselves — which is the whole reason Adze did not invent a tool protocol
 * (ADR-0008).
 *
 * ## The four robustness properties, and how each is obtained
 *
 * **A connection cannot hang.** Every handshake carries a timeout, and a handshake
 * that fails closes its transport before returning. Without that close, a server
 * that started but never answered `initialize` stays running with nobody holding a
 * reference — an orphan, and the process would not exit.
 *
 * **A crashed server cannot take down the engine.** Liveness is tracked from the
 * client's own `onclose`/`onerror` hooks, and a call against a dead connection
 * returns a failed {@link ToolExecution} rather than throwing. The distinction
 * matters because a throw out of a tool call reaches `dispatchToolCall`, which turns
 * it into a failed call anyway — but by then the turn has lost the chance to tell the
 * model *that the server died and the other tools still work*.
 *
 * **A server cannot exhaust the context window.** Results are bounded at this
 * boundary, with an explicit marker and a continuation. See `content.ts`.
 *
 * **Teardown leaves nothing running.** {@link McpClientHost.close} closes every
 * connection, including ones that failed mid-discovery, and does not stop at the
 * first error.
 *
 * ## Where the permission gate stays
 *
 * Nowhere in this file is a tool executed. Discovery produces descriptors;
 * `tools.ts` turns them into `RegisteredTool`s whose `execute` requires a `Grant`.
 * The only route to a `Grant` is `PermissionGate.authorize`, so there is no path
 * around the gate to write here even by accident.
 */

import type { ToolExecution } from '@adze/core';
import type { JsonObject } from '@adze/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Implementation, Tool } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_MAX_RESULT_BYTES, mapCallToolResult } from './content.js';
import { adzeToolName } from './naming.js';
import { describeEnvKeys, SecretRegistry } from './redact.js';
import { buildStdioParameters } from './stdio.js';
import type {
  McpDiscovery,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpServerConfig,
  McpToolDescriptor,
} from './types.js';
import type { InnerTransport } from './version.js';
import { negotiateRevision, RevisionRecordingTransport } from './version.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Adze's identity as an MCP client. */
const ADZE_CLIENT_INFO: Implementation = { name: 'adze', version: '0.0.1' };

/** Bytes of a stdio server's stderr kept for diagnosis. */
const STDERR_TAIL_BYTES = 4 * 1024;

export interface ConnectDeps {
  /**
   * A ready-made transport, bypassing construction from config.
   *
   * This is the seam the test suite uses: `InMemoryTransport.createLinkedPair()`
   * exercises the real `Client`, the real handshake, and the real request/response
   * path with no network, no subprocess, and no cost.
   */
  readonly transport?: InnerTransport;
  readonly clientInfo?: Implementation;
}

export type ConnectOutcome =
  | { readonly ok: true; readonly connection: McpConnection }
  | { readonly ok: false; readonly serverName: string; readonly message: string };

/** Why a connection is no longer usable. */
export type DeathCause = 'closed' | 'error' | 'shutdown';

/**
 * One live server.
 *
 * Constructed only by {@link connectServer}, so a connection that exists has
 * completed a handshake and has a revision agreed.
 */
export class McpConnection {
  private dead: DeathCause | undefined;
  private deadDetail = '';

  private constructor(
    readonly config: McpServerConfig,
    private readonly client: Client,
    private readonly recorder: RevisionRecordingTransport,
    private readonly secrets: SecretRegistry,
    private readonly stderrTail: () => string,
    readonly discovery: McpDiscovery,
  ) {
    // Observed rather than ignored: without these the first sign of a dead server is
    // a request that never settles, and the SDK would surface a transport error as an
    // unhandled rejection that could take the process down.
    this.client.onclose = () => this.markDead('closed', 'the server closed the connection');
    this.client.onerror = (error) => this.markDead('error', error.message);
  }

  get name(): string {
    return this.config.name;
  }

  /** The revision the handshake settled on. */
  get agreedRevision(): string | undefined {
    return this.recorder.agreedRevision;
  }

  get alive(): boolean {
    return this.dead === undefined;
  }

  /** Why the connection died, for a diagnostic. Empty while alive. */
  get deathReason(): string {
    if (this.dead === undefined) return '';
    const tail = this.stderrTail();
    const detail = this.secrets.redact(this.deadDetail);
    return tail.length > 0 ? `${detail}\nserver stderr:\n${this.secrets.redact(tail)}` : detail;
  }

  private markDead(cause: DeathCause, detail: string): void {
    // First cause wins. A crash produces an error *and* a close, and the error is the
    // one that says what happened.
    if (this.dead !== undefined) return;
    this.dead = cause;
    this.deadDetail = detail;
  }

  /**
   * Call a tool on this server.
   *
   * Never throws. Every failure — dead server, timeout, malformed reply, an error
   * the server reported — comes back as a {@link ToolExecution} with `ok: false` and a
   * message addressed to the model, because one round of feedback is the
   * highest-value intervention in the loop and a thrown exception carries none.
   */
  async callTool(
    remoteName: string,
    args: JsonObject,
    signal: AbortSignal | undefined,
  ): Promise<ToolExecution> {
    if (this.dead !== undefined) {
      return this.failure(
        `MCP server '${this.name}' is no longer running (${this.dead}), so ` +
          `'${remoteName}' cannot be called. Other tools are unaffected. ` +
          `${this.deathReason}`,
      );
    }

    const maxBytes = this.config.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    try {
      const result = await this.client.callTool(
        { name: remoteName, arguments: args },
        CallToolResultSchema,
        {
          timeout: this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
          ...(signal === undefined ? {} : { signal }),
        },
      );

      // `callTool`'s return type is a union with the pre-2025 compatibility shape,
      // which carries `toolResult` instead of `content`. Passing `CallToolResultSchema`
      // means only the modern shape can actually arrive, but the signature cannot say
      // so, and the absence of `content` is exactly what a malformed reply looks like —
      // so it is checked rather than asserted away.
      if (!Array.isArray(result.content)) {
        return this.failure(
          `MCP server '${this.name}' returned a reply for '${remoteName}' with no content ` +
            `blocks. Adze needs the current tools/call result shape.`,
        );
      }

      return mapCallToolResult(
        { ...result, content: result.content },
        {
          serverName: this.name,
          toolName: remoteName,
          maxBytes,
          secrets: this.secrets,
        },
      );
    } catch (error) {
      return this.failure(
        `MCP server '${this.name}' failed to run '${remoteName}': ` +
          `${this.secrets.redact(messageOf(error))}`,
      );
    }
  }

  private failure(text: string): ToolExecution {
    return { ok: false, content: [{ type: 'text', text }], error: text };
  }

  /**
   * Close the connection and stop the server.
   *
   * Idempotent and non-throwing. `Client.close` closes the transport, and the stdio
   * transport ends stdin, waits, sends SIGTERM, waits, then SIGKILL — so a server
   * that ignores a polite shutdown is still gone. Swallowing the error is deliberate:
   * a close that throws must not prevent the *next* connection from being closed.
   */
  async close(): Promise<void> {
    this.markDead('shutdown', 'closed by Adze');
    try {
      await this.client.close();
    } catch {
      // Already gone, or the transport objected on the way out. Either way there is
      // nothing left to do and nothing useful to report.
    }
  }

  /** @internal Used by {@link mcpTools} to build descriptors. */
  static create(
    config: McpServerConfig,
    client: Client,
    recorder: RevisionRecordingTransport,
    secrets: SecretRegistry,
    stderrTail: () => string,
    discovery: McpDiscovery,
  ): McpConnection {
    return new McpConnection(config, client, recorder, secrets, stderrTail, discovery);
  }
}

/**
 * Build the transport a config describes.
 *
 * Only two kinds, and `http` means Streamable HTTP. The standalone HTTP+SSE
 * transport is not offered: it was removed from the specification, and the SDK's
 * remaining `sse.js` is there for backwards compatibility with servers we would be
 * choosing to keep alive.
 */
function buildTransport(
  config: McpServerConfig,
):
  | { readonly ok: true; readonly transport: InnerTransport; readonly stderrTail: () => string }
  | { readonly ok: false; readonly message: string } {
  if (config.transport === 'stdio') {
    const params = buildStdioParameters(config);
    if (!params.ok) return { ok: false, message: params.message };

    const transport = new StdioClientTransport(params.parameters);
    // Bounded capture. An unbounded buffer on a server that logs in a loop is the
    // same denial-of-service as an unbounded tool result.
    let tail = '';
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      tail = `${tail}${String(chunk)}`.slice(-STDERR_TAIL_BYTES);
    });
    return { ok: true, transport, stderrTail: () => tail };
  }

  const url = config.url?.trim() ?? '';
  if (url.length === 0) {
    return {
      ok: false,
      message: `server '${config.name}' uses the http transport but declares no url.`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: `server '${config.name}' has an unparseable url.` };
  }

  const transport = new StreamableHTTPClientTransport(parsed, {
    ...(config.headers === undefined ? {} : { requestInit: { headers: { ...config.headers } } }),
  });
  return { ok: true, transport, stderrTail: () => '' };
}

/**
 * Connect to one server and discover what it offers.
 *
 * Returns a failure rather than throwing, because connecting to five servers where
 * one is misconfigured must yield four working connections and one clear message.
 */
export async function connectServer(
  config: McpServerConfig,
  deps: ConnectDeps = {},
): Promise<ConnectOutcome> {
  const secrets = new SecretRegistry([config.env, config.headers]);

  let inner: InnerTransport;
  let stderrTail: () => string = () => '';
  if (deps.transport !== undefined) {
    inner = deps.transport;
  } else {
    const built = buildTransport(config);
    if (!built.ok) return { ok: false, serverName: config.name, message: built.message };
    inner = built.transport;
    stderrTail = built.stderrTail;
  }

  const recorder = new RevisionRecordingTransport(inner);
  const client = new Client(deps.clientInfo ?? ADZE_CLIENT_INFO);

  try {
    await client.connect(recorder, {
      timeout: config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    });
  } catch (error) {
    // Close before returning. A handshake can fail *after* the child started, and a
    // child nobody holds a reference to is an orphan that keeps the process alive.
    await safeClose(client, recorder);
    return {
      ok: false,
      serverName: config.name,
      message:
        `could not connect to MCP server '${config.name}': ` +
        `${secrets.redact(messageOf(error))}. env supplied: ${describeEnvKeys(config.env)}.`,
    };
  }

  // The SDK already refuses a revision outside its supported set during `initialize`.
  // This re-checks against Adze's own accepted list, which is a separate claim: it is
  // what lets Adze narrow the ladder later without patching the SDK.
  const agreed = recorder.agreedRevision;
  if (agreed !== undefined) {
    const outcome = negotiateRevision(agreed);
    if (!outcome.ok) {
      await safeClose(client, recorder);
      return { ok: false, serverName: config.name, message: outcome.message };
    }
  }

  const discovery = await discoverServer(config, client, secrets);
  return {
    ok: true,
    connection: McpConnection.create(config, client, recorder, secrets, stderrTail, discovery),
  };
}

async function safeClose(client: Client, transport: InnerTransport): Promise<void> {
  try {
    await client.close();
  } catch {
    try {
      await transport.close();
    } catch {
      // Nothing further is available. The stdio transport has already escalated to
      // SIGKILL by this point if it got that far.
    }
  }
}

/**
 * Ask a server what it has.
 *
 * Three separate calls, gated on advertised capabilities, each allowed to fail on its
 * own. A server whose `resources/list` is broken still contributes its tools; the
 * alternative — one rejected promise discarding the whole server — is how a single
 * buggy server costs a user their entire tool set.
 *
 * There is no `server/discover` RPC in `@modelcontextprotocol/sdk@1.30.0`; the three
 * list calls — `tools/list`, `resources/list`, `prompts/list` — are the discovery
 * mechanism. See `version.ts`.
 */
export async function discoverServer(
  config: McpServerConfig,
  client: Client,
  secrets: SecretRegistry,
): Promise<McpDiscovery> {
  const capabilities = client.getServerCapabilities();
  const warnings: string[] = [];
  const timeout = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  /**
   * Run one capability's list call, or report why it produced nothing.
   *
   * Extracted because the three calls differ only in the method and the mapping, and
   * repeating the capability check plus the try/catch three times is what pushed this
   * function past the complexity ceiling. Sharing them also guarantees the three
   * cannot drift into three slightly different failure behaviours.
   */
  async function list<T>(
    capability: keyof NonNullable<typeof capabilities>,
    label: string,
    fetch: () => Promise<readonly T[]>,
  ): Promise<readonly T[]> {
    if (capabilities?.[capability] === undefined) return [];
    try {
      return await fetch();
    } catch (error) {
      warnings.push(`${label} failed: ${secrets.redact(messageOf(error))}`);
      return [];
    }
  }

  const tools = await list('tools', 'tools/list', async () => {
    const listed = await client.listTools({}, { timeout });
    return listed.tools.map((tool) => describeTool(config, tool, warnings));
  });

  const resources = await list('resources', 'resources/list', async () => {
    const listed = await client.listResources({}, { timeout });
    return listed.resources.map(
      (resource): McpResourceDescriptor => ({
        uri: resource.uri,
        serverName: config.name,
        ...(resource.name === undefined ? {} : { name: resource.name }),
        ...(resource.description === undefined ? {} : { description: resource.description }),
        ...(resource.mimeType === undefined ? {} : { mediaType: resource.mimeType }),
      }),
    );
  });

  const prompts = await list('prompts', 'prompts/list', async () => {
    const listed = await client.listPrompts({}, { timeout });
    return listed.prompts.map(
      (prompt): McpPromptDescriptor => ({
        name: prompt.name,
        serverName: config.name,
        ...(prompt.description === undefined ? {} : { description: prompt.description }),
      }),
    );
  });

  // Named in the config and not offered by the server: almost always a typo, and
  // silently doing nothing would leave the operator believing a tool is pre-approved.
  const offered = new Set(tools.map((tool) => tool.remoteName));
  for (const name of config.autoApprove ?? []) {
    if (!offered.has(name)) {
      warnings.push(`autoApprove names '${name}', which this server does not offer.`);
    }
  }

  return { serverName: config.name, tools, resources, prompts, warnings };
}

/**
 * Classify one advertised tool.
 *
 * `autoApprove` is honoured only when the *server* declares the tool read-only.
 * Trusting a config file's assertion that a mutating tool is safe would be a gate
 * bypass wearing a convenience hat, so the mismatch is reported and the request is
 * dropped.
 */
function describeTool(config: McpServerConfig, tool: Tool, warnings: string[]): McpToolDescriptor {
  const readOnly = tool.annotations?.readOnlyHint === true;
  const requested = (config.autoApprove ?? []).includes(tool.name);
  if (requested && !readOnly) {
    warnings.push(
      `autoApprove names '${tool.name}', but the server does not declare it read-only. ` +
        `It will require approval like any other tool.`,
    );
  }

  return {
    name: adzeToolName(config.name, tool.name),
    remoteName: tool.name,
    serverName: config.name,
    description: tool.description ?? `'${tool.name}' on MCP server '${config.name}'`,
    inputSchema: tool.inputSchema as JsonObject,
    readOnly,
    autoApprove: requested && readOnly,
  };
}

/**
 * Several servers, one lifecycle.
 *
 * The host exists so a surface has a single thing to close. A per-server close that a
 * surface has to remember for each entry in a config file is a leaked subprocess
 * waiting to happen.
 */
export class McpClientHost {
  private readonly connections: McpConnection[] = [];
  private readonly failures: { readonly serverName: string; readonly message: string }[] = [];

  /**
   * Connect to every configured server.
   *
   * Sequential rather than concurrent. Servers are subprocesses, and starting a dozen
   * `npx` processes at once on a laptop makes the slowest handshake look like a hang;
   * more importantly, a failure part-way through leaves a deterministic set to clean up.
   */
  async connectAll(
    configs: readonly McpServerConfig[],
    deps: ConnectDeps = {},
  ): Promise<readonly ConnectOutcome[]> {
    const outcomes: ConnectOutcome[] = [];
    for (const config of configs) {
      const outcome = await connectServer(config, deps);
      outcomes.push(outcome);
      if (outcome.ok) this.connections.push(outcome.connection);
      else this.failures.push({ serverName: outcome.serverName, message: outcome.message });
    }
    return outcomes;
  }

  /** Adopt a connection made elsewhere, so the host owns its teardown. */
  adopt(connection: McpConnection): void {
    this.connections.push(connection);
  }

  get all(): readonly McpConnection[] {
    return [...this.connections];
  }

  get live(): readonly McpConnection[] {
    return this.connections.filter((connection) => connection.alive);
  }

  get connectFailures(): readonly { readonly serverName: string; readonly message: string }[] {
    return [...this.failures];
  }

  /** Every discovery result, including from connections that have since died. */
  discoveries(): readonly McpDiscovery[] {
    return this.connections.map((connection) => connection.discovery);
  }

  /**
   * Close everything.
   *
   * `allSettled`, not `all`: one connection refusing to close must not leave the rest
   * running. That is the difference between a clean exit and an orphaned subprocess
   * holding the process open.
   */
  async close(): Promise<void> {
    const closing = this.connections.map(async (connection) => {
      await connection.close();
    });
    await Promise.allSettled(closing);
    this.connections.length = 0;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
