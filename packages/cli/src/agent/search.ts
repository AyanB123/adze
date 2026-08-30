/**
 * The retrieval backend, wired.
 *
 * `@adze/core` declares {@link SearchBackend} and deliberately ships no implementation:
 * `glob`, `grep`, and `symbols` report themselves unavailable when none is configured,
 * because two service packages must not import each other (docs/architecture/README.md
 * §4). `@adze/retrieval` implements the retrieval side. Nothing joined them, so all three
 * tools were dead in the CLI — the agent's only way to find code was `bash grep`, which
 * needs an approval per call and returns stdout for the model to scrape, which is the exact
 * situation ADR-0004 gives as the reason those tools exist.
 *
 * A **surface** is the right place for this join. Core owns the seam, retrieval owns the
 * capability, and the composition is a surface's job — which is also why this adapter is
 * thin enough to be obviously correct: it renames fields and does not decide anything.
 *
 * ### Two honesty rules it has to carry across
 *
 * `SymbolOutcome.extractor` is a claim about evidence, mirroring
 * `ValidationResult.validator` in `@adze/apply`. `@adze/retrieval` reports the extractor
 * per hit; core's seam carries one value for the whole outcome, so the aggregate is the
 * **weakest** contributor rather than the best one. Reporting `tree-sitter` for a result
 * set the heuristic scanner partly produced would widen a heuristic answer into a claimed
 * parse, which the seam explicitly forbids.
 *
 * A missing ripgrep **throws** rather than returning no paths. Dispatch turns that into a
 * failed call, which is what core asks for: "ripgrep is missing" must never look like
 * "there were no matches", and `matches: 0` with a note attached is exactly the shape a
 * model misreads as evidence that a file does not exist.
 */

import type {
  GlobOutcome,
  GlobQuery,
  SearchBackend,
  SearchOutcome,
  SearchQuery,
  SymbolOutcome,
  SymbolQuery,
} from '@adze/core';
import type {
  RetrievalDiagnostic,
  RetrievalProvider,
  RipgrepListFilesOptions,
  RipgrepListFilesResult,
  SymbolExtractor,
} from '@adze/retrieval';
import { LocalRetrievalProvider, ripgrepListFiles } from '@adze/retrieval';

export interface RetrievalBackendOptions {
  /** Absolute workspace root. Requests carry their own, and core always sets it. */
  readonly root: string;
  /** Injectable so a test needs neither a real index nor a real workspace. */
  readonly provider?: RetrievalProvider;
  /** Injectable so a test does not need ripgrep on the machine running it. */
  readonly listFiles?: (options: RipgrepListFilesOptions) => Promise<RipgrepListFilesResult>;
}

/**
 * Diagnostics become notes, so a degraded run is visible rather than merely thinner.
 *
 * The level is carried for anything above `info`, because "the symbol index timed out" and
 * "the symbol index is warning you it timed out" are the same sentence to a model only if
 * the severity is attached. A note that reads as trivia gets treated as trivia.
 */
function toNotes(diagnostics: readonly RetrievalDiagnostic[]): readonly string[] {
  return diagnostics.map((diagnostic) =>
    diagnostic.level === 'info'
      ? `${diagnostic.source}: ${diagnostic.message}`
      : `${diagnostic.source} (${diagnostic.level}): ${diagnostic.message}`,
  );
}

/**
 * Weakest evidence wins.
 *
 * `none` < `heuristic` < `tree-sitter`. See the file comment: understating the extractor
 * is safe, and overstating it is the one thing the field must never do.
 */
const EXTRACTOR_RANK: Readonly<Record<SymbolExtractor, number>> = {
  none: 0,
  heuristic: 1,
  'tree-sitter': 2,
};

function weakest(levels: readonly SymbolExtractor[]): SymbolExtractor {
  let result: SymbolExtractor = 'none';
  let rank = Number.POSITIVE_INFINITY;
  for (const level of levels) {
    const candidate = EXTRACTOR_RANK[level];
    if (candidate < rank) {
      rank = candidate;
      result = level;
    }
  }
  return result;
}

/** `@adze/retrieval` behind `@adze/core`'s narrower seam. */
export class RetrievalSearchBackend implements SearchBackend {
  readonly name = 'local-retrieval';

  private readonly provider: RetrievalProvider;
  private readonly listFiles: (options: RipgrepListFilesOptions) => Promise<RipgrepListFilesResult>;

  constructor(options: RetrievalBackendOptions) {
    this.provider = options.provider ?? new LocalRetrievalProvider({ root: options.root });
    this.listFiles = options.listFiles ?? ripgrepListFiles;
  }

  async search(query: SearchQuery): Promise<SearchOutcome> {
    const response = await this.provider.search({
      query: query.query,
      // Core's `literal | regex` are two of `RetrievalMode`'s members, so this crosses
      // unchanged rather than being reinterpreted.
      mode: query.mode,
      root: query.root,
      maxResults: query.maxResults,
      timeoutMs: query.timeoutMs,
      ...(query.include === undefined ? {} : { include: query.include }),
      ...(query.exclude === undefined ? {} : { exclude: query.exclude }),
      // Omitted rather than defaulted: the provider's own default is `smart`, and
      // forcing `insensitive` here would silently change what `grep` matches.
      ...(query.caseSensitive === undefined
        ? {}
        : {
            caseSensitivity: query.caseSensitive
              ? ('sensitive' as const)
              : ('insensitive' as const),
          }),
    });

    return {
      hits: response.results.map((result) => ({
        path: result.path,
        line: result.line,
        column: result.column,
        snippet: result.snippet,
        score: result.score,
      })),
      truncated: response.truncated,
      notes: toNotes(response.diagnostics),
    };
  }

  async glob(query: GlobQuery): Promise<GlobOutcome> {
    // `RipgrepUnavailableError` is left to propagate. See the file comment.
    const result = await this.listFiles({
      cwd: query.root,
      include: query.patterns,
      maxFiles: query.maxResults,
      timeoutMs: query.timeoutMs,
    });

    return { paths: result.files, truncated: result.truncated, notes: [] };
  }

  async symbols(query: SymbolQuery): Promise<SymbolOutcome> {
    const response = await this.provider.definitions({
      name: query.name,
      root: query.root,
      maxResults: query.maxResults,
      timeoutMs: query.timeoutMs,
      ...(query.kinds === undefined ? {} : { kinds: query.kinds }),
    });

    // Computed from the hits actually returned when there are any, because that is exact.
    // `extractors` counts files parsed, including ones that produced nothing.
    const levels: readonly SymbolExtractor[] =
      response.hits.length > 0
        ? response.hits.map((hit) => hit.extractor)
        : Object.entries(response.extractors)
            .filter(([, count]) => count !== undefined && count > 0)
            .map(([level]) => level as SymbolExtractor);

    return {
      hits: response.hits.map((hit) => ({
        path: hit.path,
        name: hit.symbol.name,
        kind: hit.symbol.kind,
        line: hit.symbol.range.startLine,
        snippet: hit.snippet,
        ...(hit.symbol.scope === undefined ? {} : { scope: hit.symbol.scope }),
      })),
      truncated: response.truncated,
      extractor: weakest(levels),
      notes: toNotes(response.diagnostics),
    };
  }
}
