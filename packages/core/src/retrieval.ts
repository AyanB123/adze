/**
 * The retrieval seam.
 *
 * `@adze/retrieval` owns ripgrep, tree-sitter symbols, and hybrid ranking. This
 * file is deliberately **not** an import of it. Two reasons, and the second is
 * the load-bearing one:
 *
 * 1. Service packages must not import each other (docs/architecture/README.md
 *    §4). `core` may depend on a service package, but the dependency has to be
 *    narrow enough that swapping the implementation is a configuration change
 *    rather than a refactor — ADR-0006 promises retrieval can be replaced
 *    without forking Adze, and an interface this small is what that promise
 *    costs.
 * 2. The interface below is the *subset the tools actually need*, which is a
 *    fraction of `RetrievalProvider`. Depending on the whole provider surface
 *    would couple the engine to ranking parameters, chunking, and vector
 *    configuration that no tool ever passes.
 *
 * **Nothing here is implemented.** `core` ships no backend: `glob`, `grep`, and
 * `symbols` report themselves unavailable when none is configured, which is the
 * honest behaviour — "ripgrep is missing" must never look like "there were no
 * matches". Wiring a real backend is M1's retrieval half; see
 * `docs/roadmap.md`.
 */

/** Where a lexical match landed. */
export interface SearchHit {
  /** Workspace-relative, forward slashes. */
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
  /** The matching line, verbatim. Never pre-formatted for display. */
  readonly snippet: string;
  /** Fused rank score. Scale is implementation-defined; ordering is not. */
  readonly score: number;
}

export interface SearchQuery {
  readonly query: string;
  readonly mode: 'literal' | 'regex';
  /** Absolute. The backend must not read outside it. */
  readonly root: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly maxResults: number;
  readonly caseSensitive?: boolean;
  readonly timeoutMs: number;
}

export interface SearchOutcome {
  readonly hits: readonly SearchHit[];
  /** True when results were cut. Callers must surface this. */
  readonly truncated: boolean;
  /** Non-fatal reports, so a degraded run is visible rather than thinner. */
  readonly notes: readonly string[];
}

export interface GlobQuery {
  readonly patterns: readonly string[];
  readonly root: string;
  readonly maxResults: number;
  readonly timeoutMs: number;
}

export interface GlobOutcome {
  readonly paths: readonly string[];
  readonly truncated: boolean;
  readonly notes: readonly string[];
}

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'constant'
  | 'variable'
  | 'module'
  | 'property';

export interface SymbolHit {
  readonly path: string;
  readonly name: string;
  readonly kind: SymbolKind;
  /** 1-based. */
  readonly line: number;
  readonly snippet: string;
  /** Enclosing named scope, when the symbol is nested. */
  readonly scope?: string;
}

export interface SymbolQuery {
  readonly name: string;
  readonly root: string;
  readonly kinds?: readonly SymbolKind[];
  readonly maxResults: number;
  readonly timeoutMs: number;
}

export interface SymbolOutcome {
  readonly hits: readonly SymbolHit[];
  readonly truncated: boolean;
  /**
   * Which extractor ran: `tree-sitter` for a real parse, `heuristic` for the
   * regex scanner, `none` when the language was unrecognised and the backend
   * declined to guess.
   *
   * A claim about evidence, mirroring `ValidationResult.validator` in
   * `@adze/apply`. A backend must never widen `heuristic` to `tree-sitter`, and
   * the engine passes it through to the model unchanged.
   */
  readonly extractor: 'tree-sitter' | 'heuristic' | 'none';
  readonly notes: readonly string[];
}

/**
 * The retrieval capability, as the engine's tools need it.
 *
 * An implementation must return structured, ranked results — never raw tool
 * output for the model to scrape. That is the entire justification for `grep`
 * and `symbols` existing rather than being `bash` (ADR-0004).
 */
export interface SearchBackend {
  readonly name: string;
  search(query: SearchQuery): Promise<SearchOutcome>;
  glob(query: GlobQuery): Promise<GlobOutcome>;
  symbols(query: SymbolQuery): Promise<SymbolOutcome>;
}
