/**
 * The approval channel.
 *
 * ADR-0007's rule, at the surface: **`never` refuses rather than escalating.** The gate
 * already enforces that — it does not call this channel at all under `never` — and this
 * file's job is to not undo it. So the channel a `never` run gets is one that denies
 * unconditionally, which means that even a future gate bug cannot produce a grant here.
 * A policy that silently granted more than it advertised would make the entire model
 * untrustworthy, and it is the one behaviour worth defending twice.
 *
 * ### End of input is a denial
 *
 * `adze run` in CI has no terminal. A prompt written to a closed stdin gets `undefined`
 * back, and that is treated as **deny**, not as consent and not as a hang. Failing open
 * there would make a non-interactive run the most permissive way to invoke the tool,
 * which is exactly backwards. Failing to answer at all would make CI time out and look
 * like a hung agent.
 *
 * ### The prompt says what the gate is actually protecting
 *
 * On Windows there is no OS-level containment, so an approved command runs unconfined.
 * The prompt says that, because "allow this command?" in front of a user who believes a
 * sandbox exists is a question they answer with the wrong information (ADR-0007).
 */

import { createInterface, type Interface } from 'node:readline';
import type { ApprovalRequest, ApprovalResponse, SandboxEnforcement } from '@adze/protocol';
import type { Io, Style } from '../output.js';

/** What the engine is handed. Shaped so a test can supply a scripted one. */
export interface ApprovalChannel {
  readonly request: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  /** Number of requests seen. For the run summary. */
  readonly count: () => number;
  close(): void;
}

/** A line of input, or `undefined` at end of stream. */
export interface LineReader {
  read(prompt: string): Promise<string | undefined>;
  close(): void;
}

/** Streams {@link stdinReader} reads from and writes the prompt to. Injectable for tests. */
export interface StdinReaderOptions {
  readonly input?: NodeJS.ReadableStream;
  /**
   * Where the prompt text goes. **Defaults to stderr, and must not be stdout.**
   *
   * See {@link stdinReader}.
   */
  readonly output?: NodeJS.WritableStream;
}

/**
 * `node:readline` behind the {@link LineReader} seam.
 *
 * The prompt is written to **stderr**, not stdout, and that is load-bearing rather than
 * cosmetic. Under `--json` stdout carries the JSONL event stream and nothing else — the
 * contract `writeJson` states — so a prompt written there lands in the middle of an event
 * object and makes that line unparseable. The line it corrupts is whichever event the
 * approval was gating, which is exactly the `tool.started` a consumer needs, so the
 * trajectory stops being replayable at the first approval.
 *
 * Every other part of the approval UI already goes to stderr via `io.err`, so stdout was
 * also the one stream the question did not belong on for ordering reasons: the prompt and
 * the block explaining what is being approved were flushed independently and interleaved
 * out of order.
 *
 * ### Why lines are queued instead of using `rl.question()`
 *
 * `question()` attaches a one-shot listener, but readline emits a `line` event for every
 * line in a chunk the moment that chunk arrives. A pipe delivers all of its lines in one
 * chunk, so the answers to the second and later prompts were emitted while nothing was
 * listening and were dropped; the stream then ended and the next read saw a closed
 * interface. Every approval after the first silently became a denial with the answer
 * still in the buffer, and a lost answer is indistinguishable in the transcript from a
 * user who typed `n`.
 *
 * So a persistent listener owns the stream and `read` takes from a queue. End of input is
 * still a denial — see the file comment, that behaviour is deliberate — but now it means
 * the buffer is genuinely empty rather than that a chunk was mistimed.
 */
export function stdinReader(options: StdinReaderOptions = {}): LineReader {
  const output = options.output ?? process.stderr;
  let rl: Interface | undefined;
  /** Lines that arrived before any `read` asked for them. */
  const buffered: string[] = [];
  /** Pending `read` calls, oldest first, waiting for a line that has not arrived yet. */
  const waiting: ((line: string | undefined) => void)[] = [];
  /** No further line will ever arrive: the stream ended, or the reader was closed. */
  let ended = false;

  function settleAll(): void {
    // Nothing may be left holding a promise that never resolves: an unsettled approval
    // is a hung turn, which the file comment names as worse than a denial.
    while (waiting.length > 0) waiting.shift()?.(undefined);
  }

  function ensureInterface(): void {
    if (rl !== undefined || ended) return;
    rl = createInterface({
      input: options.input ?? process.stdin,
      output,
      terminal: false,
    });
    rl.on('line', (line: string) => {
      const waiter = waiting.shift();
      if (waiter === undefined) buffered.push(line);
      else waiter(line);
    });
    rl.on('close', () => {
      ended = true;
      settleAll();
    });
  }

  return {
    async read(prompt: string): Promise<string | undefined> {
      ensureInterface();
      // Written here rather than by `question()`, which is no longer used. Same stream as
      // before, so the stdout contract above is unchanged.
      output.write(prompt);

      const queued = buffered.shift();
      if (queued !== undefined) return queued;
      if (ended) return undefined;

      return new Promise<string | undefined>((resolve) => {
        waiting.push(resolve);
      });
    },
    close(): void {
      ended = true;
      settleAll();
      buffered.length = 0;
      rl?.close();
      rl = undefined;
    },
  };
}

/**
 * A channel that always denies, for `--approval never`.
 *
 * Also what a run with no reader gets. Both are the same decision for the same reason: no
 * consent was obtainable, so the answer is no.
 */
export function denyingChannel(reason: string): ApprovalChannel {
  let seen = 0;
  return {
    request: async (request) => {
      seen += 1;
      return { requestId: request.requestId, decision: 'deny', note: reason };
    },
    count: () => seen,
    close: () => undefined,
  };
}

const CHOICES = `[y]es once, [a]llow for this session, [n]o, [q]uit the turn`;

function summarize(request: ApprovalRequest): readonly string[] {
  const lines = [`  ${request.summary}`, `  why: ${request.reason}`];
  if (request.command !== undefined) lines.push(`  command: ${request.command.join(' ')}`);
  if (request.paths !== undefined && request.paths.length > 0) {
    lines.push(`  paths: ${request.paths.join(', ')}`);
  }
  return lines;
}

/**
 * Map a keystroke to a decision.
 *
 * An unrecognised answer is a **denial**, not a re-prompt. A user who typed something
 * unexpected has not consented, and looping until they type an accepted letter is how a
 * prompt gets answered by muscle memory — which ADR-0007 names as worse than not
 * prompting at all.
 */
export function decisionFor(answer: string | undefined): ApprovalResponse['decision'] {
  switch (answer?.trim().toLowerCase()) {
    case 'y':
    case 'yes':
      return 'allow-once';
    case 'a':
    case 'all':
    case 'always':
      return 'allow-session';
    case 'q':
    case 'quit':
    case 'abort':
      // Deny *and* end the turn. Distinct from `deny`, which lets the agent adapt.
      return 'abort';
    default:
      return 'deny';
  }
}

export interface PromptingChannelOptions {
  readonly io: Io;
  readonly style: Style;
  readonly reader: LineReader;
  /** How the sandbox is actually enforced, so the prompt can be honest about it. */
  readonly enforcement: SandboxEnforcement;
}

/** A channel that asks on stdin. */
export function promptingChannel(options: PromptingChannelOptions): ApprovalChannel {
  const { io, style, reader, enforcement } = options;
  let seen = 0;
  let warnedAboutContainment = false;

  return {
    request: async (request): Promise<ApprovalResponse> => {
      seen += 1;
      io.err(`\n${style.warn('approval needed')}\n`);
      for (const line of summarize(request)) io.err(`${line}\n`);

      if (enforcement === 'gate-only' && !warnedAboutContainment) {
        // Once per turn. Repeating it on every prompt is how it stops being read, and it
        // is the one sentence in this flow that must be read.
        warnedAboutContainment = true;
        io.err(
          `  ${style.dim('note: there is no OS-level sandbox here, so an approved action runs unconfined.')}\n`,
        );
      }

      const answer = await reader.read(`  ${CHOICES}: `);
      const decision = decisionFor(answer);

      if (answer === undefined) {
        // Not a hang and not consent. See the file comment.
        io.err(`  ${style.bad('denied')} (no input available)\n`);
        return {
          requestId: request.requestId,
          decision: 'deny',
          note: 'stdin closed, so no consent could be obtained',
        };
      }

      io.err(
        `  ${decision === 'deny' || decision === 'abort' ? style.bad(decision) : style.good(decision)}\n`,
      );
      return { requestId: request.requestId, decision };
    },
    count: () => seen,
    close: () => reader.close(),
  };
}
