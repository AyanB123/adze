/**
 * Public types for local-first hybrid retrieval.
 *
 * The ordering baked into these types is a conclusion, not a preference:
 * lexical search plus symbol lookup outperforms vector search on most
 * repositories, so the cheap signals run first and vectors are a supplement.
 *
 * Design rationale: docs/architecture/adr/0006-retrieval.md
 */

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/**
 * A retrieval signal. These are the only three, and they are listed in the
 * order they are attempted.
 *
 * `semantic` is declared here because the ranking layer must be able to fuse it
 * the day it exists. It is **not implemented** — see {@link VectorIndex}.
 */
export type SignalName = 'lexical' | 'symbol' | 'semantic';

/** Where a diagnostic came from. Ranking and chunking can also report. */
export type DiagnosticSource = SignalName | 'ranking' | 'chunking';

/**
 * A non-fatal report from a signal.
 *
 * Diagnostics exist so that a degraded run is *visible* rather than silently
 * thinner. "ripgrep is missing" must never look like "there were no matches".
 */
export interface RetrievalDiagnostic {
  readonly source: DiagnosticSource;
  readonly level: 'info' | 'warning' | 'error';
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * What kind of lookup to perform.
 *
 * `hybrid` is the default and runs the cheap signals concurrently, then fuses.
 */
export type RetrievalMode = 'literal' | 'regex' | 'symbol' | 'semantic' | 'hybrid';

/** `smart` means case-insensitive unless the query contains an uppercase letter. */
export type CaseSensitivity = 'sensitive' | 'insensitive' | 'smart';

export interface RetrievalRequest {
  readonly query: string;
  /** Defaults to `hybrid`. */
  readonly mode?: RetrievalMode;
  /** Workspace root. Defaults to the current working directory. */
  readonly root?: string;
  /** Subpaths within `root` to restrict the search to. */
  readonly paths?: readonly string[];
  /** Glob patterns a path must match. */
  readonly include?: readonly string[];
  /** Glob patterns a path must not match. */
  readonly exclude?: readonly string[];
  /**
   * Hard ceiling on returned results. Defaults to 200.
   *
   * This is a context-window budget, not a performance knob: an unbounded
   * result set handed to a model is a denial-of-service on its own context.
   */
  readonly maxResults?: number;
  /** Defaults to `smart`. */
  readonly caseSensitivity?: CaseSensitivity;
  /** Lines of surrounding context to capture. Defaults to 0. */
  readonly contextLines?: number;
  /** Defaults to true. When false, ignore files are not consulted. */
  readonly respectGitignore?: boolean;
  /** Defaults to false. */
  readonly includeHidden?: boolean;
  /** Wall-clock ceiling for the whole request. Defaults to 10_000 ms. */
  readonly timeoutMs?: number;
  /**
   * The file the user is currently looking at, for the proximity boost. Results
   * in the same file and directory rank higher.
   */
  readonly openFile?: string;
  readonly ranking?: RankingOptions;
}

/** "Where is X defined". */
export interface DefinitionRequest {
  /** Exact symbol name. Matching is exact, not fuzzy. */
  readonly name: string;
  readonly root?: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  /** Restrict to particular kinds, e.g. only classes. */
  readonly kinds?: readonly SymbolKind[];
  /** Defaults to 50. */
  readonly maxResults?: number;
  /**
   * Ceiling on files opened and parsed. Defaults to 300. Reached via a lexical
   * prefilter, so this is a bound on parse cost, not on repository size.
   */
  readonly maxFilesParsed?: number;
  readonly timeoutMs?: number;
  readonly respectGitignore?: boolean;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Score breakdown for one result.
 *
 * Every number that went into `score` is here. Hybrid ranking across
 * heterogeneous signals is the part of retrieval most likely to be quietly
 * wrong, so it is inspectable by construction rather than by adding logging
 * later.
 */
export interface RetrievalSignals {
  /** 1-based rank this result held within each signal's own ordered list. */
  readonly ranks: Readonly<Partial<Record<SignalName, number>>>;
  /** Each signal's weighted reciprocal-rank contribution. */
  readonly contributions: Readonly<Partial<Record<SignalName, number>>>;
  /** Sum of `contributions`. */
  readonly fusion: number;
  /** Recency in [0, 1]: 1 for a file modified now, decaying by half-life. */
  readonly recency: number;
  /** Proximity to `openFile` in [0, 1]: 1 for the same file. */
  readonly proximity: number;
}

export interface RetrievalResult {
  /** Path relative to the request root, using forward slashes. */
  readonly path: string;
  /** 1-based line number. */
  readonly line: number;
  /** 1-based character column of the match start. */
  readonly column: number;
  /** The matching line, or the symbol's first line for a symbol hit. */
  readonly snippet: string;
  readonly score: number;
  readonly signals: RetrievalSignals;
  /** Lines before `line`, when context was requested. */
  readonly before?: readonly string[];
  /** Lines after `line`, when context was requested. */
  readonly after?: readonly string[];
  /** Present when the symbol signal contributed this result. */
  readonly symbol?: SymbolInfo;
}

/** Why a result set is incomplete. Never silently omitted. */
export type TruncationReason = 'max-results' | 'timeout' | 'max-files';

export interface RetrievalResponse {
  readonly results: readonly RetrievalResult[];
  /** True when results were cut. Callers must surface this. */
  readonly truncated: boolean;
  readonly truncationReason?: TruncationReason;
  /**
   * Signals that actually produced candidates. Never lists a signal that did
   * not run — the same honesty rule as `ValidationResult.validator` in
   * `@adze/apply`.
   */
  readonly signalsUsed: readonly SignalName[];
  readonly diagnostics: readonly RetrievalDiagnostic[];
  /** The ranking parameters actually applied, echoed for reproducibility. */
  readonly ranking: ResolvedRankingOptions;
  readonly durationMs: number;
}

export interface DefinitionHit {
  readonly path: string;
  readonly symbol: SymbolInfo;
  /** Which extraction level produced this symbol. */
  readonly extractor: SymbolExtractor;
  readonly snippet: string;
}

export interface DefinitionResponse {
  readonly hits: readonly DefinitionHit[];
  readonly truncated: boolean;
  readonly truncationReason?: TruncationReason;
  /** How many files each extraction level handled. A claim about evidence. */
  readonly extractors: Readonly<Partial<Record<SymbolExtractor, number>>>;
  readonly filesParsed: number;
  readonly diagnostics: readonly RetrievalDiagnostic[];
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

/**
 * Which extractor actually ran.
 *
 * `tree-sitter`  a real parse; a grammar was loaded and the query executed.
 * `heuristic`    the documented regex scanner; line-oriented and approximate.
 * `none`         the language is not in the registry and we declined to guess.
 *
 * This mirrors `ValidationResult.validator` in `@adze/apply` deliberately. The
 * field is a claim about evidence: never widen `heuristic` to `tree-sitter`.
 */
export type SymbolExtractor = 'tree-sitter' | 'heuristic' | 'none';

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

/** A span, carrying both line/column and character offsets. */
export interface SourceRange {
  /** 1-based. */
  readonly startLine: number;
  /** 1-based. */
  readonly startColumn: number;
  /** 1-based. */
  readonly endLine: number;
  /** 1-based. */
  readonly endColumn: number;
  /** 0-based character offset. */
  readonly startIndex: number;
  /** 0-based character offset, exclusive. */
  readonly endIndex: number;
}

export interface SymbolInfo {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly range: SourceRange;
  /**
   * Enclosing named scope, e.g. `UserService` for one of its methods. Absent
   * at top level.
   */
  readonly scope?: string;
}

export interface SymbolExtraction {
  readonly path: string;
  /** Registry language id, or the empty string when unrecognised. */
  readonly language: string;
  readonly extractor: SymbolExtractor;
  readonly symbols: readonly SymbolInfo[];
  /** Why a level was used, when it is not the best one. */
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * `symbol`       one whole symbol.
 * `symbol-part`  a symbol too large for the budget, cut at line boundaries.
 * `span`         code between symbols: imports, top-level statements.
 */
export type ChunkKind = 'symbol' | 'symbol-part' | 'span';

export interface Chunk {
  readonly path: string;
  /** 1-based, inclusive. */
  readonly startLine: number;
  /** 1-based, inclusive. */
  readonly endLine: number;
  readonly text: string;
  /** Estimated at 4 characters per token. Not a real tokenizer. */
  readonly estimatedTokens: number;
  readonly kind: ChunkKind;
  /**
   * `symbol` when both edges land on a symbol boundary, `line` when the budget
   * forced a cut. Reported so a consumer can tell a function from a fragment.
   */
  readonly boundary: 'symbol' | 'line';
  /** Which extractor produced the boundaries this chunk was built from. */
  readonly extractor: SymbolExtractor;
  readonly symbol?: SymbolInfo;
  /** For `symbol-part`: which piece of how many. */
  readonly part?: { readonly index: number; readonly of: number };
}

export interface ChunkOptions {
  /** Token ceiling per chunk. Defaults to 512. */
  readonly maxTokens?: number;
  /** Spans smaller than this are merged into their neighbour. Defaults to 12. */
  readonly minSpanTokens?: number;
  /** Emit `span` chunks for code between symbols. Defaults to true. */
  readonly includeSpans?: boolean;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export interface RankingOptions {
  /**
   * Reciprocal-rank-fusion constant. Defaults to 60, the value from the
   * original RRF paper; larger flattens the curve.
   */
  readonly k?: number;
  /** Per-signal multipliers. Default 1 for every signal. */
  readonly weights?: Readonly<Partial<Record<SignalName, number>>>;
  /** Multiplier on the recency term. Defaults to 0.15. */
  readonly recencyWeight?: number;
  /** Multiplier on the proximity term. Defaults to 0.35. */
  readonly proximityWeight?: number;
  /** Recency half-life in milliseconds. Defaults to 7 days. */
  readonly recencyHalfLifeMs?: number;
}

/** `RankingOptions` with every default filled in. Echoed on the response. */
export interface ResolvedRankingOptions {
  readonly k: number;
  readonly weights: Readonly<Record<SignalName, number>>;
  readonly recencyWeight: number;
  readonly proximityWeight: number;
  readonly recencyHalfLifeMs: number;
}

// ---------------------------------------------------------------------------
// Vectors — interface only, deliberately unimplemented
// ---------------------------------------------------------------------------

export interface VectorQuery {
  readonly text: string;
  readonly root: string;
  readonly maxResults?: number;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

export interface VectorHit {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly snippet: string;
  /** Similarity in [0, 1]. Fused by rank, so the absolute scale is free. */
  readonly score: number;
}

/**
 * Local semantic search over an explicitly built index.
 *
 * **Not implemented. This is an interface and nothing else.** ADR-0006 defers
 * local vector search to a later milestone and keeps it off until a workspace
 * is explicitly indexed, so this package ships no vector dependency and no
 * embedding code. See `docs/roadmap.md`.
 *
 * Two constraints bind any implementation of this interface:
 *
 * 1. **No network call without explicit opt-in.** Embeddings are computed
 *    locally by default. A remote embedding provider is a deliberate
 *    configuration change that surfaces must report to the user.
 * 2. **Index artifacts live under `.adze/index/` in the workspace**, are
 *    gitignored, and are deletable without breaking anything.
 */
export interface VectorIndex {
  readonly name: string;
  /** False until the workspace has been explicitly indexed. */
  isIndexed(root: string): Promise<boolean>;
  query(request: VectorQuery): Promise<readonly VectorHit[]>;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** What this provider can actually do right now, on this machine. */
export interface RetrievalCapabilities {
  /** ripgrep resolved and is executable. */
  readonly lexical: boolean;
  /** At least one language can be scanned, at some level. */
  readonly symbols: boolean;
  /**
   * The best extractor available. `tree-sitter` only when a grammar actually
   * loaded — not when one merely might.
   */
  readonly symbolExtractor: SymbolExtractor;
  /** A `VectorIndex` was supplied *and* reports the workspace indexed. */
  readonly semantic: boolean;
  /** Human-readable notes on anything degraded. */
  readonly notes: readonly string[];
}

/**
 * The retrieval subsystem, as seen by the engine.
 *
 * ADR-0006 promises the whole subsystem can be swapped without forking Adze,
 * which is what this interface is for. Implementations must return structured,
 * ranked results — never raw tool output.
 */
export interface RetrievalProvider {
  readonly name: string;
  capabilities(): Promise<RetrievalCapabilities>;
  search(request: RetrievalRequest): Promise<RetrievalResponse>;
  definitions(request: DefinitionRequest): Promise<DefinitionResponse>;
  /** Release parsers, grammars, and any long-lived handles. */
  dispose?(): Promise<void>;
}
