/**
 * Messages across the webview boundary.
 *
 * A webview is a separate document with its own script. Whatever arrives from it is
 * parsed rather than trusted: {@link parseWebviewMessage} returns `undefined` for
 * anything it does not recognise, so a malformed or hostile message becomes a
 * no-op instead of an argument to `turn.submit`. The engine-facing side of this
 * extension only ever sees values that passed through here.
 */

import type { ChatViewModel } from './view-model.js';

/** Extension to webview. */
export type HostMessage =
  | { readonly type: 'state'; readonly state: ChatViewModel }
  | { readonly type: 'notice'; readonly level: 'info' | 'error'; readonly text: string };

/** Webview to extension. */
export type WebviewMessage =
  | { readonly type: 'submit'; readonly prompt: string }
  | { readonly type: 'cancel' };

/** The longest prompt the panel will forward. Beyond this it is almost certainly a paste accident. */
export const MAX_PROMPT_LENGTH = 32_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parse a message from the webview.
 *
 * `undefined` for anything unrecognised, including an empty prompt: the protocol
 * requires `turn.submit`'s prompt to be non-empty, and rejecting it here means the
 * engine never has to.
 */
export function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.type === 'cancel') return { type: 'cancel' };
  if (raw.type !== 'submit') return undefined;
  const prompt = raw.prompt;
  if (typeof prompt !== 'string') return undefined;
  const trimmed = prompt.trim();
  if (trimmed === '' || trimmed.length > MAX_PROMPT_LENGTH) return undefined;
  return { type: 'submit', prompt: trimmed };
}
