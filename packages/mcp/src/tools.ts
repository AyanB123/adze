/**
 * Turning discovered MCP tools into Adze tools.
 *
 * ## Why these are built by hand rather than with `defineTool`
 *
 * `defineTool` derives the JSON Schema a provider advertises *from* a Zod schema.
 * An MCP tool already has a JSON Schema — the server's own — and deriving a new one
 * would mean round-tripping it through Zod and advertising our reconstruction of the
 * server's contract instead of the contract itself. Any lossy corner of that
 * conversion becomes a tool the model calls incorrectly forever. So the schema is
 * passed through unmodified and {@link RegisteredTool} is implemented directly.
 *
 * ## Why that does not weaken the permission gate
 *
 * The gate does not depend on `defineTool`. It depends on `execute` being reachable
 * only with a `Grant`, and on `dispatchToolCall` being the only caller. Both still
 * hold: `execute` here takes a `ToolContext`, which only the dispatcher constructs,
 * and it is minted from `PermissionGate.authorize` after this tool's declared effects
 * have been authorized. Nothing in this file can produce a `Grant`.
 *
 * ## Why validation is left to the server
 *
 * The server holds the schema and validates against it — the SDK bundles a JSON
 * Schema validator for exactly that. A second implementation here would be a worse
 * copy whose disagreements with the first show up as valid calls being refused, and
 * refusing a valid call is the failure this codebase consistently ranks as worse than
 * letting one through (see the apply engine's structural checker). What *is* checked
 * locally is the unambiguous part: arguments must be an object, and declared
 * `required` properties must be present. That turns the most common model mistake
 * into immediate feedback instead of a round trip.
 */

import type { Effect, PrepareOutcome, RegisteredTool, ToolExecution } from '@adze/core';
import type { JsonObject } from '@adze/protocol';
import type { McpClientHost, McpConnection } from './client.js';
import type { McpToolDescriptor } from './types.js';

/**
 * What Adze does when this tool is called, declared before it runs.
 *
 * For **http**, a `network` effect naming the host: exact, and it is what a sandbox's
 * `allowedNetworkHosts` list is checked against.
 *
 * For **stdio**, a `command` effect naming the server's argv. This deliberately
 * over-declares — the child is already running, so the call itself spawns nothing —
 * and the alternative is worse in both directions. Declaring no effect would present
 * an MCP call as touching nothing, when it hands arguments to a program that can read
 * and write the whole filesystem. Inventing a narrower effect kind would describe the
 * IPC hop accurately and hide the thing the user is actually deciding about, which is
 * whether that program should act on their behalf. Over-declaring also makes the
 * existing `commandRules` policy hook work for MCP servers with no new machinery: an
 * operator can pre-allow one specific server's command line.
 */
function effectsFor(connection: McpConnection, workspaceRoot: string): readonly Effect[] {
  const { config } = connection;

  if (config.transport === 'http') {
    const url = config.url ?? '';
    try {
      return [{ kind: 'network', host: new URL(url).host }];
    } catch {
      // A connection exists, so the URL parsed at connect time. Reaching here means the
      // config changed underneath us; naming the raw value is more useful than throwing.
      return [{ kind: 'network', host: url }];
    }
  }

  const command = config.command ?? '';
  return [
    {
      kind: 'command',
      command: [command, ...(config.args ?? [])],
      cwd: config.cwd ?? workspaceRoot,
    },
  ];
}

/** Names of `required` properties a schema declares, when it declares them well. */
function requiredProperties(schema: JsonObject): readonly string[] {
  const required = schema.required;
  if (!Array.isArray(required)) return [];
  return required.filter((entry): entry is string => typeof entry === 'string');
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One Adze tool backed by one MCP tool.
 *
 * The returned tool holds the connection, so a call always reaches the server the
 * descriptor was discovered from. Resolving the server by name at call time would
 * introduce a window where a reconnect points an existing descriptor at a different
 * process.
 */
export function mcpTool(connection: McpConnection, descriptor: McpToolDescriptor): RegisteredTool {
  return {
    name: descriptor.name,
    description: describe(descriptor),
    parameters: descriptor.inputSchema,

    prepare(args: JsonObject): PrepareOutcome {
      if (!isPlainObject(args)) {
        return { ok: false, issues: [`arguments must be a JSON object`] };
      }
      const missing = requiredProperties(descriptor.inputSchema).filter(
        (key) => !Object.hasOwn(args, key),
      );
      if (missing.length > 0) {
        return {
          ok: false,
          issues: missing.map((key) => `missing required property '${key}'`),
        };
      }

      return {
        ok: true,
        call: {
          effects: (ctx) => effectsFor(connection, ctx.workspaceRoot),
          execute: async (ctx): Promise<ToolExecution> =>
            await connection.callTool(descriptor.remoteName, args, ctx.signal),
        },
      };
    },
  };
}

/**
 * The description the model reads.
 *
 * The server's own description first, then provenance. Provenance is not decoration:
 * a model choosing between `edit` and `mcp__github__create_or_update_file` is choosing
 * between a local write and a network write to someone else's repository, and the
 * server name is the only thing in the tool list that says so.
 */
function describe(descriptor: McpToolDescriptor): string {
  const access = descriptor.readOnly ? 'read-only' : 'may modify state';
  return `${descriptor.description}\n\n(MCP server '${descriptor.serverName}', ${access})`;
}

/** Every tool one connection offers. */
export function mcpTools(connection: McpConnection): readonly RegisteredTool[] {
  return connection.discovery.tools.map((descriptor) => mcpTool(connection, descriptor));
}

/**
 * Every tool every live connection offers, ready for `EngineOptions.extraTools`.
 *
 * Dead connections are skipped rather than registered-and-failing. A tool in the
 * catalog that always errors costs the model a step and a retry to learn what the
 * absence of the tool would have told it immediately.
 */
export function mcpToolsFor(host: McpClientHost): readonly RegisteredTool[] {
  return host.live.flatMap((connection) => mcpTools(connection));
}
