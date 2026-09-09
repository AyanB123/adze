/**
 * `adze sessions list` — what persisted sessions exist.
 *
 * Read-only over `.adze/sessions/*.jsonl` (never `*.trajectory.jsonl`). A
 * session is forgotten by deleting its file, which is the whole deletion story
 * local-first promises: no registry, no server, no extra step.
 *
 * Refs ADR-0001, ADR-0003.
 */

import { EXIT, type ExitCode, field, type Io, type Style, styleFor, writeJson } from '../output.js';
import { listSessions } from '../sessions/store.js';

export interface SessionsListOptions {
  readonly json?: boolean;
  readonly cwd?: string;
  readonly __testHooks?: { readonly cwd?: string };
}

export async function runSessionsList(options: SessionsListOptions, io: Io): Promise<ExitCode> {
  const json = options.json === true;
  const style: Style = styleFor(json);
  const workspaceRoot = options.__testHooks?.cwd ?? options.cwd ?? process.cwd();
  const entries = await listSessions(workspaceRoot);

  if (json) {
    writeJson(io, {
      sessions: entries.map((entry) => ({
        id: entry.id,
        model: entry.model,
        turns: entry.turns,
        messages: entry.messages,
        updatedAt: entry.updatedAt,
      })),
    });
    return EXIT.Ok;
  }

  if (entries.length === 0) {
    io.out(
      `${style.dim('No persisted sessions in .adze/sessions/. Start one with `adze chat`.')}\n`,
    );
    return EXIT.Ok;
  }

  io.out(`${style.bold('Sessions')}\n`);
  for (const entry of entries) {
    io.out(
      `  ${entry.id}  ${style.dim(`${entry.model} · ${entry.turns} turn(s) · ${entry.messages} message(s) · ${entry.updatedAt}`)}\n`,
    );
  }
  io.out(`\n${field('resume', 'adze chat --resume <id>  (or --resume last)')}\n`);
  return EXIT.Ok;
}
