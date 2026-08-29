/**
 * The built-in tool set.
 *
 * ADR-0004's rule is that adding a core tool requires justification against `bash`,
 * and that the default answer to "should this be a tool?" is no. This is the list
 * that cleared that bar; each file says what its tool buys that the shell cannot.
 *
 * `fetch` is named in ADR-0004 and is **not here**. It is the one tool that makes an
 * outbound network call, and nothing leaves the machine without explicit opt-in
 * (architecture invariant 5) — so it needs the network policy the sandbox broker
 * does not yet enforce. Shipping it against a broker that cannot restrict hosts
 * would let a URL bypass the very policy it is supposed to cross. See
 * `docs/roadmap.md`.
 */

import type { IdFactory } from '../ids.js';
import type { RegisteredTool } from '../types.js';
import { createEditTool } from './edit.js';
import { createReadTool, createWriteTool } from './files.js';
import { createTaskTool, createTodoTool } from './plan.js';
import { createGlobTool, createGrepTool, createSymbolsTool } from './search.js';
import { type BashToolOptions, createBashTool } from './shell.js';

export type { EditToolOptions } from './edit.js';
export { createEditTool } from './edit.js';
export type { ReadToolOptions } from './files.js';
export { absolute, createReadTool, createWriteTool } from './files.js';
export { createTaskTool, createTodoTool } from './plan.js';
export { createGlobTool, createGrepTool, createSymbolsTool } from './search.js';
export type { BashToolOptions } from './shell.js';
export { createBashTool } from './shell.js';

export interface BuiltinToolOptions {
  readonly nextId: IdFactory;
  readonly bash?: BashToolOptions;
}

/**
 * Every built-in, in a stable order.
 *
 * Order is not cosmetic: {@link ToolRegistry.catalog} sorts by name for the
 * provider, but a stable construction order keeps a registry snapshot diffable
 * across runs, which is what makes a trajectory comparable.
 */
export function builtinTools(options: BuiltinToolOptions): readonly RegisteredTool[] {
  return [
    createBashTool(options.bash ?? {}),
    createReadTool(),
    createWriteTool(),
    createEditTool({ nextId: options.nextId }),
    createGlobTool(),
    createGrepTool(),
    createSymbolsTool(),
    createTodoTool(),
    createTaskTool(),
  ];
}
