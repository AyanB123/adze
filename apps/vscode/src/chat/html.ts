/**
 * The webview document.
 *
 * Locked down deliberately: `default-src 'none'` and no `connect-src` at all, so
 * the panel cannot reach the network even if a future edit tries to. Scripts load
 * only with the per-render nonce, styles only from the extension's own directory,
 * and there is no inline script or `unsafe-inline` anywhere. Nothing leaves the
 * machine without explicit opt-in, and a chat panel is not an opt-in.
 *
 * The nonce is generated per render and validated before it reaches the document,
 * because a nonce carrying a quote or a semicolon would terminate the policy early
 * and silently disable the thing it exists to enforce.
 */

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,}$/;

/**
 * Base64url of the given bytes, with no padding.
 *
 * Bytes are injected rather than read from `node:crypto` here so the encoding is
 * testable on its own. Callers pass cryptographically random bytes; the encoding
 * makes no attempt to add entropy.
 */
export function nonceFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export interface ChatHtmlOptions {
  /** Per-render nonce. Must match {@link NONCE_PATTERN}. */
  readonly nonce: string;
  /** `webview.cspSource`, the only origin local resources may come from. */
  readonly cspSource: string;
  /** Result of `webview.asWebviewUri` for the script. */
  readonly scriptUri: string;
  /** Result of `webview.asWebviewUri` for the stylesheet. */
  readonly styleUri: string;
}

/**
 * The Content-Security-Policy for the chat panel.
 *
 * Exported so a test can assert the shape of the policy rather than the shape of
 * the whole document: the policy is the security boundary, and it should fail a
 * test the moment it loosens.
 */
export function contentSecurityPolicy(nonce: string, cspSource: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource}`,
    `font-src ${cspSource}`,
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
}

export function chatHtml(options: ChatHtmlOptions): string {
  if (!NONCE_PATTERN.test(options.nonce)) {
    // Refuse rather than render a policy that a crafted nonce could truncate.
    throw new Error('refusing to render the chat webview with a malformed nonce');
  }
  const csp = contentSecurityPolicy(options.nonce, options.cspSource);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${options.styleUri}" />
<title>Adze</title>
</head>
<body>
<main id="transcript" aria-live="polite"></main>
<section id="status" aria-live="polite"></section>
<form id="composer">
  <textarea id="prompt" rows="3" placeholder="Ask Adze to change something in this workspace"
    aria-label="Prompt"></textarea>
  <div class="row">
    <button id="send" type="submit">Send</button>
    <button id="cancel" type="button" disabled>Cancel</button>
  </div>
</form>
<script nonce="${options.nonce}" src="${options.scriptUri}"></script>
</body>
</html>`;
}
