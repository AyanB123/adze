/**
 * Mapping an MCP tool result into an Adze tool result.
 *
 * Two jobs, and the second one is load-bearing.
 *
 * **Shape.** MCP's content union is wider than Adze's: it carries audio, embedded
 * resources, and resource links that `ContentBlock` has no member for. Those are
 * converted to text that *names what was dropped and why*, rather than silently
 * discarded. A model that receives four content blocks when the server sent five
 * reasons about a result it cannot see; a model that receives a line saying an audio
 * attachment was omitted can ask for it a different way.
 *
 * **Size.** An MCP server is a third-party program and its output is unbounded, so
 * an oversized result is a context-window denial-of-service. `dispatchToolCall`
 * truncates every tool result already, and this truncates again at the boundary on
 * purpose: the engine's cap protects the *context*, and this one protects the
 * *process*, because the engine's cap is applied after the whole payload is already
 * a string in memory. Truncating here means a server returning 50 MB costs one
 * bounded allocation instead of a heap spike, and the full text is retained as a
 * continuation so the cut is recoverable rather than lossy.
 *
 * The marker is explicit and never inferred from length. Silent truncation is the
 * failure mode where a model confidently reasons about the end of a file it never
 * received.
 */

import type { ToolExecution } from '@adze/core';
import { truncateText } from '@adze/core';
import type { ContentBlock, ImageMediaType } from '@adze/protocol';
import type {
  CallToolResult,
  ContentBlock as McpContentBlock,
} from '@modelcontextprotocol/sdk/types.js';
import type { SecretRegistry } from './redact.js';

/** Media types `ContentBlock` can actually carry. Anything else becomes a note. */
const IMAGE_MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * Default ceiling for one MCP result.
 *
 * Deliberately below the engine's own 32 KB result budget, so an MCP result that
 * reaches `dispatchToolCall` is already inside the budget and the engine's cut does
 * not land on top of ours. Two truncation markers in one result would read as a bug.
 */
export const DEFAULT_MAX_RESULT_BYTES = 24 * 1024;

export interface MapResultOptions {
  readonly serverName: string;
  readonly toolName: string;
  readonly maxBytes: number;
  readonly secrets: SecretRegistry;
}

/**
 * Convert one MCP content block to Adze content.
 *
 * Returns text for everything Adze cannot represent natively. The `resource` case
 * keeps the resource's inline text when it has some, because that is the common
 * shape for a server returning a file and dropping it would discard the answer.
 */
function mapBlock(block: McpContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };

    case 'image':
      if (IMAGE_MEDIA_TYPES.includes(block.mimeType)) {
        return { type: 'image', mediaType: block.mimeType as ImageMediaType, data: block.data };
      }
      return {
        type: 'text',
        text: `[image omitted: media type '${block.mimeType}' is not one Adze can attach]`,
      };

    case 'audio':
      return {
        type: 'text',
        text: `[audio omitted: '${block.mimeType}'. Adze has no audio content block]`,
      };

    case 'resource_link':
      return { type: 'text', text: `[resource link: ${block.uri}]` };

    case 'resource': {
      const resource = block.resource;
      // A union of an inline-text resource and a base64 `blob` one, so presence is
      // tested rather than assumed. Keeping the text matters: a server returning a
      // file uses this shape, and dropping it would discard the answer.
      if ('text' in resource) {
        return { type: 'text', name: resource.uri, text: resource.text };
      }
      return { type: 'text', text: `[binary resource omitted: ${resource.uri}]` };
    }

    default:
      // The union is open across revisions; an unknown block is reported rather than
      // dropped, so a newer server's output is visibly incomplete instead of quietly so.
      return { type: 'text', text: '[content block omitted: unrecognized type]' };
  }
}

/**
 * Flatten and bound an MCP result.
 *
 * The blocks are joined into one text stream before truncating rather than truncated
 * block by block, because a per-block budget would keep a slice of every block and
 * the useful answer is usually concentrated in one of them.
 *
 * `bias: 'tail'` matches the engine's choice for reads and command output: an MCP
 * server that fails puts the reason at the end, and keeping the first N bytes keeps
 * the banner and discards the diagnosis.
 */
export function mapCallToolResult(
  result: CallToolResult,
  options: MapResultOptions,
): ToolExecution {
  const blocks = result.content.map(mapBlock);
  const images = blocks.filter((block) => block.type === 'image');
  const joined = blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  // Structured output is part of the result when the tool declares an outputSchema,
  // and a model asked to use it cannot if we drop it.
  const structured =
    result.structuredContent === undefined
      ? ''
      : `\n[structuredContent]\n${safeJson(result.structuredContent)}`;

  const full = options.secrets.redact(`${joined}${structured}`);
  const marker =
    `[... elided by @adze/mcp: '${options.toolName}' on server ` +
    `'${options.serverName}' returned more than ${String(options.maxBytes)} bytes ...]`;

  const truncated = truncateText(full, { maxBytes: options.maxBytes, bias: 'tail', marker });
  const ok = result.isError !== true;

  return {
    ok,
    content: [...images, { type: 'text', text: truncated.text }],
    ...(ok ? {} : { error: firstLine(truncated.text) }),
    // Only offered when there is something left to hand over. A continuation token
    // for text nobody kept costs the model a step to discover it is empty.
    ...(truncated.truncated
      ? { continuable: { label: `${options.serverName}/${options.toolName}`, text: full } }
      : {}),
  };
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 0 ? line : 'the MCP server reported an error with no message';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    // A structuredContent with a cycle is the server's bug, not a reason to fail the
    // call: the content blocks are usually the useful half anyway.
    return '[structuredContent omitted: not serializable]';
  }
}
