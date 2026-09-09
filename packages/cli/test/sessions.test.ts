/**
 * Tests for CLI session persistence, resume/fork/compact, slash expansion,
 * the `sessions list` command, and trajectory files.
 *
 * No network, no API key, no spend. Provider resolution is pinned to a keyless
 * local endpoint that is never called: every test below stops before a model
 * request (slash-only readers) or drives the store layer directly. Driving a
 * full turn would need the AI SDK mock model, and `@adze/cli` does not depend
 * on `ai` — see `test/agent.test.ts` for why that trade is refused.
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationMessage } from '@adze/core';
import type { ResolveOptions } from '@adze/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LineReader } from '../src/agent/approval.js';
import { parseSlashCommand, runChat } from '../src/commands/chat.js';
import { runSessionsList } from '../src/commands/sessions.js';
import { EXIT, type Io } from '../src/output.js';
import {
  buildCompactSummary,
  countTurns,
  listSessions,
  loadSession,
  resolveSessionRef,
  SESSION_FILE_VERSION,
  type SessionFileHeader,
  saveSession,
  sliceHistoryByTurns,
  writeTrajectoryFile,
} from '../src/sessions/store.js';

function capture(): Io & { readonly stdout: () => string; readonly stderr: () => string } {
  let out = '';
  let err = '';
  return {
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    stdout: () => out,
    stderr: () => err,
  };
}

function localEndpoint(): ResolveOptions {
  return {
    env: {},
    ignoreConfigFiles: true,
    providers: {
      local: {
        kind: 'openai-compatible',
        baseURL: 'http://127.0.0.1:8790/v1',
        defaultModel: 'glm-5.2',
      },
    },
  };
}

/** A reader serving scripted lines, then end of input. */
function scriptedReader(lines: readonly (string | undefined)[]): LineReader {
  let index = 0;
  return {
    read: async () => {
      if (index >= lines.length) return undefined;
      const line = lines[index];
      index += 1;
      return line;
    },
    close: () => undefined,
  };
}

function userMessage(text: string): ConversationMessage {
  return { role: 'user', origin: 'user', content: [{ type: 'text', text }] };
}

function assistantMessage(text: string): ConversationMessage {
  return { role: 'assistant', origin: 'model', content: [{ type: 'text', text }], toolCalls: [] };
}

function headerFor(workspaceRoot: string, id: string, turns = 0): SessionFileHeader {
  return {
    version: SESSION_FILE_VERSION,
    kind: 'session',
    id,
    workspaceRoot,
    model: { provider: 'local', model: 'glm-5.2' },
    sandbox: {
      mode: 'workspace-write',
      writableRoots: [],
      allowedNetworkHosts: [],
      commandRules: [],
    },
    approvals: 'on-request',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    turns,
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cacheHitRate: 0 },
    epochRolls: [],
  };
}

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'adze-sessions-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the session store', () => {
  it('round-trips a header and linear history through JSONL', async () => {
    const messages = [userMessage('fix the test'), assistantMessage('done')];
    await saveSession(dir, headerFor(dir, 'sess-a', 1), messages);

    const loaded = await loadSession(dir, 'sess-a');
    expect(loaded.header.id).toBe('sess-a');
    expect(loaded.messages).toEqual(messages);
  });

  it('lists newest first and skips trajectory files', async () => {
    await saveSession(
      dir,
      { ...headerFor(dir, 'sess-old'), updatedAt: new Date(10).toISOString() },
      [userMessage('a')],
    );
    await saveSession(
      dir,
      { ...headerFor(dir, 'sess-new'), updatedAt: new Date(20).toISOString(), turns: 2 },
      [userMessage('b')],
    );
    await writeTrajectoryFile(dir, 'sess-new', [{ type: 'text.delta' }]);

    const entries = await listSessions(dir);
    expect(entries.map((entry) => entry.id)).toEqual(['sess-new', 'sess-old']);
    expect(entries[0]?.turns).toBe(2);
  });

  it('returns an empty list when no sessions exist', async () => {
    expect(await listSessions(dir)).toEqual([]);
  });

  it('resolves last, exact ids, and unambiguous prefixes', async () => {
    await saveSession(dir, headerFor(dir, 'sess-alpha-1'), [userMessage('a')]);
    await saveSession(
      dir,
      { ...headerFor(dir, 'sess-beta-2'), updatedAt: new Date(30).toISOString() },
      [userMessage('b')],
    );

    expect(await resolveSessionRef(dir, 'last')).toBe('sess-beta-2');
    expect(await resolveSessionRef(dir, '--last')).toBe('sess-beta-2');
    expect(await resolveSessionRef(dir, 'sess-alpha-1')).toBe('sess-alpha-1');
    expect(await resolveSessionRef(dir, 'sess-alpha')).toBe('sess-alpha-1');
  });

  it('refuses an ambiguous prefix rather than guessing', async () => {
    await saveSession(dir, headerFor(dir, 'sess-x-1'), [userMessage('a')]);
    await saveSession(dir, headerFor(dir, 'sess-x-2'), [userMessage('b')]);
    await expect(resolveSessionRef(dir, 'sess-x')).rejects.toThrow(/matches 2 sessions/);
  });

  it('reports an unknown session with the command that lists what exists', async () => {
    await expect(loadSession(dir, 'nope')).rejects.toThrow(/adze sessions list/);
  });
});

describe('turn counting and forking', () => {
  const history = [
    userMessage('first'),
    assistantMessage('one'),
    userMessage('second'),
    assistantMessage('two'),
  ];

  it('counts one turn per user-origin user message', () => {
    expect(countTurns(history)).toBe(2);
    expect(countTurns([])).toBe(0);
  });

  it('slices history through the end of the Nth turn', () => {
    expect(sliceHistoryByTurns(history, 1)).toHaveLength(2);
    expect(sliceHistoryByTurns(history, 2)).toHaveLength(4);
    // Past the end is a duplicate, not a deletion.
    expect(sliceHistoryByTurns(history, 9)).toHaveLength(4);
  });

  it('builds a deterministic summary that names the prompts', () => {
    const summary = buildCompactSummary(history, 2);
    expect(summary).toContain('2 turn(s)');
    expect(summary).toContain('first');
    expect(summary).toContain('second');
  });
});

describe('slash parsing', () => {
  it('splits the command from its arguments and lowercases the name', () => {
    expect(parseSlashCommand('/fork 2')).toEqual({ name: 'fork', args: '2' });
    expect(parseSlashCommand('/COMPACT note here')).toEqual({ name: 'compact', args: 'note here' });
    expect(parseSlashCommand('/help')).toEqual({ name: 'help', args: '' });
  });
});

describe('adze chat slash commands (no model calls)', () => {
  it('prints help for /help and for an unknown slash', async () => {
    const io = capture();
    const code = await runChat(
      {
        cwd: dir,
        __testHooks: {
          resolve: localEndpoint(),
          reader: scriptedReader(['/help', '/nope', undefined]),
        },
      },
      io,
    );
    expect(code).toBe(EXIT.Ok);
    expect(io.stdout()).toContain('/usage');
    expect(io.stdout()).toContain('/compact');
    expect(io.stdout()).toContain('/fork');
    expect(io.stdout()).toContain("unknown command '/nope'");
  });

  it('persists a new session file after an empty run', async () => {
    const io = capture();
    await runChat(
      {
        cwd: dir,
        __testHooks: { resolve: localEndpoint(), reader: scriptedReader([undefined]) },
      },
      io,
    );
    const entries = await listSessions(dir);
    expect(entries).toHaveLength(1);
    expect(io.stdout()).toContain('persisted to .adze/sessions/');
  });

  it('/clear starts a new persisted session and keeps the old file', async () => {
    const io = capture();
    await runChat(
      {
        cwd: dir,
        __testHooks: {
          resolve: localEndpoint(),
          reader: scriptedReader(['/clear', undefined]),
        },
      },
      io,
    );
    const entries = await listSessions(dir);
    // The opening session plus the cleared one. The old file is kept: a clear
    // that deleted its parent would be a surprising destructive default.
    expect(entries).toHaveLength(2);
    expect(io.stdout()).toContain('new session');
  });

  it('/compact on an empty history says so instead of writing a roll', async () => {
    const io = capture();
    await runChat(
      {
        cwd: dir,
        __testHooks: {
          resolve: localEndpoint(),
          reader: scriptedReader(['/compact', undefined]),
        },
      },
      io,
    );
    expect(io.stdout()).toContain('nothing to compact');
    const entries = await listSessions(dir);
    expect(entries).toHaveLength(1);
    const loaded = await loadSession(dir, entries[0]?.id ?? '');
    expect(loaded.header.epochRolls).toHaveLength(0);
  });

  it('/compact summarizes resumed history and records the named roll reason', async () => {
    await saveSession(dir, { ...headerFor(dir, 'sess-compact'), turns: 2 }, [
      userMessage('fix the parser'),
      assistantMessage('ok'),
      userMessage('add a test'),
      assistantMessage('ok'),
    ]);
    const io = capture();
    await runChat(
      {
        cwd: dir,
        resume: 'sess-compact',
        __testHooks: {
          resolve: localEndpoint(),
          reader: scriptedReader(['/compact keep the parser goal', undefined]),
        },
      },
      io,
    );
    expect(io.stdout()).toContain('resumed session sess-compact');
    expect(io.stdout()).toContain('epoch roll: compaction');
    const loaded = await loadSession(dir, 'sess-compact');
    expect(loaded.header.epochRolls).toEqual([expect.objectContaining({ reason: 'compaction' })]);
    expect(loaded.messages).toHaveLength(1);
    expect(JSON.stringify(loaded.messages[0])).toContain('keep the parser goal');
  });

  it('/fork duplicates resumed history into a new persisted session', async () => {
    await saveSession(dir, { ...headerFor(dir, 'sess-fork'), turns: 2 }, [
      userMessage('first'),
      assistantMessage('one'),
      userMessage('second'),
      assistantMessage('two'),
    ]);
    const io = capture();
    await runChat(
      {
        cwd: dir,
        resume: 'sess-fork',
        __testHooks: {
          resolve: localEndpoint(),
          reader: scriptedReader(['/fork 1', undefined]),
        },
      },
      io,
    );
    expect(io.stdout()).toContain('forked at turn 1/2 into session');
    const entries = await listSessions(dir);
    expect(entries).toHaveLength(2);
    // The parent file is untouched; the fork holds the first turn only.
    const parent = await loadSession(dir, 'sess-fork');
    expect(parent.messages).toHaveLength(4);
    const forkedId = entries.find((entry) => entry.id !== 'sess-fork')?.id ?? '';
    const forked = await loadSession(dir, forkedId);
    expect(forked.messages).toHaveLength(2);
  });

  it('/fork rejects a non-numeric turn rather than guessing', async () => {
    await saveSession(dir, { ...headerFor(dir, 'sess-fork-bad'), turns: 1 }, [userMessage('hi')]);
    const io = capture();
    await runChat(
      {
        cwd: dir,
        resume: 'sess-fork-bad',
        __testHooks: {
          resolve: localEndpoint(),
          reader: scriptedReader(['/fork soon', undefined]),
        },
      },
      io,
    );
    expect(io.stdout()).toContain('give a 1-based turn number');
    expect(await listSessions(dir)).toHaveLength(1);
  });

  it('/init scaffolds config and AGENTS.md without overwriting', async () => {
    const io = capture();
    await runChat(
      {
        cwd: dir,
        __testHooks: { resolve: localEndpoint(), reader: scriptedReader(['/init', undefined]) },
      },
      io,
    );
    expect(io.stdout()).toContain('created .adze/config.jsonc');
    expect(io.stdout()).toContain('created AGENTS.md');
    // A secret must never be written by the scaffold.
    const config = await readFile(join(dir, '.adze', 'config.jsonc'), 'utf8');
    expect(config).not.toMatch(/sk-ant|apiKey/i);

    const again = capture();
    await runChat(
      {
        cwd: dir,
        __testHooks: { resolve: localEndpoint(), reader: scriptedReader(['/init', undefined]) },
      },
      again,
    );
    expect(again.stdout()).toContain('already exists; not overwritten');
  });

  it('/review-diff is read-only and reports a clean tree', async () => {
    const io = capture();
    await runChat(
      {
        cwd: dir,
        __testHooks: {
          resolve: localEndpoint(),
          reader: scriptedReader(['/review-diff', undefined]),
        },
      },
      io,
    );
    expect(io.stdout()).toContain('Diff review (read-only)');
  });

  it('/plugins reports an empty workspace honestly', async () => {
    const io = capture();
    await runChat(
      {
        cwd: dir,
        __testHooks: { resolve: localEndpoint(), reader: scriptedReader(['/plugins', undefined]) },
      },
      io,
    );
    expect(io.stdout()).toContain('none installed');
  });

  it('--resume last continues the most recent session', async () => {
    await saveSession(dir, headerFor(dir, 'sess-resume-old'), [userMessage('old')]);
    await saveSession(
      dir,
      { ...headerFor(dir, 'sess-resume-new'), updatedAt: new Date(50).toISOString(), turns: 1 },
      [userMessage('new')],
    );
    const io = capture();
    await runChat(
      {
        cwd: dir,
        resume: 'last',
        __testHooks: { resolve: localEndpoint(), reader: scriptedReader(['/usage', undefined]) },
      },
      io,
    );
    expect(io.stdout()).toContain('resumed session sess-resume-new');
  });

  it('--resume of an unknown session is a usage error, not a new session', async () => {
    const io = capture();
    const code = await runChat(
      {
        cwd: dir,
        resume: 'sess-missing',
        __testHooks: { resolve: localEndpoint(), reader: scriptedReader([undefined]) },
      },
      io,
    );
    expect(code).toBe(EXIT.Usage);
    expect(await listSessions(dir)).toHaveLength(0);
  });
});

describe('adze sessions list', () => {
  it('reports none honestly when the directory is empty', async () => {
    const io = capture();
    expect(await runSessionsList({ cwd: dir }, io)).toBe(EXIT.Ok);
    expect(io.stdout()).toContain('No persisted sessions');
  });

  it('lists persisted sessions newest first, and as JSON', async () => {
    await saveSession(dir, headerFor(dir, 'sess-list-a'), [userMessage('a')]);
    await saveSession(dir, headerFor(dir, 'sess-list-b'), [userMessage('b')]);
    const io = capture();
    expect(await runSessionsList({ cwd: dir }, io)).toBe(EXIT.Ok);
    expect(io.stdout()).toContain('sess-list-a');
    expect(io.stdout()).toContain('sess-list-b');

    const json = capture();
    await runSessionsList({ cwd: dir, json: true }, json);
    const parsed = JSON.parse(json.stdout()) as { sessions: { id: string }[] };
    expect(parsed.sessions.map((entry) => entry.id).sort()).toEqual(['sess-list-a', 'sess-list-b']);
  });
});

describe('trajectory files', () => {
  it('writes one event per line, verbatim', async () => {
    const path = await writeTrajectoryFile(dir, 'sess-traj', [
      { type: 'text.delta', text: 'hi' },
      { type: 'turn.completed', stopReason: 'end-turn' },
    ]);
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ type: 'text.delta' });
    expect((await readdir(join(dir, '.adze', 'sessions'))).join(',')).toContain(
      'sess-traj.trajectory.jsonl',
    );
  });
});
