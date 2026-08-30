/**
 * Exit codes and output helpers.
 *
 * Distinct exit codes because ADR-0001 §6.6 keeps the CLI plain-text and
 * scriptable before it is pretty: a script needs to tell "the edit was refused"
 * from "I passed the wrong flags", and a single non-zero code forces it back to
 * grepping stderr, which is not an interface.
 */

import pc from 'picocolors';

export const EXIT = {
  Ok: 0,
  /** The operation ran and the answer was no: a refusal, or a failed validation. */
  Failure: 1,
  /** The invocation was wrong. Bad flags, missing file, unreadable input. */
  Usage: 2,
  /** The command exists but is not built yet. See docs/roadmap.md. */
  NotImplemented: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Where output goes.
 *
 * Injected rather than reaching for `console` directly, so tests assert on real
 * output instead of on mocks. A CLI whose output is only ever checked through a
 * spy tends to grow output nobody has read.
 */
export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export const processIo: Io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/**
 * Colours, disabled together.
 *
 * `picocolors` already respects `NO_COLOR` and a non-TTY stdout. This wrapper adds
 * the `--json` case: machine-readable output must never carry escapes, and
 * threading a flag through every call site is how one of them gets missed.
 */
export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  good(s: string): string;
  bad(s: string): string;
  warn(s: string): string;
  info(s: string): string;
}

const identity = (s: string): string => s;

export const plainStyle: Style = {
  bold: identity,
  dim: identity,
  good: identity,
  bad: identity,
  warn: identity,
  info: identity,
};

export const colorStyle: Style = {
  bold: (s) => pc.bold(s),
  dim: (s) => pc.dim(s),
  good: (s) => pc.green(s),
  bad: (s) => pc.red(s),
  warn: (s) => pc.yellow(s),
  info: (s) => pc.cyan(s),
};

export function styleFor(json: boolean): Style {
  return json ? plainStyle : colorStyle;
}

/**
 * One JSON document per invocation, indented, newline-terminated.
 *
 * For the commands that emit exactly one document and then exit — `doctor`, `models`,
 * `apply`, `validate`. Indentation is readable there and costs nothing, because there is
 * no second document for it to run into.
 *
 * **Not for a JSONL stream.** See {@link writeJsonLine}.
 */
export function writeJson(io: Io, value: unknown): void {
  io.out(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * One JSON document on **one line**, for a stream where each line is a document.
 *
 * `run --json` and `chat --json` emit JSONL: the renderer writes one event per line and a
 * consumer reads it line by line. The run summary goes onto that same stream, so it has to
 * obey the same rule.
 *
 * It did not. The summary was written with {@link writeJson}, whose indented form spans
 * roughly twenty lines, so the last document of every JSON run arrived as twenty parse
 * errors — at exactly the point a consumer would read the result. The contract is stated
 * in `agent/render.ts` ("one event per line, verbatim") and again in `agent/approval.ts`
 * ("stdout carries the JSONL event stream and nothing else"); this function is what makes
 * the summary keep it.
 */
export function writeJsonLine(io: Io, value: unknown): void {
  io.out(`${JSON.stringify(value)}\n`);
}

/** `label: value` with the label padded, for the aligned blocks `doctor` prints. */
export function field(label: string, value: string, width = 22): string {
  return `  ${label.padEnd(width)} ${value}`;
}
