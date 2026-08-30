/**
 * Surface 3 — slash commands.
 *
 * A markdown file: YAML front matter, then a prompt template. Two substitutions
 * make it more than a snippet — `` !`cmd` `` inlines a command's output, and
 * `@name` pulls in a context provider.
 *
 * ## Interpolation is one left-to-right pass, and that is a security property
 *
 * Substituted text is **never rescanned**. A naive implementation replaces every
 * `` !`...` `` and then every `@name`, which means the *output* of a command becomes
 * a place to write `@` references — so a repository whose `git diff` contains
 * `@secrets` would pull in a provider the command author never wrote. One pass over
 * the original template, appending resolved text to an output buffer, removes that
 * class of problem rather than filtering for it.
 *
 * ## A missing command runner fails the command
 *
 * `!` is gate-checked "like any tool call", which this package achieves by not
 * running commands at all: {@link CommandRunner} is injected, and a surface wires it
 * to `dispatchToolCall` so the permission gate is in the path by construction. When
 * no runner is supplied, the command is **refused** rather than expanded with the
 * `!` block dropped. Dropping it would hand the model a prompt that says "review
 * this diff" followed by nothing, and the model would review nothing and report that
 * it found no problems.
 *
 * ## Where the spec is thin
 *
 * The spec shows a command file and says `!` and `@` work, and does not say what a
 * failing command does, whether `@unknown` is an error, or whether `tools` is
 * mandatory. The answers here: a failing command inlines its stderr and marks the
 * block failed, because a command that fails is information the model can use; an
 * unknown `@name` is left as literal text, because `@` is ordinary prose punctuation
 * and treating every `@` as a provider reference would break any prompt that
 * mentions an email address or a git ref; and `tools` is optional, meaning the
 * command inherits the session's allowlist unchanged.
 */

import { parseFrontmatter, readMapping, readString, readStringList } from './frontmatter.js';
import { errorDiagnostic, type PluginDiagnostic, warningDiagnostic } from './manifest.js';
import { describeFindings, scanForHiddenCharacters } from './unicode.js';

export interface SlashCommand {
  readonly pluginId: string;
  /** Invoked as `/name`. */
  readonly name: string;
  readonly description: string;
  /**
   * Tool allowlist. Empty means "inherit the session's".
   *
   * Narrower than the session's, never wider — enforced when the command runs, by
   * the same narrowing that governs subagents. See `agents.ts`.
   */
  readonly tools: readonly string[];
  readonly modelPreference: string | undefined;
  /** The prompt, before interpolation. */
  readonly template: string;
  /** Manifest-relative source, for diagnostics that point at a file. */
  readonly source: string;
}

export type CommandParseOutcome =
  | {
      readonly ok: true;
      readonly command: SlashCommand;
      readonly warnings: readonly PluginDiagnostic[];
    }
  | { readonly ok: false; readonly diagnostics: readonly PluginDiagnostic[] };

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Parse a command file.
 *
 * Hidden-character scanning runs on the whole file before parsing, for the reason
 * `manifest.ts` gives: a bidi override inside a prompt template is valid markdown,
 * and the prompt a reviewer reads would differ from the one the model receives.
 * A prompt template is arguably the *worst* place to allow it, since the text is
 * instructions.
 */
export function parseSlashCommand(
  pluginId: string,
  source: string,
  text: string,
): CommandParseOutcome {
  const scan = scanForHiddenCharacters(text);
  if (!scan.ok) {
    return {
      ok: false,
      diagnostics: [errorDiagnostic('hidden-characters', describeFindings(source, scan.findings))],
    };
  }

  const parsed = parseFrontmatter(text, source);
  if (!parsed.ok) {
    return { ok: false, diagnostics: [errorDiagnostic('frontmatter-invalid', parsed.message)] };
  }

  const data = parsed.document.data;
  const diagnostics: PluginDiagnostic[] = [];
  const warnings: PluginDiagnostic[] = [];

  const name = readString(data, 'name');
  if (!name.ok) {
    diagnostics.push(errorDiagnostic('frontmatter-invalid', `${source}: ${name.message}`));
  } else if (!NAME_PATTERN.test(name.value)) {
    diagnostics.push(
      errorDiagnostic(
        'frontmatter-invalid',
        `${source}: '${name.value}' is not a usable command name. Use lowercase letters, ` +
          `digits, and hyphens: it is typed after a slash.`,
      ),
    );
  }

  const description = readString(data, 'description');
  if (!description.ok) {
    diagnostics.push(errorDiagnostic('frontmatter-invalid', `${source}: ${description.message}`));
  }

  const tools = readStringList(data, 'tools');
  if (!tools.ok) {
    diagnostics.push(errorDiagnostic('frontmatter-invalid', `${source}: ${tools.message}`));
  }

  const model = readMapping(data, 'model');
  if (!model.ok) {
    diagnostics.push(errorDiagnostic('frontmatter-invalid', `${source}: ${model.message}`));
  }

  const template = parsed.document.body.trim();
  if (template.length === 0) {
    diagnostics.push(
      errorDiagnostic(
        'frontmatter-invalid',
        `${source}: the file has front matter but no prompt template after the closing '---'.`,
      ),
    );
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  if (!name.ok || !description.ok || !tools.ok || !model.ok) return { ok: false, diagnostics };

  const prefer = model.value?.prefer;
  if (prefer !== undefined && typeof prefer !== 'string') {
    warnings.push(
      warningDiagnostic(
        'frontmatter-invalid',
        `${source}: model.prefer is not text and was ignored.`,
      ),
    );
  }

  return {
    ok: true,
    warnings,
    command: {
      pluginId,
      name: name.value,
      description: description.value,
      tools: tools.value,
      modelPreference: typeof prefer === 'string' ? prefer : undefined,
      template,
      source,
    },
  };
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/**
 * Runs a shell command on behalf of a `!` block.
 *
 * Injected so the permission gate is unavoidable: a surface implements this by
 * calling `dispatchToolCall` with the `bash` tool, which validates arguments,
 * authorizes through the gate, and executes — the same path a model-issued command
 * takes. This package deliberately has no way to spawn a process.
 */
export type CommandRunner = (
  command: string,
) => Promise<{ readonly ok: boolean; readonly text: string }>;

/** Resolves an `@name` reference. `undefined` when no provider claims the trigger. */
export type TriggerResolver = (
  trigger: string,
) => Promise<{ readonly text: string } | undefined> | { readonly text: string } | undefined;

export interface InterpolationDeps {
  readonly runCommand?: CommandRunner;
  readonly resolveTrigger?: TriggerResolver;
  /** Cap on the bytes one `!` block may contribute. */
  readonly maxCommandBytes?: number;
}

export interface Interpolation {
  readonly prompt: string;
  /** Commands that ran, in order, for a trajectory that records what was inlined. */
  readonly commandsRun: readonly string[];
  readonly triggersResolved: readonly string[];
  readonly warnings: readonly PluginDiagnostic[];
}

export type InterpolationOutcome =
  | { readonly ok: true; readonly interpolation: Interpolation }
  | { readonly ok: false; readonly diagnostics: readonly PluginDiagnostic[] };

export const DEFAULT_MAX_COMMAND_BYTES = 32 * 1024;

/**
 * Expand `!` and `@` in a command template.
 *
 * One pass, left to right. See the header for why that matters.
 */
export async function interpolate(
  command: SlashCommand,
  deps: InterpolationDeps = {},
): Promise<InterpolationOutcome> {
  const maxBytes = deps.maxCommandBytes ?? DEFAULT_MAX_COMMAND_BYTES;
  const template = command.template;
  const acc: Accumulator = {
    output: '',
    commandsRun: [],
    triggersResolved: [],
    diagnostics: [],
    warnings: [],
  };

  let index = 0;
  while (index < template.length) {
    const character = template[index];
    if (character === undefined) break;

    if (character === '!' && template[index + 1] === '`') {
      const step = await expandCommandBlock(command, deps, template, index, maxBytes, acc);
      if (step.stop === true) break;
      index = step.next;
      continue;
    }

    if (character === '@') {
      const step = await expandTrigger(deps, template, index, acc);
      index = step.next;
      continue;
    }

    acc.output += character;
    index += 1;
  }

  if (acc.diagnostics.length > 0) return { ok: false, diagnostics: acc.diagnostics };
  return {
    ok: true,
    interpolation: {
      prompt: acc.output,
      commandsRun: acc.commandsRun,
      triggersResolved: acc.triggersResolved,
      warnings: acc.warnings,
    },
  };
}

/**
 * What one pass accumulates.
 *
 * A mutable bag threaded through the two expanders rather than each returning its own
 * partial result, because `output` has to stay a single left-to-right string: the
 * ordering guarantee in this file's header is the reason `!` and `@` cannot be
 * expanded independently and merged afterwards.
 */
interface Accumulator {
  output: string;
  readonly commandsRun: string[];
  readonly triggersResolved: string[];
  readonly diagnostics: PluginDiagnostic[];
  readonly warnings: PluginDiagnostic[];
}

/** Where the scan continues, and whether it must stop entirely. */
interface Step {
  readonly next: number;
  readonly stop?: boolean;
}

async function expandCommandBlock(
  command: SlashCommand,
  deps: InterpolationDeps,
  template: string,
  index: number,
  maxBytes: number,
  acc: Accumulator,
): Promise<Step> {
  const close = template.indexOf('`', index + 2);
  if (close < 0) {
    acc.diagnostics.push(
      errorDiagnostic(
        'frontmatter-invalid',
        `${command.source}: a '!\`' command block is never closed with a backtick.`,
      ),
    );
    return { next: index, stop: true };
  }

  const shellCommand = template.slice(index + 2, close).trim();
  const next = close + 1;

  if (shellCommand.length === 0) {
    acc.diagnostics.push(
      errorDiagnostic('frontmatter-invalid', `${command.source}: an empty '!\`\`' block.`),
    );
    return { next };
  }

  const runner = deps.runCommand;
  if (runner === undefined) {
    // Refuse, rather than expand to nothing. See the header.
    acc.diagnostics.push(
      errorDiagnostic(
        'frontmatter-invalid',
        `${command.source}: '/${command.name}' inlines the output of \`${shellCommand}\`, ` +
          `and this host provided no gate-checked command runner. The command is refused ` +
          `rather than expanded without it: a prompt that asks the model to review output ` +
          `that is not there gets an answer about nothing.`,
      ),
    );
    return { next };
  }

  let result: { readonly ok: boolean; readonly text: string };
  try {
    result = await runner(shellCommand);
  } catch (error) {
    acc.diagnostics.push(
      errorDiagnostic(
        'frontmatter-invalid',
        `${command.source}: \`${shellCommand}\` could not be run: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return { next };
  }

  acc.commandsRun.push(shellCommand);
  acc.output += renderCommandOutput(command, shellCommand, result, maxBytes, acc);
  return { next };
}

function renderCommandOutput(
  command: SlashCommand,
  shellCommand: string,
  result: { readonly ok: boolean; readonly text: string },
  maxBytes: number,
  acc: Accumulator,
): string {
  const clipped = result.text.length > maxBytes ? result.text.slice(0, maxBytes) : result.text;
  if (clipped.length < result.text.length) {
    acc.warnings.push(
      warningDiagnostic(
        'frontmatter-invalid',
        `${command.source}: output of \`${shellCommand}\` was clipped to ${maxBytes} bytes.`,
      ),
    );
  }
  // The status is stated rather than implied. A model reading command output that
  // failed should know it failed; silently inlining stderr as if it were stdout is how
  // a model concludes a test suite passed.
  return result.ok ? clipped : `[command failed: ${shellCommand}]\n${clipped}`;
}

async function expandTrigger(
  deps: InterpolationDeps,
  template: string,
  index: number,
  acc: Accumulator,
): Promise<Step> {
  const previous = index === 0 ? '' : (template[index - 1] ?? '');
  // `foo@bar`, `a/@b`: not a reference. `@` is ordinary punctuation.
  const standalone = previous === '' || /[\s([{,;:>"']/.test(previous);
  const match = standalone ? /^@[a-z0-9][a-z0-9-]*/.exec(template.slice(index)) : null;
  if (match === null) {
    acc.output += '@';
    return { next: index + 1 };
  }

  const trigger = match[0];
  const resolver = deps.resolveTrigger;
  const resolved = resolver === undefined ? undefined : await resolver(trigger);
  if (resolved === undefined) {
    // Left literal. An unknown `@name` is far more likely to be prose than a typo'd
    // provider, and erroring would make any prompt mentioning a handle unusable.
    acc.output += trigger;
    return { next: index + trigger.length };
  }

  acc.triggersResolved.push(trigger);
  acc.output += resolved.text;
  return { next: index + trigger.length };
}
