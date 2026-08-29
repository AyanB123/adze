/**
 * Result mapping and truncation.
 *
 * The truncation tests matter more than they look. An MCP server is a third-party
 * program returning unbounded output, and silent truncation is the failure where a
 * model confidently reasons about the end of a payload it never received — so the
 * marker is asserted, not just the size.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_RESULT_BYTES, mapCallToolResult } from '../src/content.js';
import { SecretRegistry } from '../src/redact.js';

const options = {
  serverName: 'demo',
  toolName: 'read_file',
  maxBytes: 512,
  secrets: new SecretRegistry([]),
};

function result(content: CallToolResult['content'], extra: Partial<CallToolResult> = {}) {
  return { content, ...extra } as CallToolResult;
}

describe('content mapping', () => {
  it('maps text blocks and joins them', () => {
    const mapped = mapCallToolResult(
      result([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]),
      options,
    );
    expect(mapped.ok).toBe(true);
    expect(mapped.content).toEqual([{ type: 'text', text: 'first\nsecond' }]);
  });

  it('keeps an image Adze can attach', () => {
    const mapped = mapCallToolResult(
      result([{ type: 'image', data: 'aGk=', mimeType: 'image/png' }]),
      options,
    );
    expect(mapped.content[0]).toEqual({ type: 'image', mediaType: 'image/png', data: 'aGk=' });
  });

  it('describes an image media type Adze cannot carry instead of dropping it', () => {
    // `ContentBlock` accepts four media types. A silent drop would leave the model
    // reasoning about a result that is missing its subject.
    const mapped = mapCallToolResult(
      result([{ type: 'image', data: 'aGk=', mimeType: 'image/tiff' }]),
      options,
    );
    expect(JSON.stringify(mapped.content)).toContain("media type 'image/tiff' is not one Adze");
  });

  it('describes audio, which Adze has no block for', () => {
    const mapped = mapCallToolResult(
      result([{ type: 'audio', data: 'aGk=', mimeType: 'audio/wav' }]),
      options,
    );
    expect(JSON.stringify(mapped.content)).toContain('audio omitted');
  });

  it('keeps the inline text of an embedded resource', () => {
    const mapped = mapCallToolResult(
      result([
        {
          type: 'resource',
          resource: { uri: 'file:///a.ts', text: 'export const a = 1;', mimeType: 'text/plain' },
        },
      ]),
      options,
    );
    expect(JSON.stringify(mapped.content)).toContain('export const a = 1;');
  });

  it('names a binary embedded resource it cannot inline', () => {
    const mapped = mapCallToolResult(
      result([{ type: 'resource', resource: { uri: 'file:///a.bin', blob: 'AAAA' } }]),
      options,
    );
    expect(JSON.stringify(mapped.content)).toContain('binary resource omitted: file:///a.bin');
  });

  it('reports a resource link', () => {
    const mapped = mapCallToolResult(
      result([{ type: 'resource_link', uri: 'https://x.example/doc', name: 'doc' }]),
      options,
    );
    expect(JSON.stringify(mapped.content)).toContain('resource link: https://x.example/doc');
  });

  it('carries structuredContent through', () => {
    const mapped = mapCallToolResult(
      result([{ type: 'text', text: 'see below' }], { structuredContent: { count: 3 } }),
      options,
    );
    // A tool that declares an outputSchema puts its answer here, and a model told to use
    // it cannot if we drop it.
    const text = mapped.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('[structuredContent]');
    expect(text).toContain('"count": 3');
  });

  it('survives a structuredContent that cannot be serialized', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const mapped = mapCallToolResult(
      result([{ type: 'text', text: 'body' }], { structuredContent: cyclic }),
      options,
    );
    // The server's bug, not a reason to fail the call: the content blocks are usually
    // the useful half anyway.
    expect(mapped.ok).toBe(true);
    expect(JSON.stringify(mapped.content)).toContain('not serializable');
  });

  it('maps isError to a failed execution with the first line as the error', () => {
    const mapped = mapCallToolResult(
      result([{ type: 'text', text: 'ENOENT: no such file\nstack line' }], { isError: true }),
      options,
    );
    expect(mapped.ok).toBe(false);
    expect(mapped.error).toBe('ENOENT: no such file');
  });

  it('gives an error with no message something to report', () => {
    const mapped = mapCallToolResult(result([], { isError: true }), options);
    expect(mapped.ok).toBe(false);
    expect(mapped.error).toContain('reported an error with no message');
  });

  it('handles an unrecognized block type from a newer server', () => {
    const mapped = mapCallToolResult(
      result([{ type: 'something_new', payload: 1 } as unknown as CallToolResult['content'][0]]),
      options,
    );
    expect(JSON.stringify(mapped.content)).toContain('unrecognized type');
  });
});

describe('truncation', () => {
  it('marks the cut explicitly and names the server and tool', () => {
    const mapped = mapCallToolResult(result([{ type: 'text', text: 'x'.repeat(4096) }]), options);

    const text = mapped.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('elided by @adze/mcp');
    expect(text).toContain("'read_file'");
    expect(text).toContain("'demo'");
    // The byte figure is in the marker, so the model knows the scale of what it lost.
    expect(text).toContain('512');
  });

  it('bounds the returned size', () => {
    const mapped = mapCallToolResult(
      result([{ type: 'text', text: 'y'.repeat(100_000) }]),
      options,
    );
    const bytes = mapped.content.reduce(
      (sum, block) => sum + Buffer.byteLength(block.type === 'text' ? block.text : block.data),
      0,
    );
    expect(bytes).toBeLessThanOrEqual(options.maxBytes);
  });

  it('retains the full text as a continuation so the cut is recoverable', () => {
    const body = 'z'.repeat(4096);
    const mapped = mapCallToolResult(result([{ type: 'text', text: body }]), options);

    expect(mapped.continuable?.text).toBe(body);
    expect(mapped.continuable?.label).toBe('demo/read_file');
  });

  it('offers no continuation when nothing was cut', () => {
    const mapped = mapCallToolResult(result([{ type: 'text', text: 'short' }]), options);
    expect(mapped.continuable).toBeUndefined();
    // A token for text nobody kept costs the model a step to discover it is empty.
  });

  it('keeps the tail, where a failure puts its diagnosis', () => {
    const head = 'banner\n'.repeat(200);
    const mapped = mapCallToolResult(
      result([{ type: 'text', text: `${head}FINAL_ANSWER_MARKER` }]),
      options,
    );
    const text = mapped.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('FINAL_ANSWER_MARKER');
  });

  it('redacts before truncating, so a secret cannot survive in the retained text', () => {
    const secret = 'sk-live-0123456789abcdef';
    const mapped = mapCallToolResult(
      result([{ type: 'text', text: `${'a'.repeat(4096)} ${secret}` }]),
      { ...options, secrets: new SecretRegistry([{ TOKEN: secret }]) },
    );
    expect(JSON.stringify(mapped)).not.toContain(secret);
  });

  it('leaves headroom under the engine own result budget', () => {
    // The engine caps a tool result at 32 KB. Staying below that means an MCP result
    // arriving at the dispatcher is already inside budget, so the two cuts cannot both
    // land and produce two truncation markers in one result.
    expect(DEFAULT_MAX_RESULT_BYTES).toBeLessThan(32 * 1024);
  });
});
