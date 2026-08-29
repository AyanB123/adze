/**
 * `glob`, `grep`, and `symbols` — structured retrieval.
 *
 * All three sit behind the {@link SearchBackend} seam and **none of them works
 * without a backend**, because `core` ships none: `@adze/retrieval` owns ripgrep
 * and tree-sitter, and depending on it from here would couple two service packages
 * (docs/architecture/README.md §4).
 *
 * When no backend is configured these tools say so. That is the whole reason they
 * do not simply return an empty result: "ripgrep is missing" must never look like
 * "there were no matches", and a model that reads an empty result as evidence will
 * conclude the symbol does not exist and act on it.
 *
 * Each justifies existing over `bash` by returning structured, ranked objects
 * instead of stdout for the model to scrape. `symbols` in particular answers "where
 * is X defined" for a fraction of the tokens `grep` costs, and it reports which
 * extractor ran so a heuristic answer is never mistaken for a parse.
 */

import { z } from 'zod';
import { defineTool } from '../registry.js';
import type { SymbolKind } from '../retrieval.js';
import type { RegisteredTool, ToolExecution } from '../types.js';

const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_TIMEOUT_MS = 10_000;

const SYMBOL_KINDS: readonly [SymbolKind, ...SymbolKind[]] = [
  'function',
  'method',
  'class',
  'interface',
  'type',
  'enum',
  'struct',
  'trait',
  'constant',
  'variable',
  'module',
  'property',
];

function unavailable(tool: string): ToolExecution {
  return {
    ok: false,
    content: [
      {
        type: 'text',
        text:
          `${tool} is unavailable: no retrieval backend is configured for this engine, so ` +
          `there is nothing to search with. This is not an empty result — use bash with ` +
          `grep or find instead, and treat this as "unknown" rather than "not present".`,
      },
    ],
    error: 'no retrieval backend configured',
  };
}

const GlobArgs = z.object({
  patterns: z
    .array(z.string().min(1))
    .min(1)
    .describe('Glob patterns, relative to the workspace root.'),
  maxResults: z.number().int().positive().max(1_000).optional(),
});

export function createGlobTool(): RegisteredTool {
  return defineTool({
    name: 'glob',
    description:
      'List files matching glob patterns, ranked. Returns paths only. Prefer this over ' +
      '`bash ls` when you want to find files by shape rather than read a directory.',
    schema: GlobArgs,

    effects(_args, ctx) {
      return [{ kind: 'file-read', path: ctx.workspaceRoot }];
    },

    async execute(args, ctx): Promise<ToolExecution> {
      if (ctx.search === undefined) return unavailable('glob');
      const outcome = await ctx.search.glob({
        patterns: args.patterns,
        root: ctx.workspaceRoot,
        maxResults: args.maxResults ?? DEFAULT_MAX_RESULTS,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      const header = `matches: ${outcome.paths.length}${outcome.truncated ? ' (truncated)' : ''}`;
      return {
        ok: true,
        content: [
          {
            type: 'text',
            text: [header, ...notes(outcome.notes), '', ...outcome.paths].join('\n'),
          },
        ],
      };
    },
  });
}

const GrepArgs = z.object({
  query: z.string().min(1).describe('Text or regular expression to find.'),
  mode: z.enum(['literal', 'regex']).optional().describe('Defaults to literal.'),
  include: z.array(z.string().min(1)).optional().describe('Glob patterns a path must match.'),
  exclude: z.array(z.string().min(1)).optional().describe('Glob patterns a path must not match.'),
  caseSensitive: z.boolean().optional(),
  maxResults: z.number().int().positive().max(1_000).optional(),
});

export function createGrepTool(): RegisteredTool {
  return defineTool({
    name: 'grep',
    description:
      'Search file contents, returning ranked structured matches with path, line, and the ' +
      'matching text. Prefer this over `bash grep`: results are ranked and bounded rather ' +
      'than raw stdout.',
    schema: GrepArgs,

    effects(_args, ctx) {
      return [{ kind: 'file-read', path: ctx.workspaceRoot }];
    },

    async execute(args, ctx): Promise<ToolExecution> {
      if (ctx.search === undefined) return unavailable('grep');
      const outcome = await ctx.search.search({
        query: args.query,
        mode: args.mode ?? 'literal',
        root: ctx.workspaceRoot,
        maxResults: args.maxResults ?? DEFAULT_MAX_RESULTS,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        ...(args.include === undefined ? {} : { include: args.include }),
        ...(args.exclude === undefined ? {} : { exclude: args.exclude }),
        ...(args.caseSensitive === undefined ? {} : { caseSensitive: args.caseSensitive }),
      });
      const lines = outcome.hits.map(
        (hit) => `${hit.path}:${hit.line}:${hit.column}\t${hit.snippet.trim()}`,
      );
      const header = `matches: ${outcome.hits.length}${outcome.truncated ? ' (truncated)' : ''}`;
      return {
        ok: true,
        content: [
          { type: 'text', text: [header, ...notes(outcome.notes), '', ...lines].join('\n') },
        ],
      };
    },
  });
}

const SymbolsArgs = z.object({
  name: z.string().min(1).describe('Exact symbol name. Matching is exact, not fuzzy.'),
  kinds: z.array(z.enum(SYMBOL_KINDS)).optional().describe('Restrict to particular kinds.'),
  maxResults: z.number().int().positive().max(200).optional(),
});

export function createSymbolsTool(): RegisteredTool {
  return defineTool({
    name: 'symbols',
    description:
      'Find where a symbol is defined, by exact name. Cheaper and more precise than grep ' +
      'for "where is X defined". Reports which extractor ran, so a heuristic answer is ' +
      'distinguishable from a real parse.',
    schema: SymbolsArgs,

    effects(_args, ctx) {
      return [{ kind: 'file-read', path: ctx.workspaceRoot }];
    },

    async execute(args, ctx): Promise<ToolExecution> {
      if (ctx.search === undefined) return unavailable('symbols');
      const outcome = await ctx.search.symbols({
        name: args.name,
        root: ctx.workspaceRoot,
        maxResults: args.maxResults ?? 50,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        ...(args.kinds === undefined ? {} : { kinds: args.kinds }),
      });
      const lines = outcome.hits.map(
        (hit) =>
          `${hit.path}:${hit.line}\t${hit.kind} ${hit.name}` +
          `${hit.scope === undefined ? '' : ` in ${hit.scope}`}\t${hit.snippet.trim()}`,
      );
      const header =
        `definitions: ${outcome.hits.length}${outcome.truncated ? ' (truncated)' : ''}\n` +
        `extractor: ${outcome.extractor}`;
      return {
        ok: true,
        content: [
          { type: 'text', text: [header, ...notes(outcome.notes), '', ...lines].join('\n') },
        ],
      };
    },
  });
}

/** Backend diagnostics, so a degraded run is visible rather than merely thinner. */
function notes(values: readonly string[]): readonly string[] {
  return values.map((note) => `note: ${note}`);
}
