/**
 * Structured command and test feedback.
 *
 * ADR-0003 identifies one intervention with a large measured effect: a single
 * round of test feedback moved pass rate from 52.0% to 88.0% on a public edit
 * benchmark. **+36 points from letting the agent see its tests fail and try
 * again** — more than everything the ADR rejects, combined. That makes this file
 * a load-bearing part of the loop rather than output formatting.
 *
 * The requirement is that failing output returns to the model *structured*, not as
 * a wall of stdout. Two things follow.
 *
 * **Extract the diagnosis.** A failing test run buries a dozen useful lines in
 * thousands of uninteresting ones. Lines matching known failure shapes are pulled
 * to the front, so the model does not spend its attention budget — or a
 * truncation budget — locating them.
 *
 * **Keep the end.** Test runners put the assertion, the stack, and the summary
 * last. Head-biased truncation therefore discards precisely the part that matters,
 * which is why {@link truncateText} is called with a middle-eliding bias here and
 * a head bias for file reads.
 *
 * The patterns are deliberately conservative and deliberately *additive*: a line
 * that is not recognised still reaches the model through the retained output, so a
 * missed pattern costs some ordering and never costs information. A pattern set
 * that dropped unrecognised lines would silently hide failures from unfamiliar
 * tools, which is the opposite of the point.
 */

import type { ContentBlock } from '@adze/protocol';
import type { CommandCompleted, CommandOutcome } from './broker.js';
import { truncateText } from './truncate.js';

/**
 * Line shapes that indicate a failure, across the runners agents actually meet.
 *
 * Ordered by nothing: every pattern is tried against every line, and a line
 * matching any of them is extracted once. Adding a runner means adding a pattern,
 * and a wrong pattern degrades ranking rather than correctness.
 */
const FAILURE_PATTERNS: readonly RegExp[] = [
  // Generic runner verdicts.
  /^\s*(?:FAIL|FAILED|FAILURES?|ERROR)\b/,
  /^\s*(?:error|Error|Exception|panic):/,
  // vitest / jest / mocha markers.
  /^\s*[×✕✗✘]\s/,
  /^\s*●\s/,
  /^\s*\d+\)\s/,
  // Assertion bodies.
  /\bAssertionError\b/,
  /\b(?:expected|Expected)\b[^\n]*\b(?:received|Received|to\s+be|toBe|toEqual)\b/,
  /^\s*[-+]\s*(?:Expected|Received)\b/,
  // TypeScript and other compilers.
  /\(\d+,\d+\):\s*error\s+[A-Z]{1,3}\d+:/,
  /^error(?:\[[A-Z]\d+\])?:/,
  // Python.
  /^\s*File\s+".+",\s+line\s+\d+/,
  /^\w*(?:Error|Exception):/,
  /^\s*E\s{3}/,
  /**
   * pytest section banners: `=========== FAILURES ===========`.
   *
   * A separate pattern because the keyword is not at the start of the line — the
   * generic verdict pattern anchors after leading whitespace and a banner leads with
   * `=`. Found by `test/test-feedback.test.ts`, which is the argument for testing the
   * extractor against real runner output rather than against invented lines.
   */
  /^=+\s*(?:FAILURES|ERRORS)\b/i,
  // Go.
  /^\s*---\s+FAIL:/,
  // Summary counts.
  /\b\d+\s+(?:failed|failing|error|errors)\b/i,
  /^\s*Tests?:\s/,
  // Stack frames, which localise the failure.
  /^\s+at\s+.+:\d+:\d+\)?\s*$/,
];

/** Ceiling on extracted lines. Beyond this the excerpt is the better artifact. */
const MAX_FAILURE_LINES = 40;

export interface CommandStructure {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  /** Failure-shaped lines, in source order, deduplicated. */
  readonly failureLines: readonly string[];
  readonly durationMs: number;
}

/**
 * Pull failure-shaped lines out of combined output.
 *
 * Deduplicated because a stack repeated across twenty failing cases is one piece
 * of information and twenty lines of budget. Order is preserved so the first
 * failure still reads as the first failure.
 */
export function extractFailureLines(text: string, max = MAX_FAILURE_LINES): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.trim().length === 0) continue;
    if (!FAILURE_PATTERNS.some((pattern) => pattern.test(line))) continue;
    const key = line.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

export function summarizeCommand(completed: CommandCompleted): CommandStructure {
  const combined = `${completed.stdout}\n${completed.stderr}`;
  const ok = completed.exitCode === 0 && !completed.timedOut && !completed.cancelled;
  return {
    ok,
    exitCode: completed.exitCode,
    signal: completed.signal,
    timedOut: completed.timedOut,
    cancelled: completed.cancelled,
    // Only extracted on failure. On success the lines are noise, and a passing run
    // that mentions the word "error" in a log line should not read as a failure.
    failureLines: ok ? [] : extractFailureLines(combined),
    durationMs: completed.durationMs,
  };
}

export interface CommandRenderOptions {
  /** Byte ceiling for the retained output excerpt. */
  readonly maxOutputBytes: number;
  /** The command as it ran, echoed so the model can correlate. */
  readonly command: string;
}

/**
 * Build the content blocks for a completed command.
 *
 * The status line is a compact key/value list rather than prose: the engine
 * renders nothing, and a model parses `exit=1` more reliably than a sentence
 * about it.
 */
export function renderCommandResult(
  completed: CommandCompleted,
  options: CommandRenderOptions,
): {
  readonly content: readonly ContentBlock[];
  readonly structure: CommandStructure;
  readonly outputTruncated: boolean;
} {
  const structure = summarizeCommand(completed);
  const blocks: ContentBlock[] = [];

  blocks.push({ type: 'text', text: statusLine(structure, options.command, completed) });

  if (structure.failureLines.length > 0) {
    blocks.push({
      type: 'text',
      text: `failures:\n${structure.failureLines.join('\n')}`,
    });
  }

  const combined = joinStreams(completed);
  const excerpt = truncateText(combined, {
    maxBytes: options.maxOutputBytes,
    // Middle-eliding: the command echo and first error are at the start, the
    // assertion and summary at the end. Keeping only one end loses one of them.
    bias: 'both',
    marker: '[... output elided by the engine: over the result budget ...]',
  });

  if (excerpt.text.trim().length > 0) {
    blocks.push({ type: 'text', text: `output:\n${excerpt.text}` });
  } else {
    blocks.push({ type: 'text', text: 'output: (none)' });
  }

  return { content: blocks, structure, outputTruncated: excerpt.truncated };
}

function statusLine(
  structure: CommandStructure,
  command: string,
  completed: CommandCompleted,
): string {
  const parts = [
    `command: ${command}`,
    `exit: ${structure.exitCode === null ? `signal ${structure.signal ?? 'unknown'}` : structure.exitCode}`,
    `duration_ms: ${Math.round(structure.durationMs)}`,
    `containment: ${completed.enforcement}`,
  ];
  if (structure.timedOut) parts.push('timed_out: true');
  if (structure.cancelled) parts.push('cancelled: true');
  if (completed.outputCapped) parts.push('output_capped: true');
  return parts.join('\n');
}

function joinStreams(completed: CommandCompleted): string {
  const out = completed.stdout.trimEnd();
  const err = completed.stderr.trimEnd();
  if (err.length === 0) return out;
  if (out.length === 0) return err;
  return `${out}\n${err}`;
}

/** Content for a command that never started. Distinct from a non-zero exit. */
export function renderSpawnFailure(
  outcome: Extract<CommandOutcome, { kind: 'spawn-failed' }>,
  command: string,
): readonly ContentBlock[] {
  return [
    {
      type: 'text',
      text:
        `command: ${command}\nstatus: did not start\nreason: ${outcome.message}\n` +
        `This is not a failing command — the program could not be launched. ` +
        `Check that it is installed and on PATH, or use a different approach.`,
    },
  ];
}
