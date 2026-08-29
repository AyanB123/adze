/**
 * Result truncation and continuations.
 *
 * Unbounded tool output is a context-window denial-of-service, so the engine
 * caps every result (ADR-0004). Two details decide whether that cap helps or
 * hurts.
 *
 * **Where the cut falls.** Head-biased truncation is the obvious implementation
 * and the wrong one for command output: a failing test run puts the assertion,
 * the stack, and the summary at the *end*, so keeping the first 8 KB keeps the
 * banner and discards the answer. ADR-0003 identifies test feedback as the one
 * intervention with a large measured effect — +36 points on a public edit
 * benchmark from a single retry round — which makes "which half we keep" a
 * correctness question rather than a formatting one. Commands truncate from the
 * middle, keeping both ends; file reads truncate from the tail, because a file is
 * read forwards.
 *
 * **Saying so.** `truncated` is an explicit marker and never inferred from
 * length, and it comes with a way to ask for the rest. Without that, truncation
 * is silent data loss and the model reasons about a file whose end it cannot see.
 */

import type { ContentBlock, Truncation } from '@adze/protocol';

/** Where the surviving text is taken from. */
export type TruncationBias =
  /** Keep the beginning. For files and listings, which are read forwards. */
  | 'head'
  /** Keep the end. For a log whose conclusion is the point. */
  | 'tail'
  /** Keep both ends and elide the middle. For command output. */
  | 'both';

export interface TruncateOptions {
  readonly maxBytes: number;
  readonly bias: TruncationBias;
  /**
   * Marker inserted where text was removed. Addressed to the model, so it says
   * what happened rather than decorating the gap.
   */
  readonly marker?: string;
}

export interface TruncateResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly returnedBytes: number;
}

const DEFAULT_MARKER = '[... elided by the engine: output exceeded the result budget ...]';

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Cut `text` to `maxBytes`, on a line boundary where one is available.
 *
 * Line boundaries matter because a cut mid-token produces text that looks like
 * source code and is not — the model then reasons about an identifier that does
 * not exist. When a single line is itself over budget the cut is byte-wise, since
 * refusing to return anything would be worse.
 */
export function truncateText(text: string, options: TruncateOptions): TruncateResult {
  const originalBytes = byteLength(text);
  if (originalBytes <= options.maxBytes) {
    return { text, truncated: false, originalBytes, returnedBytes: originalBytes };
  }

  const marker = options.marker ?? DEFAULT_MARKER;
  const markerBytes = byteLength(`\n${marker}\n`);
  const budget = Math.max(0, options.maxBytes - markerBytes);

  let kept: string;
  switch (options.bias) {
    case 'head':
      kept = `${takeHead(text, budget)}\n${marker}\n`;
      break;
    case 'tail':
      kept = `\n${marker}\n${takeTail(text, budget)}`;
      break;
    case 'both': {
      // Two thirds to the tail: a failure's diagnosis is at the end, but the
      // command echo and the first error are usually at the start.
      const tailBudget = Math.floor((budget * 2) / 3);
      const headBudget = budget - tailBudget;
      kept = `${takeHead(text, headBudget)}\n${marker}\n${takeTail(text, tailBudget)}`;
      break;
    }
  }

  return {
    text: kept,
    truncated: true,
    originalBytes,
    returnedBytes: byteLength(kept),
  };
}

function takeHead(text: string, budget: number): string {
  if (budget <= 0) return '';
  const slice = sliceBytes(text, 0, budget);
  const lastBreak = slice.lastIndexOf('\n');
  return lastBreak > 0 ? slice.slice(0, lastBreak) : slice;
}

function takeTail(text: string, budget: number): string {
  if (budget <= 0) return '';
  const buf = Buffer.from(text, 'utf8');
  const slice = buf.subarray(Math.max(0, buf.length - budget)).toString('utf8');
  const firstBreak = slice.indexOf('\n');
  return firstBreak >= 0 && firstBreak < slice.length - 1 ? slice.slice(firstBreak + 1) : slice;
}

function sliceBytes(text: string, start: number, length: number): string {
  return Buffer.from(text, 'utf8')
    .subarray(start, start + length)
    .toString('utf8');
}

/**
 * Truncate a tool's content blocks to a byte budget.
 *
 * Images are counted against the budget but never cut — a partial image is not a
 * smaller image, it is a corrupt one — so an oversized image is dropped whole and
 * the elision is reported in a text block. Text blocks share the remaining
 * budget.
 */
export function truncateContent(
  content: readonly ContentBlock[],
  options: TruncateOptions,
): { readonly content: readonly ContentBlock[]; readonly truncation: Truncation | undefined } {
  const originalBytes = content.reduce((sum, block) => sum + blockBytes(block), 0);
  if (originalBytes <= options.maxBytes) return { content, truncation: undefined };

  const out: ContentBlock[] = [];
  let dropped = 0;
  let remaining = options.maxBytes;
  let cut = false;

  for (const block of content) {
    if (block.type === 'image') {
      const size = blockBytes(block);
      if (size <= remaining) {
        out.push(block);
        remaining -= size;
      } else {
        dropped += 1;
        cut = true;
      }
      continue;
    }
    if (remaining <= 0) {
      cut = true;
      continue;
    }
    const result = truncateText(block.text, { ...options, maxBytes: remaining });
    out.push({ ...block, text: result.text });
    remaining -= result.returnedBytes;
    cut = cut || result.truncated;
  }

  if (dropped > 0) {
    out.push({
      type: 'text',
      text: `[... ${dropped} image attachment(s) omitted: over the result budget ...]`,
    });
  }

  const returnedBytes = out.reduce((sum, block) => sum + blockBytes(block), 0);
  if (!cut) return { content: out, truncation: undefined };
  return { content: out, truncation: { originalBytes, returnedBytes } };
}

function blockBytes(block: ContentBlock): number {
  return block.type === 'text' ? byteLength(block.text) : byteLength(block.data);
}

/**
 * Retained full text behind a continuation token.
 *
 * A token is only issued when the engine actually holds the rest, so a token is
 * always redeemable. That is the difference between honouring ADR-0004's
 * "a way to request more" and printing a promise: a token for output nobody kept
 * is worse than no token, because the model spends a step discovering it.
 *
 * Bounded by entry count and total bytes, evicting oldest-first. A store that
 * grows with the session would turn long runs into a memory leak, and the data is
 * a convenience rather than part of the trajectory — history already records what
 * the model saw.
 */
export class ContinuationStore {
  private readonly entries = new Map<string, { label: string; text: string }>();
  private bytes = 0;

  constructor(
    private readonly nextId: () => string,
    private readonly maxEntries = 64,
    private readonly maxBytes = 8 * 1024 * 1024,
  ) {}

  /** Retain `text` and return its token, or `undefined` if it cannot be held. */
  register(label: string, text: string): string | undefined {
    const size = byteLength(text);
    if (size > this.maxBytes) return undefined;
    const token = this.nextId();
    this.entries.set(token, { label, text });
    this.bytes += size;
    this.evict();
    return token;
  }

  resolve(token: string): { readonly label: string; readonly text: string } | undefined {
    return this.entries.get(token);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      const entry = this.entries.get(oldest.value);
      if (entry !== undefined) this.bytes -= byteLength(entry.text);
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * Characters per token, for budgeting only.
 *
 * Four is the conventional English-and-code average and is deliberately *not* a
 * tokenizer: bundling one would add a large dependency that still disagrees with
 * whichever model is configured. Token *budgets* are enforced against
 * provider-reported usage, which is authoritative; this estimate only sizes a
 * read window before the call.
 */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
