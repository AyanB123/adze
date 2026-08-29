/**
 * The tool registry.
 *
 * Two properties are worth more than everything else in this file.
 *
 * **Arguments are validated before a tool can run.** {@link defineTool} does not
 * expose `execute` at all; it exposes `prepare`, which parses the model's
 * arguments with the tool's Zod schema and only then hands back a
 * {@link PreparedCall} whose `execute` closes over the *parsed* value. There is no
 * signature that accepts unvalidated arguments, so "remember to validate" is not a
 * rule anyone can forget.
 *
 * **Narrowing cannot widen.** {@link ToolRegistry.narrow} filters an existing
 * registry, so a subagent's allowlist is a subset by construction rather than by
 * check. A name the parent does not have is reported as an error instead of
 * silently yielding a smaller tool set, because a subagent quietly missing the tool
 * it was told to use fails in a way that looks like model incompetence.
 */

import type { JsonObject } from '@adze/protocol';
import { formatIssues, toJsonSchema } from '@adze/protocol';
import type { PrepareOutcome, RegisteredTool, ToolDefinition } from './types.js';

/** What a provider needs in order to advertise a tool natively. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
}

/**
 * Erase a tool's argument type, keeping validation in front of execution.
 *
 * The returned object is the only shape the registry stores, and the closure over
 * `parsed.data` is what removes the need for a cast: the typed value never leaves
 * the scope where its type is known.
 */
export function defineTool<A>(definition: ToolDefinition<A>): RegisteredTool {
  return {
    name: definition.name,
    description: definition.description,
    parameters: toJsonSchema(definition.schema),
    prepare(args: JsonObject): PrepareOutcome {
      const parsed = definition.schema.safeParse(args);
      if (!parsed.success) {
        // Addressed to the model: an argument error is a retry opportunity, and one
        // round of feedback is the highest-value intervention in the loop.
        return { ok: false, issues: formatIssues(parsed.error.issues) };
      }
      const value = parsed.data;
      return {
        ok: true,
        call: {
          effects: (ctx) => definition.effects(value, ctx),
          execute: async (ctx) => await definition.execute(value, ctx),
        },
      };
    },
  };
}

export type NarrowOutcome =
  | { readonly ok: true; readonly registry: ToolRegistry }
  | { readonly ok: false; readonly unknown: readonly string[] };

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(tools: readonly RegisteredTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  /**
   * Add a tool.
   *
   * A duplicate name throws rather than replacing. Silent replacement would let a
   * plugin shadow `bash` or `edit` with something that looks identical to the
   * model, which is a capability the plugin architecture deliberately does not
   * grant.
   */
  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): readonly string[] {
    return [...this.tools.keys()];
  }

  all(): readonly RegisteredTool[] {
    return [...this.tools.values()];
  }

  /**
   * Provider-facing catalog, sorted by name.
   *
   * Sorted because it is part of the request the provider caches on: an unsorted
   * `Map` iteration order is stable in practice and not guaranteed by anything a
   * reader can check, and a reordered tool list is a cache miss on every step —
   * which is the same failure the context assembler's epochs exist to prevent.
   */
  catalog(): readonly ToolSpec[] {
    return [...this.tools.values()]
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** A registry containing only `allowlist`. Never more than this one has. */
  narrow(allowlist: readonly string[]): NarrowOutcome {
    const unknown = allowlist.filter((name) => !this.tools.has(name));
    if (unknown.length > 0) return { ok: false, unknown };
    const narrowed = new ToolRegistry();
    for (const name of allowlist) {
      const tool = this.tools.get(name);
      if (tool !== undefined) narrowed.register(tool);
    }
    return { ok: true, registry: narrowed };
  }
}
