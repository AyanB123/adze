/**
 * Hybrid ranking.
 *
 * Signals are fused with reciprocal rank fusion: each signal contributes
 * `weight / (k + rank)` for the results it returned. RRF is used because the
 * signals produce scores on incomparable scales — a ripgrep hit has no score at
 * all, a symbol match is categorical, a cosine similarity is in [0, 1] — and
 * normalising them against each other would be inventing a comparison. Rank is
 * the only thing all three genuinely share.
 *
 * Two boosts then apply, multiplicatively:
 *
 *     score = fusion * (1 + recencyWeight * recency + proximityWeight * proximity)
 *
 * Multiplicative, not additive, because adjacent RRF contributions differ by
 * almost nothing (1/61 versus 1/62 at k=60). An additive boost on any scale large
 * enough to matter would swamp rank agreement entirely and turn ranking into
 * "whatever was edited last". Multiplying preserves the signals' ordering as the
 * primary term while letting a hit in the open file overtake one a rank or two
 * better.
 *
 * Every intermediate value lands in {@link RetrievalSignals}. ADR-0006 names
 * hybrid ranking as the hardest part of this design to tune, and a scoring
 * function nobody can inspect does not get tuned, it gets replaced.
 */

import type {
  RankingOptions,
  ResolvedRankingOptions,
  RetrievalResult,
  RetrievalSignals,
  SignalName,
  SymbolInfo,
} from './types.js';

const DEFAULT_K = 60;
const DEFAULT_RECENCY_WEIGHT = 0.15;
const DEFAULT_PROXIMITY_WEIGHT = 0.35;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const ALL_SIGNALS: readonly SignalName[] = ['lexical', 'symbol', 'semantic'];

export function resolveRankingOptions(options: RankingOptions = {}): ResolvedRankingOptions {
  const weights: Record<SignalName, number> = { lexical: 1, symbol: 1, semantic: 1 };
  for (const signal of ALL_SIGNALS) {
    const provided = options.weights?.[signal];
    if (typeof provided === 'number' && Number.isFinite(provided)) weights[signal] = provided;
  }
  return {
    k: options.k !== undefined && options.k > 0 ? options.k : DEFAULT_K,
    weights,
    recencyWeight: options.recencyWeight ?? DEFAULT_RECENCY_WEIGHT,
    proximityWeight: options.proximityWeight ?? DEFAULT_PROXIMITY_WEIGHT,
    recencyHalfLifeMs:
      options.recencyHalfLifeMs !== undefined && options.recencyHalfLifeMs > 0
        ? options.recencyHalfLifeMs
        : SEVEN_DAYS_MS,
  };
}

/**
 * Recency in [0, 1], halving every `halfLifeMs`.
 *
 * A file touched now scores 1; one untouched for a half-life scores 0.5. Files
 * with no known modification time score 0 rather than an assumed middle value —
 * guessing here would quietly reorder results on a fresh checkout, where every
 * mtime is the clone time.
 */
export function recencyScore(mtimeMs: number | undefined, now: number, halfLifeMs: number): number {
  if (mtimeMs === undefined || !Number.isFinite(mtimeMs)) return 0;
  const age = Math.max(0, now - mtimeMs);
  return Math.min(1, 0.5 ** (age / halfLifeMs));
}

/** Directory segments of a path, excluding the filename. */
function directorySegments(path: string): string[] {
  const segments = path.replace(/\\/g, '/').split('/');
  segments.pop();
  return segments.filter((segment) => segment.length > 0);
}

/**
 * Proximity to the open file, in [0, 1].
 *
 * The same file scores 1. Otherwise it is the shared directory prefix over the
 * deeper of the two paths, plus one — so a sibling file scores below the file
 * itself, and a file in an unrelated tree scores 0.
 */
export function proximityScore(openFile: string | undefined, path: string): number {
  if (openFile === undefined || openFile.length === 0) return 0;
  const open = openFile.replace(/\\/g, '/');
  const candidate = path.replace(/\\/g, '/');
  if (open === candidate) return 1;

  const a = directorySegments(open);
  const b = directorySegments(candidate);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  const deepest = Math.max(a.length, b.length);
  if (deepest === 0) return 0;
  return shared / (deepest + 1);
}

/** One location a signal returned. Signals supply these ordered best-first. */
export interface RankCandidate {
  /** Path relative to the request root, forward slashes. */
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly snippet: string;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  readonly symbol?: SymbolInfo;
}

export interface RankInput {
  /** Per-signal candidate lists, each already ordered best-first. */
  readonly lists: ReadonlyMap<SignalName, readonly RankCandidate[]>;
  /** File modification times in epoch milliseconds, keyed by path. */
  readonly mtimes?: ReadonlyMap<string, number>;
  readonly openFile?: string;
  /** Injectable for deterministic tests. */
  readonly now?: number;
  readonly options?: RankingOptions;
}

export interface RankOutput {
  readonly results: readonly RetrievalResult[];
  readonly ranking: ResolvedRankingOptions;
  /** Signals that actually contributed at least one candidate. */
  readonly signalsUsed: readonly SignalName[];
}

interface Accumulator {
  candidate: RankCandidate;
  readonly ranks: Partial<Record<SignalName, number>>;
  readonly contributions: Partial<Record<SignalName, number>>;
}

/**
 * A result is a location, so two signals pointing at the same line fuse and a
 * call site on a different line stays separate.
 */
function locationKey(candidate: RankCandidate): string {
  return `${candidate.path}\u0000${candidate.line}`;
}

/**
 * Merge duplicate candidates for one location.
 *
 * Prefer whichever carries a symbol, since a symbol hit knows the declaration's
 * kind and scope and a lexical hit does not. Otherwise keep the first, which is
 * from the earlier (cheaper) signal.
 */
function mergeCandidate(existing: RankCandidate, incoming: RankCandidate): RankCandidate {
  if (existing.symbol !== undefined) return existing;
  if (incoming.symbol !== undefined) {
    return {
      ...incoming,
      snippet: existing.snippet.length > 0 ? existing.snippet : incoming.snippet,
    };
  }
  return existing;
}

/**
 * Accumulate per-signal ranks and contributions for every location.
 *
 * Split out of {@link fuseResults} so the two phases read separately: this one
 * records *what each signal said*, and {@link toResult} decides what that is
 * worth once the boosts apply.
 */
function accumulate(
  lists: RankInput['lists'],
  ranking: ResolvedRankingOptions,
): { readonly accumulators: Map<string, Accumulator>; readonly signalsUsed: SignalName[] } {
  const accumulators = new Map<string, Accumulator>();
  const signalsUsed: SignalName[] = [];

  for (const signal of ALL_SIGNALS) {
    const candidates = lists.get(signal);
    if (candidates === undefined || candidates.length === 0) continue;
    signalsUsed.push(signal);
    const weight = ranking.weights[signal];

    for (const [index, candidate] of candidates.entries()) {
      const rank = index + 1;
      const key = locationKey(candidate);
      const existing = accumulators.get(key);
      const accumulator: Accumulator = existing ?? { candidate, ranks: {}, contributions: {} };
      if (existing === undefined) accumulators.set(key, accumulator);
      else accumulator.candidate = mergeCandidate(accumulator.candidate, candidate);

      // A signal listing the same location twice keeps its best rank. Otherwise
      // a repeated hit would silently count twice.
      const existingRank = accumulator.ranks[signal];
      if (existingRank !== undefined && existingRank <= rank) continue;
      accumulator.ranks[signal] = rank;
      accumulator.contributions[signal] = weight / (ranking.k + rank);
    }
  }

  return { accumulators, signalsUsed };
}

interface BoostContext {
  readonly mtimes: RankInput['mtimes'];
  readonly openFile: string | undefined;
  readonly now: number;
}

/** Turn one accumulated location into a scored, fully attributed result. */
function toResult(
  accumulator: Accumulator,
  ranking: ResolvedRankingOptions,
  context: BoostContext,
): RetrievalResult {
  const { candidate } = accumulator;
  let fusion = 0;
  for (const value of Object.values(accumulator.contributions)) fusion += value;

  const recency = recencyScore(
    context.mtimes?.get(candidate.path),
    context.now,
    ranking.recencyHalfLifeMs,
  );
  const proximity = proximityScore(context.openFile, candidate.path);

  const signals: RetrievalSignals = {
    ranks: accumulator.ranks,
    contributions: accumulator.contributions,
    fusion,
    recency,
    proximity,
  };

  return {
    path: candidate.path,
    line: candidate.line,
    column: candidate.column,
    snippet: candidate.snippet,
    score: fusion * (1 + ranking.recencyWeight * recency + ranking.proximityWeight * proximity),
    signals,
    ...(candidate.before === undefined ? {} : { before: candidate.before }),
    ...(candidate.after === undefined ? {} : { after: candidate.after }),
    ...(candidate.symbol === undefined ? {} : { symbol: candidate.symbol }),
  };
}

/** Fuse per-signal candidate lists into one ranked, fully attributed list. */
export function fuseResults(input: RankInput): RankOutput {
  const ranking = resolveRankingOptions(input.options);
  const { accumulators, signalsUsed } = accumulate(input.lists, ranking);
  const context: BoostContext = {
    mtimes: input.mtimes,
    openFile: input.openFile,
    now: input.now ?? Date.now(),
  };

  const results = [...accumulators.values()].map((accumulator) =>
    toResult(accumulator, ranking, context),
  );

  // Ties break on path then line so a run is reproducible, which benchmark
  // reporting depends on.
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });

  return { results, ranking, signalsUsed };
}
