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

import { createInterface, type Interface } from 'node:readline/promises';
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

/** `node:readline` behind the {@link LineReader} seam. */
export function stdinReader(): LineReader {
  let rl: Interface | undefined;
  return {
    async read(prompt: string): Promise<string | undefined> {
      rl ??= createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      try {
        return await rl.question(prompt);
      } catch {
        // Closed stream, or Ctrl-C during the question. Both are "no answer".
        return undefined;
      }
    },
    close(): void {
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
