import { describe, expect, it } from 'vitest';
import { chatHtml, contentSecurityPolicy, nonceFromBytes } from '../src/chat/html.js';
import { MAX_PROMPT_LENGTH, parseWebviewMessage } from '../src/chat/messages.js';

const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA';

function html(): string {
  return chatHtml({
    nonce: NONCE,
    cspSource: 'vscode-resource://xyz',
    scriptUri: 'vscode-resource://xyz/media/chat.js',
    styleUri: 'vscode-resource://xyz/media/chat.css',
  });
}

describe('contentSecurityPolicy', () => {
  it('denies everything by default', () => {
    expect(contentSecurityPolicy(NONCE, 'CSP')).toContain("default-src 'none'");
  });

  it('has no connect-src at all, so the panel cannot reach the network', () => {
    // Local-first is a product promise. With `default-src 'none'` and no `connect-src`,
    // fetch and XHR from the panel are impossible rather than merely discouraged.
    expect(contentSecurityPolicy(NONCE, 'CSP')).not.toContain('connect-src');
  });

  it('loads scripts only with the nonce', () => {
    const csp = contentSecurityPolicy(NONCE, 'CSP');
    expect(csp).toContain(`script-src 'nonce-${NONCE}'`);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('restricts styles, images, and fonts to the extension own origin', () => {
    const csp = contentSecurityPolicy(NONCE, 'CSP-ORIGIN');
    expect(csp).toContain('style-src CSP-ORIGIN');
    expect(csp).toContain('img-src CSP-ORIGIN');
    expect(csp).toContain('font-src CSP-ORIGIN');
    expect(csp).not.toContain('https:');
    expect(csp).not.toContain('*');
  });
});

describe('chatHtml', () => {
  it('carries the policy and stamps the nonce on the script tag', () => {
    const document = html();
    expect(document).toContain('http-equiv="Content-Security-Policy"');
    expect(document).toContain(`<script nonce="${NONCE}"`);
  });

  it('has no inline script or style element', () => {
    const document = html();
    expect(document).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(document).not.toContain('<style');
    expect(document).not.toContain('onclick=');
  });

  it('loads no remote content', () => {
    const document = html();
    expect(document).not.toContain('http://');
    expect(document).not.toContain('https://');
  });

  it('refuses a nonce that could truncate the policy', () => {
    for (const bad of ['', 'short', `${NONCE}';x`, `${NONCE} unsafe-inline`]) {
      expect(() => chatHtml({ nonce: bad, cspSource: 'c', scriptUri: 's', styleUri: 't' })).toThrow(
        /malformed nonce/,
      );
    }
  });
});

describe('nonceFromBytes', () => {
  it('produces base64url with no padding', () => {
    const nonce = nonceFromBytes(new Uint8Array([251, 255, 254, 1, 2, 3]));
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(nonce).not.toContain('=');
  });

  it('produces a nonce long enough for chatHtml to accept', () => {
    const bytes = new Uint8Array(18);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index * 7;
    expect(() =>
      chatHtml({ nonce: nonceFromBytes(bytes), cspSource: 'c', scriptUri: 's', styleUri: 't' }),
    ).not.toThrow();
  });

  it('differs for different bytes', () => {
    const a = nonceFromBytes(new Uint8Array(18).fill(1));
    const b = nonceFromBytes(new Uint8Array(18).fill(2));
    expect(a).not.toBe(b);
  });
});

describe('parseWebviewMessage', () => {
  it('accepts a submit with a trimmed prompt', () => {
    expect(parseWebviewMessage({ type: 'submit', prompt: '  rename the class  ' })).toEqual({
      type: 'submit',
      prompt: 'rename the class',
    });
  });

  it('accepts a cancel', () => {
    expect(parseWebviewMessage({ type: 'cancel' })).toEqual({ type: 'cancel' });
  });

  it('rejects an empty prompt, which the protocol would reject anyway', () => {
    expect(parseWebviewMessage({ type: 'submit', prompt: '   ' })).toBeUndefined();
  });

  it('rejects a prompt beyond the size ceiling', () => {
    const prompt = 'x'.repeat(MAX_PROMPT_LENGTH + 1);
    expect(parseWebviewMessage({ type: 'submit', prompt })).toBeUndefined();
  });

  it('rejects anything it does not recognise rather than passing it through', () => {
    for (const bad of [
      undefined,
      null,
      'submit',
      42,
      [],
      { type: 'evaluate', code: 'process.exit()' },
      { type: 'submit' },
      { type: 'submit', prompt: 7 },
    ]) {
      expect(parseWebviewMessage(bad)).toBeUndefined();
    }
  });
});
