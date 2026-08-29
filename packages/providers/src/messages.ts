/**
 * History and tool conversion.
 *
 * Two jobs: turn `@adze/core`'s linear history into the AI SDK's message array, and
 * turn the tool registry's catalog into the SDK's tool set. Both are mechanical
 * except for one decision that carries the whole point of the context assembler.
 *
 * ### The cache breakpoint
 *
 * `ModelRequest.cachePrefixLength` says how many leading messages form the frozen
 * epoch baseline. Anthropic does not infer that: caching happens only where a
 * `cache_control` marker is placed, and without the marker a byte-identical prefix is
 * re-billed at the full input rate on every step. The assembler's work — freezing the
 * baseline, routing new information into ordered mid-conversation messages, rolling
 * the epoch only on a structural change — buys nothing at all unless the marker is
 * placed at the boundary it computed.
 *
 * So the marker goes on the **last message of the prefix**, which is where Anthropic
 * defines the cacheable span as ending. OpenAI caches automatically by prefix hash and
 * ignores the field, which is why it rides in `providerOptions.anthropic` rather than
 * as a top-level option: an unknown top-level key is a request the other provider
 * rejects.
 *
 * ### Native tool calling, and the absence of a fallback
 *
 * Tool schemas go across as JSON Schema through `jsonSchema()`, and the tools carry no
 * `execute`. That is what makes the SDK emit a `tool-call` part and stop rather than
 * running anything: dispatch, the permission gate, and execution belong to
 * `@adze/core`, and a tool the SDK could execute would be a tool that bypassed the
 * gate — the one invariant with no exceptions.
 *
 * There is no code path here that asks a model to emit JSON in a string. ADR-0004
 * measured that transport at a 7.3% invalid-JSON rejection rate on open-weight
 * rollouts, concentrated in the cheap models that matter most on cost, so the fallback
 * is absent rather than optional.
 */

import type { ConversationMessage, ToolSpec } from '@adze/core';
import type { ContentBlock } from '@adze/protocol';
import {
  type AssistantContent,
  jsonSchema,
  type ModelMessage,
  type Tool,
  type ToolResultPart,
  tool,
  type UserContent,
} from 'ai';

/**
 * Provider options that mark the end of a cacheable prefix.
 *
 * `anthropic` only. See the file comment: OpenAI infers its own prefix and rejects
 * unknown top-level fields, so a shared key would break it.
 */
const CACHE_BREAKPOINT = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
} as const;

/**
 * Content blocks to user-message parts.
 *
 * An image arrives as base64 with no `data:` prefix (the protocol says so) and the SDK
 * accepts exactly that alongside an explicit `mediaType`, so no re-encoding happens
 * here. Images flow because ADR-0004 requires it: text-only harnesses lose
 * image-bearing tasks by roughly 12 to 1.
 */
function toUserContent(content: readonly ContentBlock[]): UserContent {
  return content.map((block) =>
    block.type === 'text'
      ? { type: 'text' as const, text: block.text }
      : { type: 'image' as const, image: block.data, mediaType: block.mediaType },
  );
}

/**
 * Flatten content to text.
 *
 * For the two places the SDK's shape is a string: a `system` message, and the text side
 * of a failed tool result. An image is dropped rather than stringified, because a base64
 * blob rendered as text is thousands of tokens of noise the model cannot read as an
 * image.
 */
function toText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Assistant content: text and tool calls only.
 *
 * The SDK's assistant shape has no image part, and that is correct rather than a
 * limitation — an assistant message in core's history is what the model produced, and
 * these models do not emit images. Text is flattened to a single part so the array
 * cannot carry a block the role does not accept.
 */
function toAssistantContent(
  message: Extract<ConversationMessage, { role: 'assistant' }>,
): AssistantContent {
  const text = toText(message.content);
  return [
    ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
    ...message.toolCalls.map((call) => ({
      type: 'tool-call' as const,
      toolCallId: call.callId,
      toolName: call.name,
      input: call.arguments,
    })),
  ];
}

/**
 * A tool result, in the SDK's output shape.
 *
 * `type: 'content'` rather than `type: 'text'` on success, so an image-returning tool
 * keeps its image — a screenshot tool that could only return text would defeat the point
 * of ADR-0004's vision requirement. A failure becomes `error-text` so the provider marks
 * the result as an error rather than as ordinary content the model has to infer a failure
 * from.
 */
function toolOutput(
  message: Extract<ConversationMessage, { role: 'tool' }>,
): ToolResultPart['output'] {
  if (!message.ok) return { type: 'error-text', value: toText(message.content) };
  return {
    type: 'content',
    value: message.content.map((block) =>
      block.type === 'text'
        ? { type: 'text' as const, text: block.text }
        : {
            type: 'file' as const,
            data: { type: 'data' as const, data: block.data },
            mediaType: block.mediaType,
          },
    ),
  };
}

function convert(message: ConversationMessage): ModelMessage {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: toText(message.content) };
    case 'user':
      return { role: 'user', content: toUserContent(message.content) };
    case 'assistant':
      return { role: 'assistant', content: toAssistantContent(message) };
    case 'tool':
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.callId,
            toolName: message.name,
            output: toolOutput(message),
          },
        ],
      };
  }
}

/**
 * Convert history and mark the cache boundary.
 *
 * `cachePrefixLength` is clamped to the array length rather than trusted. A prefix
 * longer than the history would put the marker nowhere and silently disable caching
 * for the whole run, which is the failure this function exists to prevent and would be
 * invisible except as a bill.
 */
export function toModelMessages(
  history: readonly ConversationMessage[],
  cachePrefixLength: number,
): ModelMessage[] {
  const messages = history.map(convert);
  const boundary = Math.min(Math.max(cachePrefixLength, 0), messages.length) - 1;
  const last = boundary >= 0 ? messages[boundary] : undefined;
  if (last !== undefined) {
    messages[boundary] = { ...last, providerOptions: CACHE_BREAKPOINT };
  }
  return messages;
}

/**
 * The registry's catalog as an SDK tool set.
 *
 * No `execute`, by design — see the file comment. The registry already sorts by name,
 * and that order is preserved here because the tool list is part of the cached prefix
 * for most providers: reordering it is a cache miss on every step of every turn, which
 * is the same failure the epoch design exists to prevent.
 */
export function toToolSet(specs: readonly ToolSpec[]): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  for (const spec of specs) {
    tools[spec.name] = tool({
      description: spec.description,
      inputSchema: jsonSchema(spec.parameters),
    });
  }
  return tools;
}
