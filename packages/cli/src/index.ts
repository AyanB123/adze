/**
 * @adze/cli — the `adze` command-line surface.
 *
 * A surface, in the sense ADR-0001 means it: it owns its output and nothing else.
 * It reaches the engine through `@adze/protocol` and applies edits through
 * `@adze/apply`, and it holds no engine logic of its own — which is why a second
 * surface can be built without re-implementing any of this.
 *
 * Exported so the commands can be driven in-process, by tests and by anyone
 * embedding the CLI's behaviour without spawning it.
 *
 * ```ts
 * import { run } from '@adze/cli';
 *
 * const code = await run(['node', 'adze', 'doctor']);
 * ```
 */

export { buildProgram, run } from './cli.js';
export type { ApplyOptions } from './commands/apply.js';
export { runApply } from './commands/apply.js';
export type { DoctorOptions } from './commands/doctor.js';
export { runDoctor } from './commands/doctor.js';
export type { ValidateOptions } from './commands/validate.js';
export { runValidate } from './commands/validate.js';
export type { ExitCode, Io, Style } from './output.js';
export { EXIT, field, processIo, styleFor, writeJson } from './output.js';
export { CLI_VERSION, MINIMUM_NODE_VERSION } from './version.js';
