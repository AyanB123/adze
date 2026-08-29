import { describe, expect, it } from 'vitest';
import { createRedactor, REDACTED, redact } from '../src/redact.js';

/**
 * A leaked key is not recoverable, and a provider error is the likeliest place one
 * escapes: `APICallError` carries the request URL, the request body, and sometimes the
 * response headers. Those messages reach a terminal, a CI log, a trajectory artifact
 * published alongside a benchmark report, and — worst — back into the model's context.
 *
 * These tests use fake keys with real prefixes. None is a live credential.
 */
const ANTHROPIC_KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OPENAI_KEY = 'sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('redact — held secrets', () => {
  it('removes a configured key from an error message', () => {
    const message = `401 Unauthorized: invalid x-api-key '${ANTHROPIC_KEY}'`;

    const out = redact(message, [ANTHROPIC_KEY]);

    expect(out).not.toContain(ANTHROPIC_KEY);
    expect(out).toContain(REDACTED);
  });

  it('removes every occurrence, not only the first', () => {
    const message = `${OPENAI_KEY} then again ${OPENAI_KEY}`;

    const out = redact(message, [OPENAI_KEY]);

    expect(out).toBe(`${REDACTED} then again ${REDACTED}`);
  });

  it('removes a key that reached a URL query string percent-encoded', () => {
    // A gateway that echoes the request URL is a real shape, and `+` and `/` in a key
    // survive as `%2B` and `%2F`, which a literal string match would miss.
    const key = 'sk-ant-api03-abc+def/ghi=jkl';
    const message = `GET https://proxy.example/v1?key=${encodeURIComponent(key)} failed`;

    const out = redact(message, [key]);

    expect(out).not.toContain(encodeURIComponent(key));
    expect(out).toContain(REDACTED);
  });

  it('finds a key embedded in a JSON request body', () => {
    const body = JSON.stringify({ model: 'claude-sonnet-4-5', apiKey: ANTHROPIC_KEY });

    const out = redact(body, [ANTHROPIC_KEY]);

    expect(out).not.toContain(ANTHROPIC_KEY);
    // The surrounding JSON stays readable, which is why redaction is worth doing at all
    // rather than blanking the whole message.
    expect(out).toContain('claude-sonnet-4-5');
  });

  it('ignores a secret too short to substitute safely', () => {
    // A one-character "key" is a misconfiguration. Substituting it would replace every
    // occurrence of that character in the message and destroy the diagnostic.
    const out = redact('a request to a host failed', ['a']);

    expect(out).toBe('a request to a host failed');
  });
});

describe('redact — pattern backstop', () => {
  it('removes an Anthropic-shaped key this process never held', () => {
    const out = redact(`upstream said: ${ANTHROPIC_KEY}`);

    expect(out).not.toContain(ANTHROPIC_KEY);
    expect(out).toContain(REDACTED);
  });

  it('removes an OpenAI-shaped key this process never held', () => {
    const out = redact(`Bearer rejected for ${OPENAI_KEY}`);

    expect(out).not.toContain(OPENAI_KEY);
  });

  it('removes an OpenRouter-shaped key', () => {
    const key = 'sk-or-v1-0123456789abcdef0123456789abcdef';

    expect(redact(`no credit for ${key}`)).not.toContain(key);
  });

  it('removes a Google-shaped key', () => {
    const key = 'AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMY0000000';

    expect(redact(`key=${key}`)).not.toContain(key);
  });

  it('removes a bearer token of any shape while keeping the framing', () => {
    const out = redact('authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.body.sig');

    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out).toContain(REDACTED);
  });

  it('keeps the field name when redacting a labelled value', () => {
    // `api_key: [redacted]` tells the reader which header was wrong; a fully blanked
    // line does not, and a redactor people turn off protects nothing.
    const out = redact('x-api-key: 0123456789abcdefghij');

    expect(out).toContain('x-api-key:');
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('0123456789abcdefghij');
  });

  it('leaves ordinary diagnostic text alone', () => {
    // An entropy heuristic would blank commit hashes, base64 file contents, and UUIDs.
    // A message with the useful parts gone trains people to stop reading it.
    const message =
      'model claude-sonnet-4-5 at step 3: rate limited after 2 retries (commit 9f2c1ab, 429)';

    expect(redact(message)).toBe(message);
  });

  it('never reveals a suffix of the secret', () => {
    // Showing the last four characters shortens a brute-force search and answers no
    // debugging question.
    const out = redact(`key ${ANTHROPIC_KEY}`, [ANTHROPIC_KEY]);

    expect(out).not.toContain(ANTHROPIC_KEY.slice(-4));
  });
});

describe('createRedactor', () => {
  it('binds the held secrets so a new error path cannot forget them', () => {
    const scrub = createRedactor([ANTHROPIC_KEY, OPENAI_KEY]);

    const out = scrub(`tried ${ANTHROPIC_KEY} then ${OPENAI_KEY}`);

    expect(out).not.toContain(ANTHROPIC_KEY);
    expect(out).not.toContain(OPENAI_KEY);
  });

  it('drops undefined-shaped and too-short entries at construction', () => {
    const scrub = createRedactor(['', 'xy']);

    expect(scrub('xyz')).toBe('xyz');
  });
});
