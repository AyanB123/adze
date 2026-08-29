/**
 * Ghost text, built out of a full turn because the protocol has no other way.
 *
 * `@adze/protocol` has no cheap-completion message: there is `turn.submit` and
 * nothing lighter. So a ghost-text suggestion allocates a turn id, runs the whole
 * turn machine, and bills like any other request. There is no fill-in-the-middle
 * shape either — `TurnSubmitParams.prompt` is a single non-empty string — so the
 * suffix has to be described inside the prompt rather than passed as its own field.
 *
 * Two consequences we own rather than hide:
 *
 * - The feature is **off by default**. Billing someone for keystrokes they did not
 *   deliberately submit is not a default worth shipping.
 * - The prompt below is explicit about wanting only a continuation, because the
 *   model on the other end is a general chat model, not a completion model. The
 *   extractor is written to survive it answering in prose or in a code fence
 *   anyway.
 *
 * Both are protocol gaps rather than extension bugs; see this package's README.
 * Pure functions only, so the prompt and the extraction are testable without a
 * model.
 */

export interface CompletionRequestInput {
  /** Whole document text. */
  readonly text: string;
  /** Cursor offset into {@link text}. */
  readonly offset: number;
  readonly languageId: string;
  readonly fileName: string;
  /** How much of the text before the cursor to include. */
  readonly maxPrefixBytes: number;
}

export interface CompletionRequest {
  readonly prompt: string;
  readonly prefix: string;
  readonly suffix: string;
}

/** Suffix context is capped harder than prefix: what follows matters less than what precedes. */
const SUFFIX_RATIO = 4;

const FENCE = /^```[^\n]*\n([\s\S]*?)\n?```$/;

/**
 * Whether a completion is worth asking for at all.
 *
 * Refuses on an empty prefix, because a completion at the very top of an empty file
 * is a guess at what the user is about to write, not a continuation of anything —
 * and it would still cost a full turn.
 */
export function shouldRequestCompletion(input: CompletionRequestInput): boolean {
  const prefix = input.text.slice(0, input.offset);
  return prefix.trim() !== '';
}

export function buildCompletionRequest(input: CompletionRequestInput): CompletionRequest {
  const prefixStart = Math.max(0, input.offset - input.maxPrefixBytes);
  const prefix = input.text.slice(prefixStart, input.offset);
  const suffix = input.text.slice(
    input.offset,
    input.offset + Math.floor(input.maxPrefixBytes / SUFFIX_RATIO),
  );

  const prompt = [
    `Continue the ${input.languageId} code in ${input.fileName} at the cursor.`,
    'Reply with the continuation only: no explanation, no code fence, no repetition of',
    'the text before the cursor. If nothing should be inserted, reply with nothing.',
    '',
    '<before-cursor>',
    prefix,
    '</before-cursor>',
    '<after-cursor>',
    suffix,
    '</after-cursor>',
  ].join('\n');

  return { prompt, prefix, suffix };
}

/**
 * Pull the insertable text out of whatever the model said.
 *
 * Strips a single wrapping code fence, then refuses anything that is empty or that
 * merely repeats the text already before the cursor — inserting a duplicate of the
 * current line is the most common and most annoying way ghost text goes wrong.
 * Leading whitespace is preserved, because indentation is part of the completion.
 */
export function extractCompletion(modelText: string, prefix: string): string | undefined {
  const trimmedEnds = modelText.replace(/^\n+/, '').replace(/\s+$/, '');
  if (trimmedEnds === '') return undefined;

  const fenced = FENCE.exec(trimmedEnds);
  const body = fenced?.[1] ?? trimmedEnds;
  if (body.trim() === '') return undefined;

  const currentLine = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (currentLine.trim() !== '' && body.trimStart().startsWith(currentLine.trim())) {
    return undefined;
  }
  return body;
}
