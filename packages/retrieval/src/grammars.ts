/**
 * Lazy tree-sitter grammar loading.
 *
 * Three properties matter here.
 *
 * **Lazy.** Nothing in this file runs until a caller actually asks for a real
 * parse. `web-tree-sitter` is imported dynamically, so on a fresh clone with no
 * grammars present the tree-sitter runtime WASM is never even read.
 *
 * **Local.** `Language.load` accepts a string, and a string can be a URL. We
 * never hand it one: grammar bytes are read from disk with `fs.readFile` and
 * passed as a `Uint8Array`. That makes "retrieval performs no network call" a
 * property of the code rather than a promise about configuration.
 *
 * **WASM, not native.** ADR-0002 chose `web-tree-sitter` over native bindings
 * specifically so we never rebuild native modules across Electron ABI x OS x
 * arch. Nothing in this file may reintroduce a native dependency.
 *
 * # Supplying grammars
 *
 * Grammar files are not vendored. Resolution order for the directory:
 *
 * 1. `GrammarOptions.directory`, passed by the caller.
 * 2. `$ADZE_GRAMMAR_DIR`.
 * 3. `<workspace>/.adze/grammars`.
 *
 * Build one with the tree-sitter CLI:
 *
 * ```sh
 * npx tree-sitter build --wasm node_modules/tree-sitter-python
 * mkdir -p .adze/grammars && mv tree-sitter-python.wasm .adze/grammars/
 * ```
 *
 * `.adze/` is gitignored and deletable: without it retrieval falls back to the
 * heuristic scanner and says so.
 *
 * A query can be overridden by placing `<language-id>.scm` in the same
 * directory, which is used instead of the built-in query.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Language, Node, Parser, Query } from 'web-tree-sitter';
import type { LanguageDefinition } from './languages.js';

export interface GrammarOptions {
  /** Directory holding `tree-sitter-*.wasm` files and optional `*.scm` overrides. */
  readonly directory?: string;
  /** Explicit per-language-id absolute paths. Takes precedence over `directory`. */
  readonly files?: Readonly<Record<string, string>>;
  /**
   * Workspace root, used for the `<root>/.adze/grammars` default. Defaults to
   * the current working directory.
   */
  readonly root?: string;
}

/** A grammar that loaded, with its query compiled and ready. */
export interface LoadedGrammar {
  readonly language: Language;
  readonly query: Query;
  /** Patterns dropped because they did not compile against this grammar. */
  readonly droppedPatterns: number;
  /** Where the query came from, so an override is visible. */
  readonly querySource: 'builtin' | 'override';
}

export type GrammarLoad =
  | { readonly ok: true; readonly grammar: LoadedGrammar }
  | { readonly ok: false; readonly message: string };

// ---------------------------------------------------------------------------
// The seam between tree-sitter and symbol extraction
// ---------------------------------------------------------------------------

/**
 * The part of a syntax node symbol extraction reads.
 *
 * Written structurally rather than importing `web-tree-sitter`'s `Node` as a
 * value type, for two reasons. It keeps `symbols.ts` free of any tree-sitter
 * import, value or type; and it makes the tree-sitter *code path* testable on a
 * machine with no grammar WASM files, which is every fresh clone. A real `Node`
 * satisfies this shape, so no adapter runs in production.
 */
export interface SyntaxNodeLike {
  readonly type: string;
  readonly text: string;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
  readonly parent: SyntaxNodeLike | null;
  childForFieldName(field: string): SyntaxNodeLike | null;
}

export interface QueryCaptureLike {
  readonly name: string;
  readonly node: SyntaxNodeLike;
}

export interface QueryMatchLike {
  /**
   * Index of the query pattern that produced this match. Query order is
   * significant — an earlier pattern wins a tie on the same node — so this is
   * part of the contract rather than debug information.
   */
  readonly patternIndex: number;
  readonly captures: readonly QueryCaptureLike[];
}

/**
 * The outcome of running a language's symbol query over one file.
 *
 * A failure carries a message rather than throwing, because every failure here
 * has the same correct response: fall back to the heuristic scanner and say so.
 */
export type SymbolQueryOutcome =
  | {
      readonly ok: true;
      readonly matches: readonly QueryMatchLike[];
      /** Patterns dropped because they did not compile against this grammar. */
      readonly droppedPatterns: number;
      readonly querySource: 'builtin' | 'override';
    }
  | { readonly ok: false; readonly message: string };

/**
 * A source of real parses, as {@link SymbolService} sees it.
 *
 * {@link GrammarRegistry} is the implementation. ADR-0006 promises the retrieval
 * subsystem is swappable without forking, and this is the narrowest surface that
 * promise needs at the parse boundary.
 */
export interface GrammarProvider {
  querySymbols(definition: LanguageDefinition, source: string): Promise<SymbolQueryOutcome>;
  dispose(): void;
}

/**
 * Split a query into independently compilable top-level patterns.
 *
 * A query is compiled as a whole first, because that is both faster and the
 * common case. This exists for the uncommon one: a single pattern referring to a
 * node type the installed grammar version does not have makes tree-sitter reject
 * the *entire* query, which would silently cost a language all of its symbols.
 * Compiling pattern by pattern turns that into a partial loss we can report.
 *
 * Exported for tests, since the paren/string/comment handling is easy to get
 * subtly wrong.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a character scanner has one branch per character class per context, so its branch count is inherent rather than accidental. Splitting the cursor across helpers that share mutable `depth`, `inString`, and `i` state makes the paren/string/comment interaction harder to verify, not easier — and a wrong split silently costs a language its symbols. test/grammars.test.ts pins the behaviour, including a guard that every built-in query still splits into as many patterns as it has definition captures.
export function splitQueryPatterns(source: string): string[] {
  const patterns: string[] = [];
  let buffer = '';
  let depth = 0;
  let inString = false;
  let closedAtTopLevel = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === undefined) break;

    if (inString) {
      buffer += char;
      if (char === '\\') {
        const next = source[i + 1];
        if (next !== undefined) {
          buffer += next;
          i++;
        }
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }

    // A `;` outside a string starts a comment that runs to end of line.
    if (char === ';') {
      const newline = source.indexOf('\n', i);
      i = newline === -1 ? source.length : newline;
      buffer += '\n';
      continue;
    }

    if (char === '"') {
      inString = true;
      buffer += char;
      continue;
    }

    // A new group at depth zero, after a completed one, begins a new pattern.
    // Trailing `@capture` names stay attached because they precede this point.
    if (depth === 0 && closedAtTopLevel && (char === '(' || char === '[')) {
      const trimmed = buffer.trim();
      if (trimmed.length > 0) patterns.push(trimmed);
      buffer = '';
      closedAtTopLevel = false;
    }

    buffer += char;
    if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) closedAtTopLevel = true;
    }
  }

  const tail = buffer.trim();
  if (tail.length > 0) patterns.push(tail);
  return patterns;
}

type TreeSitterModule = typeof import('web-tree-sitter');

/**
 * Manages the tree-sitter runtime, loaded grammars, and compiled queries.
 *
 * One instance per provider. Grammars are cached, and a failed load is cached
 * too: retrying a missing file on every request would turn one missing grammar
 * into a per-query filesystem miss.
 */
export class GrammarRegistry implements GrammarProvider {
  private readonly options: GrammarOptions;
  private modulePromise: Promise<TreeSitterModule | undefined> | undefined;
  private readonly cache = new Map<string, Promise<GrammarLoad>>();
  private readonly parsers = new Map<string, Parser>();

  constructor(options: GrammarOptions = {}) {
    this.options = options;
  }

  /** Candidate directory for grammar files, in resolution order. */
  private grammarDirectory(): string {
    if (this.options.directory !== undefined) return this.options.directory;
    const fromEnvironment = process.env.ADZE_GRAMMAR_DIR;
    if (fromEnvironment !== undefined && fromEnvironment.length > 0) return fromEnvironment;
    return join(this.options.root ?? process.cwd(), '.adze', 'grammars');
  }

  private grammarPath(definition: LanguageDefinition): string {
    const explicit = this.options.files?.[definition.id];
    if (explicit !== undefined) return explicit;
    return join(this.grammarDirectory(), definition.grammarFile);
  }

  /**
   * Load `web-tree-sitter` and initialise it once.
   *
   * Returns undefined rather than throwing when the runtime cannot start, so a
   * broken WASM environment degrades to the heuristic scanner.
   */
  private async treeSitter(): Promise<TreeSitterModule | undefined> {
    this.modulePromise ??= (async (): Promise<TreeSitterModule | undefined> => {
      try {
        const module = await import('web-tree-sitter');
        await module.Parser.init();
        return module;
      } catch {
        return undefined;
      }
    })();
    return await this.modulePromise;
  }

  /** Read a query override from the grammar directory, if one is present. */
  private async queryOverride(definition: LanguageDefinition): Promise<string | undefined> {
    try {
      return await readFile(join(this.grammarDirectory(), `${definition.id}.scm`), 'utf8');
    } catch {
      return undefined;
    }
  }

  private buildQuery(
    module: TreeSitterModule,
    language: Language,
    source: string,
  ): { readonly query: Query; readonly dropped: number } | undefined {
    try {
      return { query: new module.Query(language, source), dropped: 0 };
    } catch {
      // Fall through to per-pattern compilation.
    }

    const kept: string[] = [];
    let dropped = 0;
    for (const pattern of splitQueryPatterns(source)) {
      try {
        const probe = new module.Query(language, pattern);
        probe.delete();
        kept.push(pattern);
      } catch {
        dropped++;
      }
    }
    if (kept.length === 0) return undefined;
    try {
      return { query: new module.Query(language, kept.join('\n')), dropped };
    } catch {
      return undefined;
    }
  }

  /** Load a grammar and compile its query. Cached, including failures. */
  async load(definition: LanguageDefinition): Promise<GrammarLoad> {
    const cached = this.cache.get(definition.id);
    if (cached !== undefined) return await cached;

    const pending = (async (): Promise<GrammarLoad> => {
      const module = await this.treeSitter();
      if (module === undefined) {
        return { ok: false, message: 'web-tree-sitter runtime failed to initialise' };
      }

      const path = this.grammarPath(definition);
      let bytes: Uint8Array;
      try {
        // Read the bytes ourselves. `Language.load` would accept a string, and a
        // string can be a URL — this is the line that makes a network fetch
        // impossible rather than merely unlikely.
        bytes = await readFile(path);
      } catch {
        return {
          ok: false,
          message:
            `no grammar for ${definition.displayName} at '${path}'. ` +
            `Build one with 'npx tree-sitter build --wasm node_modules/tree-sitter-${definition.id}' ` +
            `and place it there, or set ADZE_GRAMMAR_DIR.`,
        };
      }

      let language: Language;
      try {
        language = await module.Language.load(bytes);
      } catch (error) {
        return {
          ok: false,
          message: `grammar at '${path}' failed to load: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }

      const override = await this.queryOverride(definition);
      const built = this.buildQuery(module, language, override ?? definition.symbolQuery);
      if (built === undefined) {
        return {
          ok: false,
          message:
            `no pattern in the ${definition.displayName} symbol query compiled against the ` +
            `installed grammar. Override it with '${definition.id}.scm' in the grammar directory.`,
        };
      }

      const parser = new module.Parser();
      parser.setLanguage(language);
      this.parsers.set(definition.id, parser);

      return {
        ok: true,
        grammar: {
          language,
          query: built.query,
          droppedPatterns: built.dropped,
          querySource: override === undefined ? 'builtin' : 'override',
        },
      };
    })();

    this.cache.set(definition.id, pending);
    return await pending;
  }

  /**
   * Parse source with a loaded grammar, returning the root node.
   *
   * Undefined when the grammar is unavailable or the parse produced no tree, so
   * callers fall back rather than branch on an exception.
   */
  async parse(definition: LanguageDefinition, source: string): Promise<Node | undefined> {
    const loaded = await this.load(definition);
    if (!loaded.ok) return undefined;
    const parser = this.parsers.get(definition.id);
    if (parser === undefined) return undefined;
    try {
      const tree = parser.parse(source);
      return tree?.rootNode;
    } catch {
      return undefined;
    }
  }

  /**
   * Load a grammar, parse `source`, and run the language's symbol query.
   *
   * The whole tree-sitter path in one call, so the only thing symbol extraction
   * knows about tree-sitter is the shape of a match. Every failure — no grammar
   * file, a runtime that would not start, a parse that produced no tree, a query
   * that threw — comes back as `ok: false` with a message, because the correct
   * response to all four is identical: use the heuristic scanner and report that
   * is what ran.
   */
  async querySymbols(definition: LanguageDefinition, source: string): Promise<SymbolQueryOutcome> {
    const loaded = await this.load(definition);
    if (!loaded.ok) return { ok: false, message: loaded.message };

    const root = await this.parse(definition, source);
    if (root === undefined) {
      return { ok: false, message: `${definition.displayName} parse produced no tree` };
    }

    try {
      return {
        ok: true,
        matches: loaded.grammar.query.matches(root),
        droppedPatterns: loaded.grammar.droppedPatterns,
        querySource: loaded.grammar.querySource,
      };
    } catch (error) {
      return {
        ok: false,
        message: `${definition.displayName} symbol query failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /** Release parsers. Grammars and queries are owned by the WASM heap. */
  dispose(): void {
    for (const parser of this.parsers.values()) {
      try {
        parser.delete();
      } catch {
        // A parser already freed by the WASM runtime is not an error worth
        // propagating out of teardown.
      }
    }
    this.parsers.clear();
    this.cache.clear();
  }
}
