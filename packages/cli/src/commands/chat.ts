/**
 * `adze chat` — an interactive session, in plain text.
 *
 * No TUI, deliberately (ADR-0001 §6.6). Plain output first keeps `adze` scriptable and
 * usable over SSH and in CI, and a TUI added on top later cannot take that away — whereas a
 * TUI added first usually does, because the rendering ends up load-bearing.
 *
 * ### One session, many turns, many processes
 *
 * The session is created once and each prompt is a turn against it, which is the whole point
 * of the mode: the conversation accumulates, and the frozen cache prefix stays byte-identical
 * across every turn that does not change the model, the sandbox, the approval policy, or the
 * tool set. A REPL that made a new session per prompt would look identical and would pay full
 * input rate on every message.
 *
 * History outlives the process: every turn is appended to
 * `.adze/sessions/<id>.jsonl` (line 0 a header, then one linear-history message per
 * line), so `adze chat --resume <id|--last>` continues where the last process left
 * off with the same cache prefix. This is CLI-side composition over the same
 * protocol methods — `session.create`, `turn.submit`, `session.close` — not a new
 * engine path (ADR-0001 rule 2). Resuming creates a fresh engine session and
 * appends the loaded messages; forking copies a turn prefix into a new engine
 * session; compacting calls the existing `Session.compact` seam and records the
 * named `EpochRollReason`.
 *
 * ### Slash commands answer what the stream cannot
 *
 * `/usage`, `/model`, `/clear`, `/compact`, `/fork`, `/init`, `/review-diff`,
 * `/plugins`, `/doctor`, `/help`, `/exit`. There is no `/config`, because a setting
 * changed mid-session that the prompt does not reflect is a security display that
 * disagrees with reality.
 *
 * Refs ADR-0001, ADR-0003, ADR-0007.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { addUsage, type ConversationMessage, type EpochRollReason, ZERO_USAGE } from '@adze/core';
import type { Usage } from '@adze/protocol';
import {
  type ApprovalChannel,
  denyingChannel,
  type LineReader,
  promptingChannel,
  stdinReader,
} from '../agent/approval.js';
import { renderFailure } from '../agent/failure.js';
import { type AgentFlags, parseAgentFlags } from '../agent/flags.js';
import { EventRenderer } from '../agent/render.js';
import { containmentLine, createCliSandbox, degradationLines } from '../agent/sandbox.js';
import { type AgentSetup, buildAgent } from '../agent/setup.js';
import { renderSummary } from '../agent/summary.js';
import { EXIT, type ExitCode, field, type Io, type Style, styleFor } from '../output.js';
import {
  buildCompactSummary,
  countTurns,
  loadSession,
  newPersistedId,
  type PersistedEpochRoll,
  resolveSessionRef,
  SESSION_FILE_VERSION,
  type SessionFileHeader,
  saveSession,
  sliceHistoryByTurns,
} from '../sessions/store.js';
import { CLI_VERSION } from '../version.js';
import type { TestHooks } from './run.js';

const execFileAsync = promisify(execFile);

export interface ChatOptions extends AgentFlags {
  readonly resume?: string;
  readonly last?: boolean;
  readonly __testHooks?: TestHooks;
}

const HELP = [
  '  /usage         tokens, cost, and cache hit rate for this session',
  '  /model         the model and its capabilities',
  '  /clear         start a new persisted session',
  '  /compact [note]  summarize history into one message (records a compaction roll)',
  '  /fork [turn]   branch history at a turn into a new persisted session',
  '  /init          scaffold .adze/config.jsonc and AGENTS.md when missing',
  '  /review-diff   read-only diff summary (no writes)',
  '  /plugins       installed plugins and the dev override',
  '  /doctor        environment and sandbox report',
  '  /help          this list',
  '  /exit          leave (Ctrl-D also works)',
].join('\n');

/** A parsed slash line: `/fork 2` becomes `{ name: 'fork', args: '2' }`. Exported for tests. */
export function parseSlashCommand(input: string): { readonly name: string; readonly args: string } {
  const body = input.slice(1).trim();
  const space = body.indexOf(' ');
  if (space === -1) return { name: body.toLowerCase(), args: '' };
  return { name: body.slice(0, space).toLowerCase(), args: body.slice(space + 1).trim() };
}

export async function runChat(options: ChatOptions, io: Io): Promise<ExitCode> {
  // `--json` is not offered here: a REPL's value is the interleaving, and a machine reading
  // a stream does not need a prompt. `adze run --json` is the scriptable form.
  const style = styleFor(false);

  let invocation: ReturnType<typeof parseAgentFlags>;
  try {
    invocation = parseAgentFlags({ ...options, json: false }, process.cwd());
  } catch (error) {
    return renderFailure(error, io, style).code;
  }

  const hooks = options.__testHooks;
  const reader: LineReader = hooks?.reader ?? stdinReader();
  // The real mechanism for this host, and the plan it will apply. Built before the
  // approval channel because the prompt has to say whether an approved command will be
  // confined, and only the plan knows that — see the same note in `run`.
  const containment =
    hooks?.containment ??
    (await createCliSandbox({
      mode: invocation.sandboxMode,
      writableRoots: [invocation.workspaceRoot],
      approvals: invocation.approvals,
      commandRules: invocation.commandRules,
    }));
  const enforcement = containment.plan.enforcement;
  const approvals =
    invocation.approvals === 'never'
      ? denyingChannel("the approval policy is 'never', which refuses rather than escalating")
      : promptingChannel({ io, style, reader, enforcement });

  let agent: AgentSetup;
  const renderer = new EventRenderer({ io, style, json: false, quiet: invocation.quiet });
  try {
    agent = buildAgent({
      workspaceRoot: invocation.workspaceRoot,
      modelRef: invocation.modelRef,
      effort: invocation.effort,
      temperature: invocation.temperature,
      maxOutputTokens: invocation.maxOutputTokens,
      sandboxMode: invocation.sandboxMode,
      approvals: invocation.approvals,
      commandRules: invocation.commandRules,
      instructions: invocation.instructions,
      sink: renderer.sink,
      approvalChannel: approvals,
      containment,
      ...(hooks?.languageModel === undefined ? {} : { languageModel: hooks.languageModel }),
      ...(hooks?.resolve === undefined ? {} : { resolve: hooks.resolve }),
    });
  } catch (error) {
    reader.close();
    approvals.close();
    return renderFailure(error, io, style).code;
  }

  renderBanner(agent, invocation, io, style);

  const dev = await readPluginDev(agent.workspaceRoot);
  if (dev !== undefined) {
    io.out(`${style.warn('plugin dev override')} ${dev.id} from ${dev.root}\n`);
    io.out(`${style.dim('live reload: shadowing the installed same id.')}\n\n`);
  }

  // Measured, not zero. `durationMs: 0` was hardcoded here, so every session reported
  // "wall clock 0.0s" no matter how long it ran — a reported metric that was never a
  // measurement. `run` already threads the clock this way, and the summary renderer is
  // shared, so the two commands now describe the same quantity.
  const startedAt = (hooks?.now ?? Date.now)();
  const now = hooks?.now ?? Date.now;

  const outcome = await repl({
    agent,
    invocation,
    reader,
    approvals,
    io,
    style,
    now,
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.last === undefined ? {} : { last: options.last }),
  });

  if (outcome.turns > 0) {
    renderSummary(
      {
        model: agent.model,
        stopReason: 'end-turn',
        steps: outcome.turns,
        usage: outcome.usage,
        prices: agent.gateway.priceFor(agent.model),
        durationMs: (hooks?.now ?? Date.now)() - startedAt,
        approvals: approvals.count(),
        droppedEvents: renderer.droppedEvents,
      },
      io,
      style,
    );
  }

  return outcome.code;
}

/**
 * The model, the settings in force, and any warnings — before the first prompt.
 *
 * Before, not after: a user about to approve a command needs to know there is no
 * containment first.
 */
function renderBanner(
  agent: AgentSetup,
  invocation: ReturnType<typeof parseAgentFlags>,
  io: Io,
  style: Style,
): void {
  const init = agent.engine.initialize({
    protocolVersions: ['0.1'],
    client: { name: 'adze-cli', version: CLI_VERSION, platform: process.platform },
  });

  io.out(
    `${style.bold('adze chat')} ${style.dim(`— ${agent.model.provider}/${agent.model.model}`)}\n`,
  );
  io.out(
    `${style.dim(`${invocation.sandboxMode} · approvals: ${invocation.approvals} · ${containmentLine(agent.containment)} · /help for commands`)}\n`,
  );
  // The complete list of what the plan will not enforce, for the same reason `run` prints
  // it: a trimmed list leaves the user believing in a boundary that is not there.
  for (const gap of degradationLines(agent.containment)) {
    io.out(`${style.warn('not enforced')} ${gap}\n`);
  }
  for (const warning of init.warnings) {
    io.out(`${style.warn(`warning [${warning.code}]`)} ${warning.message}\n`);
  }
  io.out('\n');
}

async function readPluginDev(
  workspaceRoot: string,
): Promise<{ readonly id: string; readonly root: string } | undefined> {
  try {
    const { readDevOverride } = await import('../plugins/store.js');
    return await readDevOverride(workspaceRoot);
  } catch {
    return undefined;
  }
}

interface ReplContext {
  readonly agent: AgentSetup;
  readonly invocation: ReturnType<typeof parseAgentFlags>;
  readonly reader: LineReader;
  readonly approvals: ApprovalChannel;
  readonly io: Io;
  readonly style: Style;
  readonly now: () => number;
  readonly resume?: string;
  readonly last?: boolean;
}

interface ReplOutcome {
  readonly turns: number;
  readonly usage: Usage;
  readonly code: ExitCode;
}

interface PersistedState {
  engineSessionId: string;
  persistedId: string;
  createdAt: string;
  epochRolls: PersistedEpochRoll[];
  usage: Usage;
  turns: number;
}

function headerFor(state: PersistedState, ctx: ReplContext, nowIso: string): SessionFileHeader {
  const { agent, invocation } = ctx;
  return {
    version: SESSION_FILE_VERSION,
    kind: 'session',
    id: state.persistedId,
    workspaceRoot: agent.workspaceRoot,
    model: agent.model,
    sandbox: agent.sandbox,
    approvals: agent.approvals,
    ...(invocation.instructions === undefined ? {} : { instructions: invocation.instructions }),
    createdAt: state.createdAt,
    updatedAt: nowIso,
    turns: state.turns,
    usage: state.usage,
    epochRolls: [...state.epochRolls],
  };
}

/**
 * Persist the engine session's linear history to `.adze/sessions/<persistedId>.jsonl`.
 *
 * A write failure warns rather than ending the chat: the conversation is still
 * alive in memory, and refusing the next prompt because the disk is full would
 * confuse a storage problem with a session problem.
 */
async function persistCurrent(ctx: ReplContext, state: PersistedState): Promise<void> {
  const { agent, io, style, now } = ctx;
  const session = await agent.engine.session(state.engineSessionId);
  if (session === undefined) return;
  const header = headerFor(state, ctx, new Date(now()).toISOString());
  try {
    await saveSession(agent.workspaceRoot, header, session.history);
  } catch (error) {
    io.err(
      `${style.warn('session not persisted:')} ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/**
 * Read, submit, render, repeat.
 *
 * Split out from {@link runChat} so neither function carries both the wiring and the loop.
 * They were one function and it tripped the complexity ceiling — a signal worth taking at
 * face value rather than suppressing, because the setup and the loop fail for unrelated
 * reasons and read better apart.
 */
async function repl(ctx: ReplContext): Promise<ReplOutcome> {
  const { agent, invocation, reader, approvals, io, style, now } = ctx;
  const engine = agent.engine;

  const state = await openPersistedSession(ctx);
  if (state === undefined) {
    return { turns: 0, usage: ZERO_USAGE, code: EXIT.Usage };
  }
  await persistCurrent(ctx, state);

  let code: ExitCode = EXIT.Ok;

  try {
    for (;;) {
      const line = await reader.read(`${style.info('›')} `);
      // End of input. Not an error: a piped script ending is the normal way a
      // non-interactive chat finishes.
      if (line === undefined) break;

      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      if (trimmed.startsWith('/')) {
        const done = await handleSlash(trimmed, {
          io,
          style,
          agent,
          invocation,
          now,
          state,
          reader,
          persist: () => persistCurrent(ctx, state),
          onClear: async () => {
            await engine.sessionClose({ sessionId: state.engineSessionId }).catch(() => undefined);
            const created = await engine.sessionCreate({
              workspaceRoot: agent.workspaceRoot,
              model: agent.model,
              sandbox: agent.sandbox,
              approvals: agent.approvals,
              ...(invocation.instructions === undefined
                ? {}
                : { instructions: invocation.instructions }),
            });
            state.engineSessionId = created.sessionId;
            state.persistedId = created.sessionId;
            state.createdAt = new Date(now()).toISOString();
            state.epochRolls = [];
            state.usage = ZERO_USAGE;
            state.turns = 0;
            await persistCurrent(ctx, state);
          },
        });
        if (done) break;
        continue;
      }

      try {
        const { turnId } = await engine.turnSubmit({
          sessionId: state.engineSessionId,
          prompt: trimmed,
          attachments: [],
          budget: invocation.budget,
        });
        const outcome = await engine.awaitTurn(turnId);
        state.usage = addUsage(state.usage, outcome.usage);
        state.turns += 1;
        await persistCurrent(ctx, state);
        io.out('\n');
      } catch (error) {
        // A failed turn does not end the session. The user may have a bad model id, or the
        // provider may be down for a minute; making them restart and lose the conversation
        // would be a worse answer than reporting it and taking the next prompt.
        code = renderFailure(error, io, style).code;
        io.out('\n');
      }
    }
  } finally {
    await engine.sessionClose({ sessionId: state.engineSessionId }).catch(() => undefined);
    approvals.close();
    reader.close();
  }

  return { turns: state.turns, usage: state.usage, code };
}

function createSession(ctx: ReplContext): Promise<{ sessionId: string }> {
  const { agent, invocation } = ctx;
  return agent.engine.sessionCreate({
    workspaceRoot: agent.workspaceRoot,
    model: agent.model,
    sandbox: agent.sandbox,
    approvals: agent.approvals,
    ...(invocation.instructions === undefined ? {} : { instructions: invocation.instructions }),
  });
}

/**
 * Open or resume the persisted session.
 *
 * New chat: create an engine session and persist under its id, so the first save
 * needs no rename. Resume: resolve `--resume <id|last>` (or `--last`), load the
 * file, create a fresh engine session from the current settings, and append the
 * loaded history — the same protocol methods, no new engine path. The persisted
 * id stays stable across resumes; the engine id is ephemeral per process.
 */
async function openPersistedSession(ctx: ReplContext): Promise<PersistedState | undefined> {
  const { agent, io, style, now, resume, last } = ctx;
  const ref = resume ?? (last === true ? 'last' : undefined);
  if (ref === undefined) {
    const created = await createSession(ctx);
    const createdAt = new Date(now()).toISOString();
    io.out(
      `${style.dim(`session ${created.sessionId} · persisted to .adze/sessions/${created.sessionId}.jsonl`)}\n`,
    );
    return {
      engineSessionId: created.sessionId,
      persistedId: created.sessionId,
      createdAt,
      epochRolls: [],
      usage: ZERO_USAGE,
      turns: 0,
    };
  }

  let persistedId: string;
  try {
    persistedId = await resolveSessionRef(agent.workspaceRoot, ref);
  } catch (error) {
    renderFailure(error, io, style);
    return undefined;
  }
  let loaded: Awaited<ReturnType<typeof loadSession>>;
  try {
    loaded = await loadSession(agent.workspaceRoot, persistedId);
  } catch (error) {
    renderFailure(error, io, style);
    return undefined;
  }
  const created = await createSession(ctx);
  const session = await agent.engine.session(created.sessionId);
  if (session !== undefined && loaded.messages.length > 0) {
    session.append(...loaded.messages);
    session.turns = loaded.header.turns;
    session.recordUsage(loaded.header.usage);
  }
  io.out(
    `${style.dim(`resumed session ${persistedId} · ${loaded.messages.length} message(s), ${loaded.header.turns} turn(s) · engine session ${created.sessionId}`)}\n`,
  );
  return {
    engineSessionId: created.sessionId,
    persistedId,
    createdAt: loaded.header.createdAt,
    epochRolls: [...loaded.header.epochRolls],
    usage: loaded.header.usage,
    turns: loaded.header.turns,
  };
}

interface SlashContext {
  readonly io: Io;
  readonly style: Style;
  readonly agent: AgentSetup;
  readonly invocation: ReturnType<typeof parseAgentFlags>;
  readonly now: () => number;
  readonly state: PersistedState;
  readonly reader: LineReader;
  readonly persist: () => Promise<void>;
  readonly onClear: () => Promise<void>;
}

/** Returns true when the session should end. */
async function handleSlash(input: string, ctx: SlashContext): Promise<boolean> {
  const { io, style, agent } = ctx;
  const { name: command, args } = parseSlashCommand(input);

  switch (command) {
    case 'exit':
    case 'quit':
      return true;

    case 'help':
      io.out(`${HELP}\n`);
      return false;

    case 'model': {
      const capabilities = agent.gateway.capabilitiesFor(agent.model);
      io.out(`${field('model', `${capabilities.provider}/${capabilities.model}`)}\n`);
      io.out(`${field('native tool calling', String(capabilities.nativeToolCalling))}\n`);
      io.out(`${field('vision', String(capabilities.vision))}\n`);
      io.out(
        `${field('context window', capabilities.contextWindow?.toLocaleString('en-US') ?? 'unknown')}\n`,
      );
      io.out(`${field('cost', capabilities.costUnknown ? style.warn('unknown') : 'priced')}\n`);
      if (capabilities.degraded) {
        io.out(
          `\n  ${style.warn('degraded:')} no native tool calling, so turns run without tools.\n`,
        );
      }
      return false;
    }

    case 'usage':
      renderSummary(
        {
          model: agent.model,
          stopReason: 'end-turn',
          steps: ctx.state.turns,
          usage: ctx.state.usage,
          prices: agent.gateway.priceFor(agent.model),
          durationMs: 0,
          approvals: 0,
          droppedEvents: 0,
        },
        io,
        style,
      );
      return false;

    case 'clear':
      await ctx.onClear();
      io.out(
        `${style.dim(`new session ${ctx.state.persistedId}; the conversation was discarded.`)}${'\n'}`,
      );
      return false;

    case 'compact':
      await handleCompact(args, ctx);
      return false;

    case 'fork':
      await handleFork(args, ctx);
      return false;

    case 'init':
      await handleInit(ctx);
      return false;

    case 'review-diff':
      await handleReviewDiff(ctx);
      return false;

    case 'plugins':
      await handlePlugins(ctx);
      return false;

    case 'doctor':
      await handleDoctor(ctx);
      return false;

    default:
      io.out(`${style.bad(`unknown command '/${command}'`)}\n${HELP}\n`);
      return false;
  }
}

/**
 * Summarize history into one message via the existing `Session.compact` seam.
 *
 * Thin CLI-side composition, documented as such: the engine exposes no
 * `session.compact` protocol method, so this calls `Session.compact` on the
 * live session object and records the named `EpochRollReason` (`compaction`)
 * in the persisted header. The engine's assembler reconciles structural inputs
 * on the next turn; the recorded reason is what makes the roll attributable in
 * the persisted file. An explicit `/compact <note>` becomes the summary's first
 * line, so an operator's framing survives rather than being paraphrased away.
 */
async function handleCompact(args: string, ctx: SlashContext): Promise<void> {
  const { io, style, agent, now } = ctx;
  const session = await agent.engine.session(ctx.state.engineSessionId);
  if (session === undefined) {
    io.out(`${style.bad('no live session to compact.')}\n`);
    return;
  }
  if (session.history.length === 0) {
    io.out(`${style.dim('nothing to compact: the history is empty.')}\n`);
    return;
  }
  const turns = countTurns(session.history);
  const generated = buildCompactSummary(session.history, turns);
  const summary = args.length > 0 ? `${args}\n\n${generated}` : generated;
  session.compact(summary);
  const reason: EpochRollReason = 'compaction';
  const roll: PersistedEpochRoll = {
    reason,
    at: new Date(now()).toISOString(),
    turns: ctx.state.turns,
  };
  ctx.state.epochRolls = [...ctx.state.epochRolls, roll];
  await ctx.persist();
  io.out(
    `${style.dim(`compacted ${turns} turn(s) into one summary message (epoch roll: ${reason}).`)}\n`,
  );
}

/**
 * Branch history at a turn into a new persisted session.
 *
 * Thin CLI-side composition: there is no `session.fork` engine seam, so this
 * creates a fresh engine session and appends the prefix through the end of the
 * requested turn. `/fork` with no argument duplicates the session at its tip;
 * `/fork N` keeps the first N turns (1-based). The old session's file is left
 * alone — a branch that deleted its parent would be a surprising destructive
 * default.
 */
async function handleFork(args: string, ctx: SlashContext): Promise<void> {
  const { io, style, agent } = ctx;
  const live = await agent.engine.session(ctx.state.engineSessionId);
  if (live === undefined) {
    io.out(`${style.bad('no live session to fork.')}\n`);
    return;
  }
  const history: readonly ConversationMessage[] = [...live.history];
  if (history.length === 0) {
    io.out(`${style.dim('nothing to fork: the history is empty.')}\n`);
    return;
  }
  const totalTurns = countTurns(history);
  let wanted = totalTurns;
  if (args.length > 0) {
    const parsed = Number(args.split(/\s+/)[0]);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      io.out(`${style.bad(`cannot fork at '${args}': give a 1-based turn number.`)}${'\n'}`);
      return;
    }
    wanted = parsed;
  }
  const prefix = sliceHistoryByTurns(history, wanted);
  const created = await agent.engine.sessionCreate({
    workspaceRoot: agent.workspaceRoot,
    model: agent.model,
    sandbox: agent.sandbox,
    approvals: agent.approvals,
    ...(ctx.invocation.instructions === undefined
      ? {}
      : { instructions: ctx.invocation.instructions }),
  });
  const next = await agent.engine.session(created.sessionId);
  if (next !== undefined && prefix.length > 0) {
    next.append(...prefix);
    next.turns = Math.min(wanted, totalTurns);
    next.recordUsage(ctx.state.usage);
  }
  await agent.engine.sessionClose({ sessionId: ctx.state.engineSessionId }).catch(() => undefined);
  ctx.state.engineSessionId = created.sessionId;
  ctx.state.persistedId = created.sessionId;
  ctx.state.createdAt = new Date(ctx.now()).toISOString();
  ctx.state.epochRolls = [];
  ctx.state.turns = Math.min(wanted, totalTurns);
  await ctx.persist();
  io.out(
    `${style.dim(`forked at turn ${Math.min(wanted, totalTurns)}/${totalTurns} into session ${created.sessionId}.`)}\n`,
  );
}

/** Scaffold `.adze/config.jsonc` and `AGENTS.md` when missing. Never overwrites, never writes secrets. */
async function handleInit(ctx: SlashContext): Promise<void> {
  const { io, style, agent } = ctx;
  const created: string[] = [];
  const kept: string[] = [];

  const configPath = join(agent.workspaceRoot, '.adze', 'config.jsonc');
  const configTemplate = [
    '{',
    '  // Adze workspace config (JSONC: comments allowed). Provider credentials live',
    '  // in .adze/providers.json or the environment — never here.',
    '  // See docs/guides/configuration.md.',
    '  "$schema": "../node_modules/@adze/cli/config.schema.json",',
    '  "defaultModel": null',
    '}',
    '',
  ].join('\n');
  if (await writeWhenMissing(configPath, configTemplate)) created.push('.adze/config.jsonc');
  else kept.push('.adze/config.jsonc');

  const agentsPath = join(agent.workspaceRoot, 'AGENTS.md');
  const agentsTemplate = [
    '# Agent instructions',
    '',
    'Project instructions for Adze sessions. Keep this short and factual:',
    'how to build, how to test, and anything the agent must never do.',
    '',
    '## Build',
    '',
    '- `pnpm install`',
    '- `pnpm check` (lint + typecheck + test)',
    '',
    '## Notes',
    '',
    '- Be specific here: commands that work in this repo, not general advice.',
    '',
  ].join('\n');
  if (await writeWhenMissing(agentsPath, agentsTemplate)) created.push('AGENTS.md');
  else kept.push('AGENTS.md');

  for (const path of created) io.out(`${style.good('created')} ${path}\n`);
  for (const path of kept)
    io.out(`${style.dim('kept')} ${path} (already exists; not overwritten)\n`);
}

async function writeWhenMissing(path: string, content: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8');
    return false;
  } catch {
    // Missing — fall through to creation.
  }
  await mkdir(join(path, '..'), { recursive: true }).catch(() => undefined);
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read-only diff summary. No writes, no tool calls, no model round-trip.
 *
 * Uses `git` read-only (`diff --stat`, `status --short`) so there is nothing
 * the permission gate needs to authorize — and nothing it could miss. A
 * model-assisted review is a normal prompt away; this command answers "what
 * changed" without spending a turn or risking a write.
 */
async function handleReviewDiff(ctx: SlashContext): Promise<void> {
  const { io, style, agent } = ctx;
  io.out(`${style.bold('Diff review (read-only)')}\n`);
  const runGit = async (args: readonly string[]): Promise<string | undefined> => {
    try {
      const { stdout } = await execFileAsync('git', [...args], {
        cwd: agent.workspaceRoot,
        timeout: 10_000,
      });
      return stdout.trim();
    } catch {
      return undefined;
    }
  };
  const stat = await runGit(['diff', '--stat']);
  const staged = await runGit(['diff', '--cached', '--stat']);
  const status = await runGit(['status', '--short']);
  if (stat === undefined && staged === undefined && status === undefined) {
    io.out(`${style.warn('not a git repository, or git is unavailable.')} No diff to review.\n`);
    return;
  }
  if (status !== undefined && status.length > 0) {
    io.out(`\n${style.dim('status')}\n${status}\n`);
  }
  if (staged !== undefined && staged.length > 0) {
    io.out(`\n${style.dim('staged')}\n${staged}\n`);
  }
  if (stat !== undefined && stat.length > 0) {
    io.out(`\n${style.dim('unstaged')}\n${stat}\n`);
  }
  if ((stat === undefined || stat.length === 0) && (staged === undefined || staged.length === 0)) {
    io.out(`${style.dim('No changes. Working tree is clean.')}\n`);
  } else {
    io.out(
      `\n${style.dim('Ask for a review as a prompt (e.g. "review the diff") to run it through read/grep/symbols with no writes.')}\n`,
    );
  }
}

async function handlePlugins(ctx: SlashContext): Promise<void> {
  const { io, style, agent } = ctx;
  try {
    const { readDevOverride, readInstalled } = await import('../plugins/store.js');
    const installed = await readInstalled(agent.workspaceRoot);
    const dev = await readDevOverride(agent.workspaceRoot);
    if (installed.length === 0 && dev === undefined) {
      io.out(
        `${style.dim('none installed. `adze plugin add <local-path|git-url>` installs one locally.')}\n`,
      );
      return;
    }
    for (const entry of installed) {
      const shadowed = dev !== undefined && dev.id === entry.id;
      io.out(
        `  ${style.good('installed')} ${entry.id}${shadowed ? ` ${style.warn('(shadowed by dev)')}` : ''}\n`,
      );
      io.out(`               ${style.dim(entry.root)}\n`);
    }
    if (dev !== undefined) {
      io.out(`  ${style.warn('dev override')} ${dev.id} from ${dev.root}\n`);
    }
  } catch {
    io.out(`${style.warn('plugin state unreadable.')}\n`);
  }
}

async function handleDoctor(ctx: SlashContext): Promise<void> {
  const { io, agent } = ctx;
  const { runDoctor } = await import('./doctor.js');
  await runDoctor({ __testHooks: { cwd: agent.workspaceRoot } }, io);
}

export function __testOnlyNewPersistedId(): string {
  return newPersistedId();
}
