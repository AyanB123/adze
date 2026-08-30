/**
 * `adze chat` — an interactive session, in plain text.
 *
 * No TUI, deliberately (ADR-0001 §6.6). Plain output first keeps `adze` scriptable and
 * usable over SSH and in CI, and a TUI added on top later cannot take that away — whereas a
 * TUI added first usually does, because the rendering ends up load-bearing.
 *
 * ### One session, many turns
 *
 * The session is created once and each prompt is a turn against it, which is the whole point
 * of the mode: the conversation accumulates, and the frozen cache prefix stays byte-identical
 * across every turn that does not change the model, the sandbox, the approval policy, or the
 * tool set. A REPL that made a new session per prompt would look identical and would pay full
 * input rate on every message.
 *
 * ### Slash commands are few on purpose
 *
 * `/usage`, `/model`, `/clear`, `/help`, `/exit`. Each is a question the plain stream cannot
 * answer. There is no `/config`, because a setting changed mid-session that the prompt does
 * not reflect is a security display that disagrees with reality.
 */

import { addUsage, ZERO_USAGE } from '@adze/core';
import type { Usage } from '@adze/protocol';
import { sandboxEnforcement } from '@adze/protocol';
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
import { type AgentSetup, buildAgent } from '../agent/setup.js';
import { renderSummary } from '../agent/summary.js';
import { EXIT, type ExitCode, field, type Io, type Style, styleFor } from '../output.js';
import { CLI_VERSION } from '../version.js';
import type { TestHooks } from './run.js';

export interface ChatOptions extends AgentFlags {
  readonly __testHooks?: TestHooks;
}

const HELP = [
  '  /usage    tokens, cost, and cache hit rate for this session',
  '  /model    the model and its capabilities',
  '  /clear    start a new session, discarding the conversation',
  '  /help     this list',
  '  /exit     leave (Ctrl-D also works)',
].join('\n');

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
  const enforcement = sandboxEnforcement(process.platform, invocation.sandboxMode);
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
      ...(hooks?.broker === undefined ? {} : { broker: hooks.broker }),
      ...(hooks?.languageModel === undefined ? {} : { languageModel: hooks.languageModel }),
      ...(hooks?.resolve === undefined ? {} : { resolve: hooks.resolve }),
    });
  } catch (error) {
    reader.close();
    approvals.close();
    return renderFailure(error, io, style).code;
  }

  renderBanner(agent, invocation, io, style);

  // Measured, not zero. `durationMs: 0` was hardcoded here, so every session reported
  // "wall clock 0.0s" no matter how long it ran — a reported metric that was never a
  // measurement. `run` already threads the clock this way, and the summary renderer is
  // shared, so the two commands now describe the same quantity.
  const startedAt = (hooks?.now ?? Date.now)();

  const outcome = await repl({ agent, invocation, reader, approvals, io, style });

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
    `${style.dim(`${invocation.sandboxMode} · approvals: ${invocation.approvals} · /help for commands`)}\n`,
  );
  for (const warning of init.warnings) {
    io.out(`${style.warn(`warning [${warning.code}]`)} ${warning.message}\n`);
  }
  io.out('\n');
}

interface ReplContext {
  readonly agent: AgentSetup;
  readonly invocation: ReturnType<typeof parseAgentFlags>;
  readonly reader: LineReader;
  readonly approvals: ApprovalChannel;
  readonly io: Io;
  readonly style: Style;
}

interface ReplOutcome {
  readonly turns: number;
  readonly usage: Usage;
  readonly code: ExitCode;
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
  const { agent, invocation, reader, approvals, io, style } = ctx;
  const engine = agent.engine;

  let sessionId = (await createSession(ctx)).sessionId;
  let sessionUsage: Usage = ZERO_USAGE;
  let turns = 0;
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
          sessionUsage,
          turns,
          onClear: async () => {
            await engine.sessionClose({ sessionId });
            sessionId = (await createSession(ctx)).sessionId;
            sessionUsage = ZERO_USAGE;
            turns = 0;
          },
        });
        if (done) break;
        continue;
      }

      try {
        const { turnId } = await engine.turnSubmit({
          sessionId,
          prompt: trimmed,
          attachments: [],
          budget: invocation.budget,
        });
        const outcome = await engine.awaitTurn(turnId);
        sessionUsage = addUsage(sessionUsage, outcome.usage);
        turns += 1;
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
    await engine.sessionClose({ sessionId }).catch(() => undefined);
    approvals.close();
    reader.close();
  }

  return { turns, usage: sessionUsage, code };
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

interface SlashContext {
  readonly io: Io;
  readonly style: Style;
  readonly agent: AgentSetup;
  readonly sessionUsage: Usage;
  readonly turns: number;
  readonly onClear: () => Promise<void>;
}

/** Returns true when the session should end. */
async function handleSlash(input: string, ctx: SlashContext): Promise<boolean> {
  const { io, style, agent } = ctx;
  const command = input.slice(1).split(/\s+/)[0]?.toLowerCase() ?? '';

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
          steps: ctx.turns,
          usage: ctx.sessionUsage,
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
      io.out(`${style.dim('new session; the conversation was discarded.')}\n`);
      return false;

    default:
      io.out(`${style.bad(`unknown command '/${command}'`)}\n${HELP}\n`);
      return false;
  }
}
