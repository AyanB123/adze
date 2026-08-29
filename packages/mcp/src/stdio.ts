/**
 * Spawning a stdio server safely.
 *
 * An MCP server is a subprocess, and the arguments come from a config file that in
 * practice is copy-pasted from a README. That makes argument handling a security
 * boundary rather than plumbing.
 *
 * **The rule: an argument array, never a shell string.** `command` and `args` stay
 * separate fields from config all the way into `spawn`, so a value containing `;`,
 * `&&`, `|`, `$(...)`, a backtick, or a newline is passed to the child as one
 * literal argument and is never parsed by anything. Joining them into a string —
 * even briefly, even only for a log line — is what turns a server name into remote
 * code execution, so this module never produces such a string and
 * `test/security.test.ts` asserts that the metacharacters survive verbatim as
 * single argv elements.
 *
 * The SDK's `StdioClientTransport` passes `shell: false` to `spawn` explicitly,
 * verified in `@modelcontextprotocol/sdk@1.30.0`. That is the mechanism this module
 * relies on, and {@link buildStdioParameters} never sets `shell`, so the transport's
 * default cannot be overridden from a config file.
 */

import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig } from './types.js';

export type StdioParametersOutcome =
  | { readonly ok: true; readonly parameters: StdioServerParameters }
  | { readonly ok: false; readonly message: string };

/**
 * Turn a config into `spawn` parameters.
 *
 * Refuses rather than repairing. A missing `command` or an argument containing a NUL
 * byte is a config bug, and guessing at what was meant would spawn something the
 * operator did not write.
 */
export function buildStdioParameters(config: McpServerConfig): StdioParametersOutcome {
  const command = config.command?.trim() ?? '';
  if (command.length === 0) {
    return {
      ok: false,
      message: `server '${config.name}' uses the stdio transport but declares no command.`,
    };
  }

  // A NUL truncates the string at the OS boundary, so an argument containing one is
  // not the argument that was reviewed. Node rejects it too, but with an error that
  // does not say which server is at fault.
  if (command.includes('\0')) {
    return { ok: false, message: `server '${config.name}' has a NUL byte in its command.` };
  }
  const args = [...(config.args ?? [])];
  const badArg = args.findIndex((arg) => arg.includes('\0'));
  if (badArg >= 0) {
    return {
      ok: false,
      message: `server '${config.name}' has a NUL byte in argument ${String(badArg)}.`,
    };
  }

  // The child gets a curated environment plus whatever the operator configured.
  // Inheriting the parent's full environment would hand every server every
  // credential this process holds; the SDK's default set is PATH, HOME, and a few
  // others, which is what `npx`-style servers actually need to start.
  const env: Record<string, string> = { ...getDefaultEnvironment(), ...(config.env ?? {}) };

  return {
    ok: true,
    parameters: {
      command,
      args,
      env,
      // Piped rather than inherited so a chatty or crashing server cannot interleave
      // its output into Adze's own stderr, where it would look like Adze's diagnostic.
      // It is captured, redacted, and attributed to the server instead.
      stderr: 'pipe',
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    },
  };
}
