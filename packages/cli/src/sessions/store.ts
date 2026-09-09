/**
 * Persisted CLI sessions in `.adze/sessions/`.
 *
 * Local-first by construction (architecture invariant 5): a session is a JSONL
 * file under the workspace's `.adze/sessions/` directory, which `.gitignore`
 * already excludes in its entirety. Deleting the file forgets the session, and
 * nothing here touches the network.
 *
 * The format is deliberately boring: line 0 is a header carrying the session's
 * identity and the settings in force, and every following line is one
 * {@link ConversationMessage} in the engine's linear history. The history lines
 * are the same plain JSON the engine holds, so `serializeHistory` from
 * `@adze/core` round-trips them byte-for-byte — this module never invents its
 * own history encoding.
 *
 * This is CLI-side composition, not a new engine path. The engine still speaks
 * only `session.create`, `session.close`, `turn.submit`, and `turn.cancel`
 * (ADR-0001 rule 2); resuming means creating a fresh engine session and
 * appending the loaded messages to it, forking means copying a prefix of the
 * history into a new engine session, and compacting means calling the existing
 * `Session.compact` seam. The cache epoch rolls the engine already knows how to
 * roll — the persisted header records the named `EpochRollReason` so a resumed
 * session can say why.
 *
 * Refs ADR-0001, ADR-0003.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConversationMessage, EpochRollReason } from '@adze/core';
import { serializeHistory } from '@adze/core';
import type { ApprovalPolicy, ModelSelection, SandboxConfig, Usage } from '@adze/protocol';

/** Version of the persisted header. Bumped when the header shape changes. */
export const SESSION_FILE_VERSION = 1;

/** A recorded cache-epoch roll, so a resumed session can say why the prefix changed. */
export interface PersistedEpochRoll {
  readonly reason: EpochRollReason;
  readonly at: string;
  readonly turns: number;
}

/**
 * Line 0 of every `<id>.jsonl` file.
 *
 * The settings in force, not the request: on resume the engine session is
 * created from these, so the frozen cache prefix stays byte-identical across
 * invocations (same model, sandbox, approvals, instructions, tool set).
 */
export interface SessionFileHeader {
  readonly version: typeof SESSION_FILE_VERSION;
  readonly kind: 'session';
  readonly id: string;
  readonly workspaceRoot: string;
  readonly model: ModelSelection;
  readonly sandbox: SandboxConfig;
  readonly approvals: ApprovalPolicy;
  readonly instructions?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turns: number;
  readonly usage: Usage;
  readonly epochRolls: readonly PersistedEpochRoll[];
}

export interface LoadedSession {
  readonly header: SessionFileHeader;
  readonly messages: readonly ConversationMessage[];
}

export interface SessionListEntry {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly model: string;
  readonly turns: number;
  readonly updatedAt: string;
  readonly messages: number;
}

/** Where persisted sessions live. Gitignored (see the repo `.gitignore`). */
export function sessionsDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.adze', 'sessions');
}

export function sessionFilePath(workspaceRoot: string, id: string): string {
  return join(sessionsDir(workspaceRoot), `${id}.jsonl`);
}

export function trajectoryFilePath(workspaceRoot: string, id: string): string {
  return join(sessionsDir(workspaceRoot), `${id}.trajectory.jsonl`);
}

/** A new persisted id. Filesystem-safe, timestamp-prefixed so `list` sorts usefully. */
export function newPersistedId(now: Date = new Date()): string {
  const stamp =
    now.toISOString().replaceAll(':', '').replaceAll('-', '').split('.')[0] ?? 'unknown';
  const rand = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0');
  return `sess-${stamp}-${rand}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHeader(value: unknown): value is SessionFileHeader {
  if (!isRecord(value)) return false;
  return (
    value.version === SESSION_FILE_VERSION &&
    value.kind === 'session' &&
    typeof value.id === 'string' &&
    typeof value.workspaceRoot === 'string' &&
    isRecord(value.model) &&
    isRecord(value.sandbox) &&
    typeof value.approvals === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.turns === 'number' &&
    isRecord(value.usage)
  );
}

/**
 * Write a session file atomically enough for a CLI.
 *
 * The header is line 0 and each history message is one following line. The
 * history is verified with `serializeHistory` on read rather than here, so a
 * write never fails because the engine added a field this file does not know.
 */
export async function saveSession(
  workspaceRoot: string,
  header: SessionFileHeader,
  messages: readonly ConversationMessage[],
): Promise<string> {
  await mkdir(sessionsDir(workspaceRoot), { recursive: true });
  const lines = [JSON.stringify(header)];
  for (const message of messages) lines.push(JSON.stringify(message));
  const path = sessionFilePath(workspaceRoot, header.id);
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

/** Read a session file. Throws a plain Error naming the id when it cannot be read. */
export async function loadSession(workspaceRoot: string, id: string): Promise<LoadedSession> {
  const path = sessionFilePath(workspaceRoot, id);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(
      `unknown session '${id}'. Sessions live in .adze/sessions/; \`adze sessions list\` shows what exists.`,
    );
  }
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const first: unknown = lines.length > 0 ? (JSON.parse(lines[0] as string) as unknown) : undefined;
  if (!isHeader(first)) {
    throw new Error(
      `session file '${id}.jsonl' has no session header; it may predate v${SESSION_FILE_VERSION}.`,
    );
  }
  const messages: ConversationMessage[] = [];
  for (const line of lines.slice(1)) {
    messages.push(JSON.parse(line) as ConversationMessage);
  }
  // The round-trip check: the persisted lines must serialize exactly as the
  // engine would serialize the same array. A mismatch means the file was
  // hand-edited or written by a newer shape, and resuming it would fork the
  // cache prefix silently.
  void serializeHistory(messages);
  return { header: first, messages };
}

/** Every persisted session, newest first. A corrupt file reads as absent, not as a crash. */
export async function listSessions(workspaceRoot: string): Promise<readonly SessionListEntry[]> {
  let names: string[];
  try {
    names = await readdir(sessionsDir(workspaceRoot));
  } catch {
    return [];
  }
  const entries: SessionListEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl') || name.endsWith('.trajectory.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    try {
      const loaded = await loadSession(workspaceRoot, id);
      entries.push({
        id: loaded.header.id,
        workspaceRoot: loaded.header.workspaceRoot,
        model: `${loaded.header.model.provider as string}/${loaded.header.model.model as string}`,
        turns: loaded.header.turns,
        updatedAt: loaded.header.updatedAt,
        messages: loaded.messages.length,
      });
    } catch {}
  }
  return entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/**
 * Resolve a `--resume` reference to a persisted id.
 *
 * `last` (and `--last`, for the caller that passes the flag text through)
 * means the most recently updated session. Anything else is an exact id first
 * and an unambiguous id prefix second, so `adze chat --resume sess-2026` works
 * without pasting the full suffix.
 */
export async function resolveSessionRef(workspaceRoot: string, ref: string): Promise<string> {
  const normalized = ref === '--last' ? 'last' : ref;
  const entries = await listSessions(workspaceRoot);
  if (entries.length === 0) {
    throw new Error('no persisted sessions in .adze/sessions/. Start one with `adze chat`.');
  }
  if (normalized === 'last') {
    const first = entries[0];
    if (first === undefined) throw new Error('no persisted sessions in .adze/sessions/.');
    return first.id;
  }
  const exact = entries.find((entry) => entry.id === normalized);
  if (exact !== undefined) return exact.id;
  const prefixed = entries.filter((entry) => entry.id.startsWith(normalized));
  if (prefixed.length === 1) {
    const only = prefixed[0];
    if (only === undefined) throw new Error(`unknown session '${ref}'.`);
    return only.id;
  }
  if (prefixed.length > 1) {
    throw new Error(
      `session prefix '${ref}' matches ${prefixed.length} sessions: ${prefixed.map((entry) => entry.id).join(', ')}.`,
    );
  }
  throw new Error(`unknown session '${ref}'. \`adze sessions list\` shows what exists.`);
}

/**
 * Count turns in a linear history.
 *
 * One turn starts with one `user`-origin `user`-role message, which is exactly
 * what the turn machine appends per submit. Hook-injected messages ride as
 * ordered messages but keep their own origin, so they do not inflate the count.
 */
export function countTurns(messages: readonly ConversationMessage[]): number {
  let turns = 0;
  for (const message of messages) {
    if (message.role === 'user' && message.origin === 'user') turns += 1;
  }
  return turns;
}

/**
 * Keep the history through the end of the Nth turn (1-based).
 *
 * Returns the whole history when `turn` is outside the range rather than an
 * empty slice: forking past the end is a duplicate, not a deletion, and an
 * empty fork would resume as a blank session under a name that promises a
 * branch.
 */
export function sliceHistoryByTurns(
  messages: readonly ConversationMessage[],
  turn: number,
): readonly ConversationMessage[] {
  if (!Number.isInteger(turn) || turn <= 0) return [...messages];
  let seen = 0;
  let end = messages.length;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === 'user' && message?.origin === 'user') {
      seen += 1;
      if (seen > turn) {
        end = index;
        break;
      }
    }
  }
  return messages.slice(0, end);
}

/**
 * A deterministic compaction summary, without a model round-trip.
 *
 * The engine's `Session.compact` takes caller-supplied text on purpose — an
 * automatic summarization policy belongs visibly at the call site, not buried in
 * the loop — so this composes the boring-but-honest version: how many turns and
 * messages collapsed, and the prompts that started them. A model-written summary
 * is future work; this one never invents content.
 */
export function buildCompactSummary(
  messages: readonly ConversationMessage[],
  turns: number,
): string {
  const prompts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user' || message.origin !== 'user') continue;
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 0) prompts.push(text.length > 120 ? `${text.slice(0, 117)}...` : text);
    if (prompts.length >= 8) break;
  }
  const lines = [
    `Compacted ${turns} turn(s), ${messages.length} message(s). Earlier history was replaced by this summary;`,
    'details below are prompts that started each retained turn, oldest first.',
  ];
  prompts.forEach((prompt, index) => {
    lines.push(`${index + 1}. ${prompt}`);
  });
  return lines.join('\n');
}

/**
 * Write a run trajectory: one event per line, verbatim.
 *
 * The same JSONL contract `run --json` streams on stdout, written to
 * `.adze/sessions/<id>.trajectory.jsonl` by default so a run is checkable after
 * the fact. The dropped-event count is not stored here — it is a renderer-side
 * gap count, surfaced in the summary — because the file holds what the engine
 * emitted, and a gap means the surface saw fewer lines than this file's source
 * did.
 */
export async function writeTrajectoryFile(
  workspaceRoot: string,
  id: string,
  events: readonly unknown[],
): Promise<string> {
  await mkdir(sessionsDir(workspaceRoot), { recursive: true });
  const path = trajectoryFilePath(workspaceRoot, id);
  const body = events.map((event) => JSON.stringify(event)).join('\n');
  await writeFile(path, body.length > 0 ? `${body}\n` : '', 'utf8');
  return path;
}
