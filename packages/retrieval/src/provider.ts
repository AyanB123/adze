/**
 * The local hybrid retrieval provider: the thing that actually runs a search.
 *
 * Signal order is ADR-0006's conclusion from evidence, not a preference:
 *
 *   1. **ripgrep** for literal and regex. No index, instant on a fresh clone.
 *   2. **tree-sitter symbols**, over a lexically prefiltered candidate set, so
 *      parse cost is bounded by the prefilter rather than by repository size.
 *   3. **local vectors**, deferred — see `./vectors.ts`. No implementation ships.
 *
 * Then reciprocal rank fusion across whichever signals actually ran.
 *
 * Three properties this class exists to hold:
 *
 * **It does not throw for a missing tool.** ripgrep absent, grammars absent, an
 * unreadable file: each becomes a diagnostic and a narrower result set. A model
 * reading an exception cannot degrade; a model reading a diagnostic can.
 *
 * **It never claims a signal that did not run.** `signalsUsed` lists only signals
 * that produced candidates, and symbol results carry the extractor level that
 * produced them. Same rule as `ValidationResult.validator` in `@adze/apply`.
 *
 * **Nothing is unbounded.** Results, files parsed, file size, and wall clock all
 * have ceilings, and when one bites the response says which. An unbounded result
 * set handed to a model is a denial-of-service on its own context window.
 *
 * Design rationale: docs/architecture/adr/0006-retrieval.md
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { modificationTimes, walkFiles } from './files.js';
import { type GrammarOptions, type GrammarProvider, GrammarRegistry } from './grammars.js';
import { LANGUAGES, languageForPath, supportedExtensions } from './languages.js';
import { fuseResults, type RankCandidate } from './rank.js';
import {
  escapeRegex,
  type RipgrepMatch,
  type RipgrepSearchResult,
  RipgrepUnavailableError,
  resolveRipgrepPath,
  ripgrepListFiles,
  ripgrepSearch,
} from './ripgrep.js';
import { SymbolService } from './symbols.js';
import type {
  CaseSensitivity,
  DefinitionHit,
  DefinitionRequest,
  DefinitionResponse,
  RankingOptions,
  RetrievalCapabilities,
  RetrievalDiagnostic,
  RetrievalMode,
  RetrievalProvider,
  RetrievalRequest,
  RetrievalResponse,
  RetrievalResult,
  SignalName,
  SymbolExtractor,
  SymbolInfo,
  TruncationReason,
  VectorIndex,
} from './types.js';
import { semanticUnavailableDiagnostic } from './vectors.js';

const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_DEFINITION_MAX_RESULTS = 50;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_FILES_PARSED = 300;
/**
 * Files above this are skipped by the symbol signal.
 *
 * A megabyte of minified bundle or generated protobuf has no symbols worth
 * finding and costs a parse. The lexical signal still covers such files, so this
 * narrows the expensive path only.
 */
const DEFAULT_MAX_FILE_BYTES = 1_000_000;

export interface LocalRetrievalProviderOptions {
  /** Workspace root for requests that do not carry one. Defaults to `cwd`. */
  readonly root?: string;
  /**
   * Where real parses come from. Omit for a {@link GrammarRegistry} using the
   * documented resolution order, or pass `null` to skip tree-sitter entirely and
   * always use the heuristic scanner.
   */
  readonly grammars?: GrammarProvider | null;
  /** Options for the default {@link GrammarRegistry}. Ignored if `grammars` is set. */
  readonly grammarOptions?: GrammarOptions;
  /**
   * Enables the semantic signal. **Nothing in this package implements
   * {@link VectorIndex}** — ADR-0006 defers it. Supply your own to opt in.
   */
  readonly vectorIndex?: VectorIndex;
  /** Default ranking parameters, overridable per request. */
  readonly ranking?: RankingOptions;
  /** Ceiling on files opened and parsed per request. Defaults to 300. */
  readonly maxFilesParsed?: number;
  /** Ceiling on the size of a file the symbol signal will read. */
  readonly maxFileBytes?: number;
}

/** Which signals a mode asks for. */
interface ModeSignals {
  readonly lexical: boolean;
  readonly symbol: boolean;
  readonly semantic: boolean;
}

function signalsForMode(mode: RetrievalMode): ModeSignals {
  switch (mode) {
    case 'literal':
    case 'regex':
      return { lexical: true, symbol: false, semantic: false };
    case 'symbol':
      return { lexical: false, symbol: true, semantic: false };
    case 'semantic':
      return { lexical: false, symbol: false, semantic: true };
    default:
      return { lexical: true, symbol: true, semantic: true };
  }
}

/** Per-request settings, resolved once from the request and the provider defaults. */
interface SearchSettings {
  readonly root: string;
  readonly mode: RetrievalMode;
  readonly maxResults: number;
  readonly contextLines: number;
  readonly caseSensitivity: CaseSensitivity;
  readonly deadline: Deadline;
  readonly wanted: ModeSignals;
}

/** How a request narrows the file set, forwarded verbatim to the lexical layer. */
interface ScopeOptions {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly paths?: readonly string[];
  readonly respectGitignore?: boolean;
}

/**
 * Lift the scope-narrowing fields off a request.
 *
 * Each is omitted rather than set to `undefined`, because `exactOptionalPropertyTypes`
 * distinguishes the two and the layers below treat "absent" as "use the default"
 * rather than "no filter".
 */
function scopeOptions(
  request: Pick<RetrievalRequest, 'include' | 'exclude' | 'paths' | 'respectGitignore'>,
): ScopeOptions {
  return {
    ...(request.include === undefined ? {} : { include: request.include }),
    ...(request.exclude === undefined ? {} : { exclude: request.exclude }),
    ...(request.paths === undefined ? {} : { paths: request.paths }),
    ...(request.respectGitignore === undefined
      ? {}
      : { respectGitignore: request.respectGitignore }),
  };
}

/** Every distinct path across all signal lists, for one batched `stat` pass. */
function candidatePaths(lists: ReadonlyMap<SignalName, readonly RankCandidate[]>): string[] {
  const paths = new Set<string>();
  for (const candidates of lists.values()) {
    for (const candidate of candidates) paths.add(candidate.path);
  }
  return [...paths];
}

/**
 * Include globs for the symbol prefilter.
 *
 * The extension glob is a cost optimisation, not a filter the caller chose.
 * ripgrep unions multiple `--glob` includes, so adding it alongside a caller's
 * `include` would *widen* their restriction — asking for `*.md` would also return
 * `.ts` files. When the caller has an opinion, theirs is the only include, and
 * unsupported extensions are dropped from the results instead.
 */
function prefilterInclude(include: readonly string[] | undefined): string[] {
  if (include === undefined || include.length === 0) {
    return [`*.{${supportedExtensions().join(',')}}`];
  }
  return [...include];
}

/**
 * The first `limit` distinct paths a registered language claims.
 *
 * A file whose language is not registered has no symbols to find and the lexical
 * signal already covers it, so dropping it here spends the parse budget on files
 * that could actually answer.
 */
function symbolCandidatePaths(matches: readonly RipgrepMatch[], limit: number): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    if (seen.has(match.path)) continue;
    seen.add(match.path);
    if (languageForPath(match.path) === undefined) continue;
    unique.push(match.path);
    if (unique.length >= limit) break;
  }
  return unique;
}

/** True when a query should be matched case-insensitively. */
function isCaseInsensitive(query: string, sensitivity: CaseSensitivity): boolean {
  if (sensitivity === 'insensitive') return true;
  if (sensitivity === 'sensitive') return false;
  // `smart`: an uppercase letter in the query means the user meant it.
  return query === query.toLowerCase();
}

/** Context lines around a match, from whatever ripgrep reported. */
function contextFor(
  lines: ReadonlyMap<number, string> | undefined,
  line: number,
  contextLines: number,
): { readonly before?: readonly string[]; readonly after?: readonly string[] } {
  if (lines === undefined || contextLines <= 0) return {};
  const before: string[] = [];
  for (let n = line - contextLines; n < line; n++) {
    const text = lines.get(n);
    if (text !== undefined) before.push(text);
  }
  const after: string[] = [];
  for (let n = line + 1; n <= line + contextLines; n++) {
    const text = lines.get(n);
    if (text !== undefined) after.push(text);
  }
  return {
    ...(before.length > 0 ? { before } : {}),
    ...(after.length > 0 ? { after } : {}),
  };
}

function lexicalCandidates(result: RipgrepSearchResult, contextLines: number): RankCandidate[] {
  return result.matches.map((match: RipgrepMatch): RankCandidate => {
    const lines = result.linesByPath.get(match.path);
    return {
      path: match.path,
      line: match.line,
      column: match.column,
      snippet: match.text,
      ...contextFor(lines, match.line, contextLines),
    };
  });
}

/**
 * How well a symbol name answers a query, lower being better.
 *
 * Exact beats case-insensitive-exact beats prefix beats substring. The symbol
 * signal's own ordering is what fusion consumes, so this is the whole of its
 * relevance model — deliberately crude, and crude in a documented direction
 * rather than an emergent one.
 */
function nameMatchRank(name: string, query: string, insensitive: boolean): number | undefined {
  if (name === query) return 0;
  const a = insensitive ? name.toLowerCase() : name;
  const b = insensitive ? query.toLowerCase() : query;
  if (a === b) return 1;
  if (a.startsWith(b)) return 2;
  if (a.includes(b)) return 3;
  return undefined;
}

interface SymbolFileHit {
  readonly path: string;
  readonly symbol: SymbolInfo;
  readonly extractor: SymbolExtractor;
  readonly snippet: string;
  readonly rank: number;
}

/** A budget that reports whether wall-clock time is left, without a timer. */
class Deadline {
  private readonly endsAt: number;
  constructor(timeoutMs: number) {
    this.endsAt = performance.now() + timeoutMs;
  }
  get expired(): boolean {
    return performance.now() >= this.endsAt;
  }
  get remainingMs(): number {
    return Math.max(0, this.endsAt - performance.now());
  }
}

export class LocalRetrievalProvider implements RetrievalProvider {
  readonly name = 'local-hybrid';

  private readonly root: string;
  private readonly grammars: GrammarProvider | undefined;
  private readonly symbolService: SymbolService;
  private readonly vectorIndex: VectorIndex | undefined;
  private readonly ranking: RankingOptions | undefined;
  private readonly maxFilesParsed: number;
  private readonly maxFileBytes: number;

  constructor(options: LocalRetrievalProviderOptions = {}) {
    this.root = options.root ?? process.cwd();
    if (options.grammars === null) {
      this.grammars = undefined;
    } else {
      this.grammars =
        options.grammars ??
        new GrammarRegistry({ root: this.root, ...(options.grammarOptions ?? {}) });
    }
    this.symbolService = new SymbolService(
      this.grammars === undefined ? {} : { grammars: this.grammars },
    );
    this.vectorIndex = options.vectorIndex;
    this.ranking = options.ranking;
    this.maxFilesParsed = options.maxFilesParsed ?? DEFAULT_MAX_FILES_PARSED;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  /**
   * What this provider can do on this machine, right now.
   *
   * `symbolExtractor` is answered by *attempting a real parse*, not by checking
   * whether a grammar file might exist. Reporting `tree-sitter` on the strength
   * of a configured directory would be the same lie as widening a `structural`
   * validation result, and a surface showing a capability badge would repeat it.
   */
  async capabilities(): Promise<RetrievalCapabilities> {
    const notes: string[] = [];

    const rg = await resolveRipgrepPath();
    if (!rg.ok) {
      notes.push(
        `${rg.message} The symbol signal falls back to a bounded directory walk that does not read .gitignore.`,
      );
    }

    const symbolExtractor = await this.probeExtractor(notes);

    let semantic = false;
    if (this.vectorIndex === undefined) {
      notes.push(semanticUnavailableDiagnostic('no-provider').message);
    } else {
      try {
        semantic = await this.vectorIndex.isIndexed(this.root);
        if (!semantic) notes.push(semanticUnavailableDiagnostic('not-indexed').message);
      } catch (error) {
        semantic = false;
        notes.push(
          `vector index '${this.vectorIndex.name}' could not report its state: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return {
      lexical: rg.ok,
      // The heuristic scanner needs nothing, so some level is always available.
      symbols: true,
      symbolExtractor,
      semantic,
      notes,
    };
  }

  /**
   * Determine the best extractor by trying one.
   *
   * A tiny source per language is parsed until one grammar answers. Loads are
   * cached by the registry, so this costs at most one attempt per language for
   * the life of the provider — and on a clone with no grammars it is a handful of
   * failed `readFile` calls.
   */
  private async probeExtractor(notes: string[]): Promise<SymbolExtractor> {
    if (this.grammars === undefined) {
      notes.push(
        'tree-sitter is disabled for this provider; symbols come from the heuristic scanner.',
      );
      return 'heuristic';
    }
    const reasons: string[] = [];
    for (const definition of LANGUAGES) {
      const outcome = await this.grammars.querySymbols(definition, '');
      if (outcome.ok) return 'tree-sitter';
      reasons.push(outcome.message);
    }
    notes.push(
      `no tree-sitter grammar loaded, so symbols come from the heuristic scanner. ${
        reasons[0] ?? 'no grammar directory was readable.'
      }`,
    );
    return 'heuristic';
  }

  /** Resolve request options against the provider defaults, once per search. */
  private resolveSettings(request: RetrievalRequest): SearchSettings {
    const mode = request.mode ?? 'hybrid';
    return {
      root: request.root ?? this.root,
      mode,
      maxResults: Math.max(1, request.maxResults ?? DEFAULT_MAX_RESULTS),
      contextLines: Math.max(0, request.contextLines ?? 0),
      caseSensitivity: request.caseSensitivity ?? 'smart',
      deadline: new Deadline(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      wanted: signalsForMode(mode),
    };
  }

  /**
   * Run each signal the mode asks for and collect what it produced.
   *
   * A signal that produced no candidates is left out of `lists` entirely, which
   * is what lets `signalsUsed` downstream report the signals that actually
   * contributed rather than the ones that were requested.
   */
  private async gatherSignals(
    request: RetrievalRequest,
    settings: SearchSettings,
  ): Promise<{
    readonly lists: ReadonlyMap<SignalName, readonly RankCandidate[]>;
    readonly diagnostics: readonly RetrievalDiagnostic[];
    readonly truncationReason?: TruncationReason;
  }> {
    const { deadline, root, mode, wanted } = settings;
    const diagnostics: RetrievalDiagnostic[] = [];
    const lists = new Map<SignalName, readonly RankCandidate[]>();
    let truncationReason: TruncationReason | undefined;
    const hasQuery = request.query.length > 0;

    if (wanted.lexical && hasQuery) {
      const outcome = await this.runLexical(request, root, mode, {
        maxResults: settings.maxResults,
        contextLines: settings.contextLines,
        caseSensitivity: settings.caseSensitivity,
        deadline,
      });
      diagnostics.push(...outcome.diagnostics);
      if (outcome.candidates.length > 0) lists.set('lexical', outcome.candidates);
      truncationReason ??= outcome.truncationReason;
    }

    if (wanted.symbol && hasQuery && !deadline.expired) {
      const outcome = await this.runSymbols(request, root, {
        caseSensitivity: settings.caseSensitivity,
        deadline,
      });
      diagnostics.push(...outcome.diagnostics);
      if (outcome.candidates.length > 0) lists.set('symbol', outcome.candidates);
      truncationReason ??= outcome.truncationReason;
    }

    diagnostics.push(...(await this.semanticDiagnostics(mode, root, wanted.semantic)));

    return {
      lists,
      diagnostics,
      ...(truncationReason === undefined ? {} : { truncationReason }),
    };
  }

  async search(request: RetrievalRequest): Promise<RetrievalResponse> {
    const startedAt = performance.now();
    const settings = this.resolveSettings(request);

    const diagnostics: RetrievalDiagnostic[] = [];
    if (request.query.length === 0) {
      diagnostics.push({ source: 'ranking', level: 'warning', message: 'the query was empty' });
    }

    const gathered = await this.gatherSignals(request, settings);
    diagnostics.push(...gathered.diagnostics);

    const mtimes = await modificationTimes(settings.root, candidatePaths(gathered.lists));
    const rankingOptions = request.ranking ?? this.ranking;
    const fused = fuseResults({
      lists: gathered.lists,
      mtimes,
      ...(request.openFile === undefined ? {} : { openFile: request.openFile }),
      ...(rankingOptions === undefined ? {} : { options: rankingOptions }),
    });

    let results: readonly RetrievalResult[] = fused.results;
    let truncationReason = gathered.truncationReason;
    if (results.length > settings.maxResults) {
      results = results.slice(0, settings.maxResults);
      truncationReason = 'max-results';
    }
    if (settings.deadline.expired) truncationReason ??= 'timeout';

    return {
      results,
      truncated: truncationReason !== undefined,
      ...(truncationReason === undefined ? {} : { truncationReason }),
      signalsUsed: fused.signalsUsed,
      diagnostics,
      ranking: fused.ranking,
      durationMs: performance.now() - startedAt,
    };
  }

  private async runLexical(
    request: RetrievalRequest,
    root: string,
    mode: RetrievalMode,
    context: {
      readonly maxResults: number;
      readonly contextLines: number;
      readonly caseSensitivity: CaseSensitivity;
      readonly deadline: Deadline;
    },
  ): Promise<{
    readonly candidates: readonly RankCandidate[];
    readonly diagnostics: readonly RetrievalDiagnostic[];
    readonly truncationReason?: TruncationReason;
  }> {
    const diagnostics: RetrievalDiagnostic[] = [];
    try {
      const result = await ripgrepSearch({
        pattern: request.query,
        literal: mode !== 'regex',
        cwd: root,
        ...(request.paths === undefined ? {} : { paths: request.paths }),
        ...(request.include === undefined ? {} : { include: request.include }),
        ...(request.exclude === undefined ? {} : { exclude: request.exclude }),
        caseSensitivity: context.caseSensitivity,
        contextLines: context.contextLines,
        // Ask for one more than needed so "exactly at the cap" is
        // distinguishable from "more were available".
        maxResults: context.maxResults + 1,
        timeoutMs: Math.max(1, Math.floor(context.deadline.remainingMs)),
        ...(request.respectGitignore === undefined
          ? {}
          : { respectGitignore: request.respectGitignore }),
        ...(request.includeHidden === undefined ? {} : { includeHidden: request.includeHidden }),
      });

      if (result.stderr.length > 0) {
        diagnostics.push({
          source: 'lexical',
          level: result.matches.length === 0 ? 'error' : 'warning',
          message: `ripgrep reported: ${result.stderr}`,
        });
      }

      return {
        candidates: lexicalCandidates(result, context.contextLines),
        diagnostics,
        ...(result.truncationReason === undefined
          ? {}
          : { truncationReason: result.truncationReason }),
      };
    } catch (error) {
      diagnostics.push({
        source: 'lexical',
        level: 'error',
        message:
          error instanceof RipgrepUnavailableError
            ? `${error.message} Treat lexical results as unknown rather than absent.`
            : `the lexical signal failed: ${
                error instanceof Error ? error.message : String(error)
              }. Treat lexical results as unknown rather than absent.`,
      });
      return { candidates: [], diagnostics };
    }
  }

  private async runSymbols(
    request: RetrievalRequest,
    root: string,
    context: {
      readonly caseSensitivity: CaseSensitivity;
      readonly deadline: Deadline;
    },
  ): Promise<{
    readonly candidates: readonly RankCandidate[];
    readonly diagnostics: readonly RetrievalDiagnostic[];
    readonly truncationReason?: TruncationReason;
  }> {
    const insensitive = isCaseInsensitive(request.query, context.caseSensitivity);
    const found = await this.collectSymbolHits(request, root, {
      insensitive,
      deadline: context.deadline,
      match: (name) => nameMatchRank(name, request.query, insensitive),
    });

    return {
      candidates: found.hits
        .slice()
        .sort((a, b) => a.rank - b.rank || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map(
          (hit): RankCandidate => ({
            path: hit.path,
            line: hit.symbol.range.startLine,
            column: hit.symbol.range.startColumn,
            snippet: hit.snippet,
            symbol: hit.symbol,
          }),
        ),
      diagnostics: found.diagnostics,
      ...(found.truncationReason === undefined ? {} : { truncationReason: found.truncationReason }),
    };
  }

  /**
   * Find candidate files lexically, then parse only those.
   *
   * This is the cheapest-signal-first principle applied inside the symbol
   * signal: ripgrep decides which files could possibly contain the name, so the
   * parse budget is spent on files that might answer rather than on the
   * repository. When ripgrep is unavailable the fallback is a bounded directory
   * walk, which is worse — it does not read `.gitignore` — and is reported as
   * such rather than silently substituted.
   */
  private async candidateFiles(
    query: string,
    root: string,
    options: ScopeOptions & {
      readonly exact: boolean;
      readonly insensitive: boolean;
      readonly deadline: Deadline;
    },
  ): Promise<{
    readonly files: readonly string[];
    readonly truncated: boolean;
    readonly diagnostics: readonly RetrievalDiagnostic[];
  }> {
    const diagnostics: RetrievalDiagnostic[] = [];

    try {
      // A word-boundary regex, so `get` does not drag in every `getFoo`. Escaped
      // because the query is user text: it is data, never pattern syntax.
      const pattern = options.exact ? String.raw`\b${escapeRegex(query)}\b` : escapeRegex(query);
      const result = await ripgrepSearch({
        pattern,
        literal: false,
        cwd: root,
        ...(options.paths === undefined ? {} : { paths: options.paths }),
        include: prefilterInclude(options.include),
        ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
        caseSensitivity: options.insensitive ? 'insensitive' : 'sensitive',
        // Several matches per file are normal; the cap is on files, applied
        // after de-duplication in `symbolCandidatePaths`.
        maxResults: this.maxFilesParsed * 8,
        timeoutMs: Math.max(1, Math.floor(options.deadline.remainingMs)),
        ...(options.respectGitignore === undefined
          ? {}
          : { respectGitignore: options.respectGitignore }),
      });

      const files = symbolCandidatePaths(result.matches, this.maxFilesParsed);
      if (result.stderr.length > 0) {
        diagnostics.push({
          source: 'symbol',
          level: 'warning',
          message: `ripgrep reported while prefiltering: ${result.stderr}`,
        });
      }
      return {
        files,
        truncated: files.length >= this.maxFilesParsed || result.truncated,
        diagnostics,
      };
    } catch (error) {
      diagnostics.push({
        source: 'symbol',
        level: 'warning',
        message:
          `${error instanceof Error ? error.message : String(error)} ` +
          'Falling back to a bounded directory walk, which does not read .gitignore, ' +
          'so the candidate set differs from what ripgrep would have searched.',
      });
      const walked = await this.walkCandidates(root, options);
      return { files: walked.files, truncated: walked.truncated, diagnostics };
    }
  }

  /**
   * Candidate files without ripgrep: a bounded directory walk.
   *
   * Strictly worse than the ripgrep path because it does not read `.gitignore`,
   * which is why the caller reports the substitution instead of hiding it.
   */
  private async walkCandidates(
    root: string,
    options: Pick<ScopeOptions, 'include' | 'exclude'>,
  ): Promise<{ readonly files: readonly string[]; readonly truncated: boolean }> {
    const walked = await walkFiles({
      root,
      maxFiles: this.maxFilesParsed,
      ...(options.include === undefined ? {} : { include: options.include }),
      ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
      extensions: supportedExtensions(),
    });
    return { files: walked.files, truncated: walked.truncated };
  }

  /** Parse candidate files and keep symbols whose name the matcher accepts. */
  private async collectSymbolHits(
    request: Pick<RetrievalRequest, 'query' | 'include' | 'exclude' | 'paths' | 'respectGitignore'>,
    root: string,
    options: {
      readonly insensitive: boolean;
      readonly deadline: Deadline;
      readonly exact?: boolean;
      readonly match: (name: string) => number | undefined;
    },
  ): Promise<{
    readonly hits: readonly SymbolFileHit[];
    readonly diagnostics: readonly RetrievalDiagnostic[];
    readonly extractors: Partial<Record<SymbolExtractor, number>>;
    readonly filesParsed: number;
    readonly truncationReason?: TruncationReason;
  }> {
    const diagnostics: RetrievalDiagnostic[] = [];
    const extractors: Partial<Record<SymbolExtractor, number>> = {};
    const hits: SymbolFileHit[] = [];
    let filesParsed = 0;
    let truncationReason: TruncationReason | undefined;

    const candidates = await this.candidateFiles(request.query, root, {
      ...scopeOptions(request),
      exact: options.exact ?? false,
      insensitive: options.insensitive,
      deadline: options.deadline,
    });
    diagnostics.push(...candidates.diagnostics);
    if (candidates.truncated) truncationReason = 'max-files';

    for (const path of candidates.files) {
      if (options.deadline.expired) {
        truncationReason = 'timeout';
        break;
      }
      const parsed = await this.hitsForFile(root, path, options.match);
      if (parsed === undefined) continue;
      filesParsed++;
      extractors[parsed.extractor] = (extractors[parsed.extractor] ?? 0) + 1;
      hits.push(...parsed.hits);
    }

    for (const reason of this.symbolService.fallbackDiagnostics()) {
      diagnostics.push({ source: 'symbol', level: 'info', message: reason });
    }

    return {
      hits,
      diagnostics,
      extractors,
      filesParsed,
      ...(truncationReason === undefined ? {} : { truncationReason }),
    };
  }

  /**
   * Parse one file and keep the symbols whose name the matcher accepts.
   *
   * `undefined` means the file was never parsed — unreadable or oversized — which
   * the caller distinguishes from a parse that found nothing, because only the
   * latter counts towards `filesParsed` and the extractor tally.
   */
  private async hitsForFile(
    root: string,
    path: string,
    match: (name: string) => number | undefined,
  ): Promise<
    { readonly hits: readonly SymbolFileHit[]; readonly extractor: SymbolExtractor } | undefined
  > {
    const source = await this.readSource(root, path);
    if (source === undefined) return undefined;

    const extraction = await this.symbolService.extract(path, source);
    if (extraction.symbols.length === 0) return { hits: [], extractor: extraction.extractor };

    const lines = source.split(/\r?\n/);
    const hits: SymbolFileHit[] = [];
    for (const symbol of extraction.symbols) {
      const rank = match(symbol.name);
      if (rank === undefined) continue;
      hits.push({
        path,
        symbol,
        extractor: extraction.extractor,
        snippet: lines[symbol.range.startLine - 1] ?? symbol.name,
        rank,
      });
    }
    return { hits, extractor: extraction.extractor };
  }

  /** Read a file for parsing, skipping anything unreadable or oversized. */
  private async readSource(root: string, path: string): Promise<string | undefined> {
    try {
      const buffer = await readFile(join(root, path));
      if (buffer.byteLength > this.maxFileBytes) return undefined;
      return buffer.toString('utf8');
    } catch {
      // A file that vanished or cannot be read is not a failure of the search.
      return undefined;
    }
  }

  /**
   * Explain the semantic signal's absence, without over-explaining it.
   *
   * An explicit `mode: 'semantic'` always gets an answer, because the caller
   * asked for something that did not happen. A `hybrid` query stays quiet unless
   * an index was actually configured and is merely unbuilt, which is the one case
   * where there is something for the user to do. "Semantic is off by default" is
   * ADR-0006's design, not a degradation to warn about on every query.
   */
  private async semanticDiagnostics(
    mode: RetrievalMode,
    root: string,
    wanted: boolean,
  ): Promise<readonly RetrievalDiagnostic[]> {
    if (!wanted) return [];
    if (this.vectorIndex === undefined) {
      return mode === 'semantic' ? [semanticUnavailableDiagnostic('no-provider')] : [];
    }
    try {
      if (await this.vectorIndex.isIndexed(root)) {
        // An index exists and reports itself built. Fusing its hits is the work
        // ADR-0006 defers; saying so is better than quietly ignoring it.
        return [
          {
            source: 'semantic',
            level: 'info',
            message:
              `vector index '${this.vectorIndex.name}' reports this workspace indexed, but ` +
              'fusing semantic hits is not implemented in this milestone.',
          },
        ];
      }
      return [semanticUnavailableDiagnostic('not-indexed')];
    } catch (error) {
      return [
        {
          source: 'semantic',
          level: 'warning',
          message: `vector index '${this.vectorIndex.name}' failed to report its state: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ];
    }
  }

  /**
   * "Where is X defined." Exact name matching, never fuzzy.
   *
   * A fuzzy answer to this question is worse than no answer: a model told that
   * `UserServcie` is defined at a plausible location will act on it.
   */
  async definitions(request: DefinitionRequest): Promise<DefinitionResponse> {
    const startedAt = performance.now();
    const root = request.root ?? this.root;
    const maxResults = Math.max(1, request.maxResults ?? DEFAULT_DEFINITION_MAX_RESULTS);
    const deadline = new Deadline(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const kinds = request.kinds === undefined ? undefined : new Set(request.kinds);

    const found = await this.collectSymbolHits(
      {
        query: request.name,
        ...(request.include === undefined ? {} : { include: request.include }),
        ...(request.exclude === undefined ? {} : { exclude: request.exclude }),
        ...(request.respectGitignore === undefined
          ? {}
          : { respectGitignore: request.respectGitignore }),
      },
      root,
      {
        insensitive: false,
        deadline,
        exact: true,
        // Exact, and nothing else. `nameMatchRank` would accept a prefix.
        match: (name) => (name === request.name ? 0 : undefined),
      },
    );

    const filtered = found.hits.filter((hit) => kinds === undefined || kinds.has(hit.symbol.kind));
    const ordered = filtered.slice().sort((a, b) => {
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      return a.symbol.range.startLine - b.symbol.range.startLine;
    });

    let truncationReason = found.truncationReason;
    let hits: readonly DefinitionHit[] = ordered.map(
      (hit): DefinitionHit => ({
        path: hit.path,
        symbol: hit.symbol,
        extractor: hit.extractor,
        snippet: hit.snippet,
      }),
    );
    if (hits.length > maxResults) {
      hits = hits.slice(0, maxResults);
      truncationReason = 'max-results';
    }

    return {
      hits,
      truncated: truncationReason !== undefined,
      ...(truncationReason === undefined ? {} : { truncationReason }),
      extractors: found.extractors,
      filesParsed: found.filesParsed,
      diagnostics: found.diagnostics,
      durationMs: performance.now() - startedAt,
    };
  }

  /**
   * List the files this provider would consider, honouring ignore rules.
   *
   * Exposed because "what is in scope" is a question surfaces ask directly, and
   * answering it from ripgrep keeps one definition of the answer.
   */
  async listFiles(
    options: {
      readonly root?: string;
      readonly include?: readonly string[];
      readonly exclude?: readonly string[];
      readonly maxFiles?: number;
      readonly timeoutMs?: number;
      readonly respectGitignore?: boolean;
    } = {},
  ): Promise<{ readonly files: readonly string[]; readonly truncated: boolean }> {
    const root = options.root ?? this.root;
    try {
      const result = await ripgrepListFiles({
        cwd: root,
        ...(options.include === undefined ? {} : { include: options.include }),
        ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
        maxFiles: options.maxFiles ?? this.maxFilesParsed,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(options.respectGitignore === undefined
          ? {}
          : { respectGitignore: options.respectGitignore }),
      });
      return { files: result.files, truncated: result.truncated };
    } catch {
      const walked = await walkFiles({
        root,
        maxFiles: options.maxFiles ?? this.maxFilesParsed,
        ...(options.include === undefined ? {} : { include: options.include }),
        ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
      });
      return { files: walked.files, truncated: walked.truncated };
    }
  }

  async dispose(): Promise<void> {
    this.symbolService.dispose();
    return await Promise.resolve();
  }
}
