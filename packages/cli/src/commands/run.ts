/**
 * `adze run` — one task, start to finish, non-interactive.
 *
 * The command that has to work for the project to have a product. Everything else is a
 * different way to reach this loop.
 *
 * ### The exit code is the interface
 *
 * `0` only when the turn reached `end-turn`. A budget ceiling, a refusal, a cancellation,
 * and a provider error are all `1`, because a script that treats "the agent ran out of
 * steps" as success will commit whatever half-finished state that produced. A bad flag or a
 * missing API key is `2`, so a script can tell "fix your setup" from "the agent could not
 * finish".
 *
 * ### A refusal is not a crash
 *
 * `stopReason: 'refused'` means the permission gate did its job and the run stopped. It
 * exits non-zero because the task was not completed, and it says `refused` rather than
 * `error` — collapsing the two would make a working safety mechanism indistinguishable from
 * a bug in every metric computed from these runs.
 */

import type { Warning } from '@adze/protocol';
import { denyingChannel, promptingChannel, stdinReader } from '../agent/approval.js';
import { renderFailure } from '../agent/failure.js';
import { type AgentFlags, parseAgentFlags } from '../agent/flags.js';
import { EventRenderer } from '../agent/render.js';
import {
  type CliSandbox,
  containmentLine,
  createCliSandbox,
  degradationLines,
} from '../agent/sandbox.js';
import { type AgentSetup, buildAgent } from '../agent/setup.js';
import { type RunSummary, renderSummary, summaryJson } from '../agent/summary.js';
import { EXIT, type ExitCode, type Io, type Style, styleFor, writeJsonLine } from '../output.js';

export interface RunOptions extends AgentFlags {
  /** Test seam: a scripted approval channel and a mock model, so no key is needed. */
  readonly __testHooks?: TestHooks;
}

/**
 * Injection points for tests.
 *
 * Named so it is obvious in a stack that a test is driving. The alternative — a module-level
 * mutable singleton the tests reach into — makes two tests running in the same process able
 * to see each other's configuration.
 */
export interface TestHooks {
  readonly languageModel?: Parameters<typeof buildAgent>[0]['languageModel'];
  /**
   * A pre-built sandbox, so a test can supply a broker that runs nothing.
   *
   * Replaces a `broker` hook that no test ever used, which is how the real broker went
   * unnoticed for so long. Omitting this selects the real mechanism for the host, which
   * is what a user gets — so a test that omits it is testing the shipped path.
   */
  readonly containment?: CliSandbox;
  /** Isolates provider resolution from the real environment. See {@link buildAgent}. */
  readonly resolve?: Parameters<typeof buildAgent>[0]['resolve'];
  readonly reader?: Parameters<typeof promptingChannel>[0]['reader'];
  readonly now?: () => number;
}

export async function runRun(
  prompt: string | undefined,
  options: RunOptions,
  io: Io,
): Promise<ExitCode> {
  const style = styleFor(options.json === true);

  if (prompt === undefined || prompt.trim().length === 0) {
    io.err(
      `${style.bad('adze run:')} needs a prompt.\n\n` +
        '  adze run "fix the failing test in packages/apply"\n\n' +
        `  ${style.dim('For an interactive session, use `adze chat`.')}\n`,
    );
    return EXIT.Usage;
  }

  let invocation: ReturnType<typeof parseAgentFlags>;
  try {
    invocation = parseAgentFlags(options, process.cwd());
  } catch (error) {
    return renderFailure(error, io, style).code;
  }

  const hooks = options.__testHooks;
  const renderer = new EventRenderer({ io, style, json: invocation.json, quiet: invocation.quiet });

  // Before the approval channel, because the prompt has to tell the user whether an
  // approved command will be confined, and only the plan knows. Deriving that from
  // `sandboxEnforcement(process.platform, mode)` — which is what this did — answers a
  // question about the *platform*: it says `os-level` on a macOS host whose `PATH` has no
  // `sandbox-exec`, so the prompt promised a boundary that was not there.
  const containment =
    hooks?.containment ??
    (await createCliSandbox({
      mode: invocation.sandboxMode,
      // Matches what core's gate passes to `exec`: `SandboxConfig.writableRoots` is empty
      // here, and the gate resolves empty to the workspace root.
      writableRoots: [invocation.workspaceRoot],
      approvals: invocation.approvals,
      commandRules: invocation.commandRules,
    }));
  const enforcement = containment.plan.enforcement;

  // ADR-0007: `never` refuses rather than escalating. The gate already never calls the
  // channel under that policy; handing it a denying one means even a gate bug cannot
  // produce a grant here.
  const approvals =
    invocation.approvals === 'never'
      ? denyingChannel("the approval policy is 'never', which refuses rather than escalating")
      : promptingChannel({
          io,
          style,
          reader: hooks?.reader ?? stdinReader(),
          enforcement,
        });

  const startedAt = (hooks?.now ?? Date.now)();

  try {
    const agent = buildAgent({
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

    const init = agent.engine.initialize({
      protocolVersions: ['0.1'],
      client: { name: 'adze-cli', version: '0.0.1', platform: process.platform },
    });

    const dev = await readPluginDev(agent.workspaceRoot);
    if (!invocation.json) {
      renderPreamble(agent, invocation, init.warnings, io, style, dev);
    }

    const { sessionId } = await agent.engine.sessionCreate({
      workspaceRoot: agent.workspaceRoot,
      model: agent.model,
      sandbox: agent.sandbox,
      approvals: agent.approvals,
      ...(invocation.instructions === undefined ? {} : { instructions: invocation.instructions }),
    });

    // Ctrl-C cancels the turn rather than killing the process, so the engine can append the
    // synthetic tool results that keep the history linear and the trajectory replayable.
    const cancellation = installCancelHandler();

    const { turnId } = await agent.engine.turnSubmit({
      sessionId,
      prompt,
      attachments: [],
      budget: invocation.budget,
    });

    cancellation.arm(() => {
      io.err(`\n${style.warn('cancelling…')} ${style.dim('press Ctrl-C again to exit now')}\n`);
      agent.engine.turnCancel({ sessionId, turnId });
    });

    const outcome = await agent.engine.awaitTurn(turnId);
    cancellation.dispose();

    const summary: RunSummary = {
      model: agent.model,
      stopReason: outcome.stopReason,
      steps: outcome.steps,
      usage: outcome.usage,
      prices: agent.gateway.priceFor(agent.model),
      durationMs: (hooks?.now ?? Date.now)() - startedAt,
      approvals: approvals.count(),
      droppedEvents: renderer.droppedEvents,
    };

    // One line, not indented: this goes onto the same stdout stream the renderer has been
    // writing one event per line to, and a consumer parses it line by line.
    if (invocation.json) {
      writeJsonLine(io, {
        ...summaryJson(summary),
        ...(dev === undefined ? {} : { plugins: { dev } }),
      });
    } else renderSummary(summary, io, style);

    await agent.engine.sessionClose({ sessionId });
    return outcome.stopReason === 'end-turn' ? EXIT.Ok : EXIT.Failure;
  } catch (error) {
    // Every failure renders through one path. A `ProviderConfigurationError` raised inside
    // the turn — the credential check on the first request — is the same problem to the user
    // as one raised at setup, and `renderFailure` already distinguishes a configuration
    // error (exit 2) from a request failure (exit 1) by type.
    return renderFailure(error, io, style).code;
  } finally {
    approvals.close();
  }
}

/**
 * The model, the settings in force, and everything that will not be enforced.
 *
 * Written to stderr before the turn, not after. A user who is about to approve a command
 * needs to know whether anything will confine it *first*.
 *
 * Every degradation is printed — not a count and not a summary. `plan.degradations` is
 * the plan's own answer to "what did I ask for that I am not getting", and a surface that
 * trimmed it for brevity would leave the user believing in a boundary that is not there.
 * On Windows that is five lines, which is proportionate to being the platform with no
 * containment at all.
 */
function renderPreamble(
  agent: AgentSetup,
  invocation: ReturnType<typeof parseAgentFlags>,
  warnings: readonly Warning[],
  io: Io,
  style: Style,
  dev: { readonly id: string; readonly root: string } | undefined,
): void {
  io.err(
    `${style.dim(`${agent.model.provider}/${agent.model.model} · ${invocation.sandboxMode} · approvals: ${invocation.approvals} · ${containmentLine(agent.containment)}`)}\n`,
  );
  if (dev !== undefined) {
    io.err(
      `${style.warn('plugin dev override')} ${dev.id} from ${dev.root} ${style.dim('(live reload, shadows installed)')}\n`,
    );
  }
  for (const gap of degradationLines(agent.containment)) {
    io.err(`${style.warn('not enforced')} ${gap}\n`);
  }
  for (const warning of warnings) {
    io.err(`${style.warn(`warning [${warning.code}]`)} ${warning.message}\n`);
  }
  io.err('\n');
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

interface CancelHandle {
  arm(cancel: () => void): void;
  dispose(): void;
}

/**
 * Cancel the turn on the first Ctrl-C, exit on the second.
 *
 * The first press asks the engine to stop, which lets it complete the history rather than
 * leaving an assistant message with unanswered tool calls — a shape most providers reject
 * and one that cannot be replayed. The second press is the escape hatch for a run that will
 * not stop, and it has to exist: a cancel that can itself hang is not a cancel.
 */
function installCancelHandler(): CancelHandle {
  let cancel: (() => void) | undefined;
  let pressed = 0;

  const handler = (): void => {
    pressed += 1;
    if (pressed === 1) {
      cancel?.();
      return;
    }
    // 130 is the conventional code for a SIGINT-terminated process.
    process.exit(130);
  };

  process.on('SIGINT', handler);

  return {
    arm(fn) {
      cancel = fn;
    },
    dispose() {
      process.off('SIGINT', handler);
    },
  };
}
