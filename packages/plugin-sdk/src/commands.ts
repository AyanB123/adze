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
  const diagnostics: PluginDiagnostic[] = [];
  const warnings: PluginDiagnostic[] = [];
  const commandsRun: string[] = [];
  const triggersResolved: string[] = [];

  let output = '';
  let index = 0;

  while (index < template.length) {
    const character = template[index];
    if (character === undefined) break;

    if (character === '!' && template[index + 1] === '`') {
      const close = template.indexOf('`', index + 2);
      if (close < 0) {
        diagnostics.push(
          errorDiagnostic(
            'frontmatter-invalid',
            `${command.source}: a '!\`' command block is never closed with a backtick.`,
          ),
        );
        break;
      }
      const shellCommand = template.slice(index + 2, close).trim();
      index = close + 1;

      if (shellCommand.length === 0) {
        diagnostics.push(
          errorDiagnostic('frontmatter-invalid', `${command.source}: an empty '!\`\`' block.`),
        );
        continue;
      }

      const runner = deps.runCommand;
      if (runner === undefined) {
        // Refuse, rather than expand to nothing. See the header.
        diagnostics.push(
          errorDiagnostic(
            'frontmatter-invalid',
            `${command.source}: '/${command.name}' inlines the output of \`${shellCommand}\`, ` +
              `and this host provided no gate-checked command runner. The command is refused ` +
              `rather than expanded without it: a prompt that asks the model to review output ` +
              `that is not there gets an answer about nothing.`,
          ),
        );
        continue;
      }

      let result: { readonly ok: boolean; readonly text: string };
      try {
        result = await runner(shellCommand);
      } catch (error) {
        diagnostics.push(
          errorDiagnostic(
            'frontmatter-invalid',
            `${command.source}: \`${shellCommand}\` could not be run: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        continue;
      }

      commandsRun.push(shellCommand);
      const clipped = result.text.length > maxBytes ? result.text.slice(0, maxBytes) : result.text;
      if (clipped.length < result.text.length) {
        warnings.push(
          warningDiagnostic(
            'frontmatter-invalid',
            `${command.source}: output of \`${shellCommand}\` was clipped to ${maxBytes} bytes.`,
          ),
        );
      }
      // The status is stated rather than implied. A model reading command output
      // that failed should know it failed; silently inlining stderr as if it were
      // stdout is how a model concludes a test suite passed.
      output += result.ok ? clipped : `[command failed: ${shellCommand}]\n${clipped}`;
      continue;
    }

    if (character === '@') {
      const previous = index === 0 ? '' : (template[index - 1] ?? '');
      // `foo@bar`, `a/@b`: not a reference. `@` is ordinary punctuation.
      const standalone = previous === '' || /[\s([{,;:>"']/.test(previous);
      const match = standalone ? /^@[a-z0-9][a-z0-9-]*/.exec(template.slice(index)) : null;
      if (match === null) {
        output += character;
        index += 1;
        continue;
      }

      const trigger = match[0];
      const resolver = deps.resolveTrigger;
      const resolved = resolver === undefined ? undefined : await resolver(trigger);
      if (resolved === undefined) {
        // Left literal. An unknown `@name` is far more likely to be prose than a
        // typo'd provider, and erroring would make any prompt mentioning a handle
        // unusable.
        output += trigger;
        index += trigger.length;
        continue;
      }

      triggersResolved.push(trigger);
      output += resolved.text;
      index += trigger.length;
      continue;
    }

    output += character;
    index += 1;
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return {
    ok: true,
    interpolation: { prompt: output, commandsRun, triggersResolved, warnings },
  };
}
