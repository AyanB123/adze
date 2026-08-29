/**
 * Namespacing MCP tool names into Adze tool names.
 *
 * Three constraints collide here, which is why this is its own module.
 *
 * **Collision.** `ToolRegistry.register` throws on a duplicate name, deliberately:
 * silent replacement would let a server shadow `bash` or `edit` with something that
 * looks identical to the model. So a discovered tool cannot keep its bare name — an
 * MCP server offering a tool called `read` would otherwise take down the whole
 * session at registration time.
 *
 * **Provider syntax.** Native tool calling restricts names to
 * `[A-Za-z0-9_-]{1,64}`. A separator that reads nicely to a human — `mcp:server/tool`
 * — is rejected by the provider, and the failure arrives as an opaque 400 on the
 * first request of a run. Underscores are the only separator that survives.
 *
 * **Inertness.** A server name comes from a config file and may contain anything.
 * It is never passed to a shell anywhere in this package, and here it is
 * additionally reduced to the provider-safe alphabet, so a name like
 * `` foo`rm -rf /` `` cannot even appear in a tool name, let alone be interpreted.
 */

/** Provider-safe alphabet. Everything else is replaced. */
const UNSAFE = /[^A-Za-z0-9_-]+/g;

/** Provider ceiling for a tool name. */
const MAX_NAME_LENGTH = 64;

const PREFIX = 'mcp';

/**
 * Reduce one path segment to the provider-safe alphabet.
 *
 * Runs of unsafe characters collapse to a single `_` rather than one each, so
 * `a;;;b` and `a&&b` do not become names dominated by underscores. An empty result
 * becomes `x`: a segment must contribute something, or two different tools could
 * map to the same Adze name.
 */
export function sanitizeSegment(segment: string): string {
  const cleaned = segment.replace(UNSAFE, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'x';
}

/**
 * The Adze tool name for a server's tool.
 *
 * `mcp__<server>__<tool>` — the double underscore makes the boundary visible in a
 * trajectory without needing a character the provider rejects.
 *
 * When the composed name exceeds the provider ceiling the *server* segment is
 * shortened and the tool segment is kept whole. The tool name is what the model
 * reasons about when choosing between two tools on the same server; truncating it
 * would make `create_issue` and `create_issue_comment` indistinguishable, which is a
 * worse failure than an abbreviated server name.
 */
export function adzeToolName(serverName: string, toolName: string): string {
  const tool = sanitizeSegment(toolName);
  const server = sanitizeSegment(serverName);
  const scaffold = `${PREFIX}____`; // prefix, both separators, empty server segment
  const room = MAX_NAME_LENGTH - scaffold.length - tool.length;

  if (room <= 0) {
    // Even an empty server segment will not fit. Keep the tail of the tool name, which
    // is where the distinguishing part of a long name usually is. The budget is measured
    // against the scaffold rather than a literal, so the ceiling cannot drift if the
    // prefix changes.
    const budget = MAX_NAME_LENGTH - scaffold.length;
    return `${scaffold}${tool.slice(Math.max(0, tool.length - budget))}`;
  }

  return `${PREFIX}__${server.slice(0, room)}__${tool}`;
}
