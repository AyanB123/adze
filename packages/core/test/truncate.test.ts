import { describe, expect, it } from 'vitest';
import {
  ContinuationStore,
  estimateTokens,
  truncateContent,
  truncateText,
} from '../src/truncate.js';

const MARKER = '[cut]';

/** Deterministic token source, so eviction assertions can name the token they expect. */
function counting(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `tok_${counter}`;
  };
}

describe('truncateText — where the cut falls', () => {
  it('returns text unchanged when it fits', () => {
    const result = truncateText('short', { maxBytes: 100, bias: 'head' });
    expect(result.truncated).toBe(false);
    expect(result.text).toBe('short');
    expect(result.originalBytes).toBe(5);
    expect(result.returnedBytes).toBe(5);
  });

  it('head bias keeps the beginning', () => {
    const text = ['first', 'second', 'third', 'fourth', 'fifth'].join('\n');
    const result = truncateText(text, { maxBytes: 20, bias: 'head', marker: MARKER });
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith('first')).toBe(true);
    expect(result.text).toContain(MARKER);
    expect(result.text).not.toContain('fifth');
  });

  it('tail bias keeps the end', () => {
    const text = ['first', 'second', 'third', 'fourth', 'fifth'].join('\n');
    const result = truncateText(text, { maxBytes: 20, bias: 'tail', marker: MARKER });
    expect(result.text).toContain('fifth');
    expect(result.text).not.toContain('first');
  });

  it('both bias keeps each end and elides the middle', () => {
    // The important case. A failing test run puts the assertion and the summary at the
    // end and the command echo at the start; keeping only one end loses one of them.
    const lines = Array.from({ length: 200 }, (_, index) => `line-${index}`);
    const result = truncateText(lines.join('\n'), {
      maxBytes: 400,
      bias: 'both',
      marker: MARKER,
    });
    expect(result.text).toContain('line-0');
    expect(result.text).toContain('line-199');
    expect(result.text).toContain(MARKER);
    expect(result.text).not.toContain('line-100');
  });

  it('gives the tail two thirds of the budget', () => {
    const lines = Array.from({ length: 400 }, (_, index) => `l${index}`);
    const result = truncateText(lines.join('\n'), { maxBytes: 600, bias: 'both', marker: MARKER });
    const [head = '', tail = ''] = result.text.split(MARKER);
    expect(tail.length).toBeGreaterThan(head.length);
  });

  it('cuts on a line boundary when one is available', () => {
    const text = Array.from({ length: 50 }, (_, index) => `line-${index}`).join('\n');
    const result = truncateText(text, { maxBytes: 60, bias: 'head', marker: MARKER });
    const kept = result.text.split(`\n${MARKER}`)[0] ?? '';
    // No partial identifier: a mid-token cut produces text that looks like source and
    // is not, and the model then reasons about a name that does not exist.
    expect(kept.split('\n').every((line) => /^line-\d+$/.test(line))).toBe(true);
  });

  it('still returns something when a single line is over budget', () => {
    const result = truncateText('x'.repeat(1_000), { maxBytes: 50, bias: 'head', marker: MARKER });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('measures bytes rather than characters', () => {
    // A four-byte emoji must not count as one.
    const result = truncateText('😀'.repeat(10), { maxBytes: 100, bias: 'head' });
    expect(result.originalBytes).toBe(40);
    expect(result.truncated).toBe(false);
  });
});

describe('truncateContent', () => {
  it('leaves content alone when it fits', () => {
    const content = [{ type: 'text' as const, text: 'ok' }];
    const result = truncateContent(content, { maxBytes: 100, bias: 'head' });
    expect(result.truncation).toBeUndefined();
    expect(result.content).toBe(content);
  });

  it('reports original and returned bytes when it cuts', () => {
    const result = truncateContent([{ type: 'text', text: 'x'.repeat(1_000) }], {
      maxBytes: 100,
      bias: 'head',
    });
    expect(result.truncation?.originalBytes).toBe(1_000);
    expect(result.truncation?.returnedBytes).toBeLessThanOrEqual(100);
  });

  it('drops an oversized image whole rather than cutting it', () => {
    // A partial image is not a smaller image, it is a corrupt one.
    const result = truncateContent(
      [
        { type: 'text', text: 'caption' },
        { type: 'image', mediaType: 'image/png', data: 'A'.repeat(5_000) },
      ],
      { maxBytes: 100, bias: 'head' },
    );
    expect(result.truncation).toBeDefined();
    expect(result.content.some((block) => block.type === 'image')).toBe(false);
    expect(
      result.content.some((block) => block.type === 'text' && block.text.includes('image')),
    ).toBe(true);
  });

  it('keeps an image that fits', () => {
    const result = truncateContent(
      [
        { type: 'image', mediaType: 'image/png', data: 'A'.repeat(50) },
        { type: 'text', text: 'x'.repeat(5_000) },
      ],
      { maxBytes: 500, bias: 'head' },
    );
    expect(result.content.some((block) => block.type === 'image')).toBe(true);
  });
});

describe('ContinuationStore', () => {
  it('round-trips retained text', () => {
    const nextToken = counting();
    const store = new ContinuationStore(nextToken);
    const token = store.register('bash: pnpm test', 'full output');
    expect(token).toBe('tok_1');
    expect(store.resolve('tok_1')).toEqual({ label: 'bash: pnpm test', text: 'full output' });
  });

  it('returns undefined for an unknown token', () => {
    const store = new ContinuationStore(() => 'tok');
    expect(store.resolve('nope')).toBeUndefined();
  });

  it('refuses to hold text larger than its ceiling', () => {
    // Better to issue no token than one for output nobody kept: a token the model
    // cannot redeem costs it a step to discover.
    const store = new ContinuationStore(() => 'tok', 10, 100);
    expect(store.register('big', 'x'.repeat(500))).toBeUndefined();
  });

  it('evicts oldest-first past the entry ceiling', () => {
    const nextToken = counting();
    const store = new ContinuationStore(nextToken, 2);
    store.register('a', 'a');
    store.register('b', 'b');
    store.register('c', 'c');
    expect(store.size).toBe(2);
    expect(store.resolve('tok_1')).toBeUndefined();
    expect(store.resolve('tok_3')).toBeDefined();
  });

  it('evicts past the byte ceiling', () => {
    const nextToken = counting();
    const store = new ContinuationStore(nextToken, 100, 30);
    store.register('a', 'x'.repeat(20));
    store.register('b', 'x'.repeat(20));
    expect(store.size).toBe(1);
  });

  it('clear releases everything', () => {
    const store = new ContinuationStore(() => 'tok');
    store.register('a', 'a');
    store.clear();
    expect(store.size).toBe(0);
  });
});

describe('estimateTokens', () => {
  it('is four characters per token, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});
