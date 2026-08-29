/**
 * @adze/retrieval — local-first hybrid code retrieval.
 *
 * Everything here runs on your machine. There is no network call in this package,
 * at any point, for any reason. That is the one product promise Adze can make
 * that the incumbent cannot — Cursor documents that it uploads code chunks to
 * compute embeddings and that requests route through its backend even with a
 * user-supplied API key — so it is enforced structurally rather than asserted:
 * grammar bytes are read with `fs.readFile` and never handed to a loader that
 * would accept a URL, and `test/no-network.test.ts` asserts no source file
 * imports a network module.
 *
 * Signal order is ADR-0006's conclusion from evidence, not taste. Agentic grep
 * plus symbol lookup outperforms vector search on most repositories, so:
 *
 * ```ts
 * import { LocalRetrievalProvider } from '@adze/retrieval';
 *
 * const retrieval = new LocalRetrievalProvider({ root: workspace });
 *
 * // Say what is actually available before relying on it.
 * const caps = await retrieval.capabilities();
 * // caps.symbolExtractor is 'tree-sitter' only if a grammar really loaded.
 *
 * const found = await retrieval.search({ query: 'retryWithBackoff' });
 * if (found.truncated) {
 *   // Never swallow this: the model is seeing a cut result set.
 * }
 * for (const hit of found.results) {
 *   // hit.signals shows every number that produced hit.score.
 * }
 *
 * const defs = await retrieval.definitions({ name: 'UserService' });
 * // defs.extractors reports how many files each extraction level handled.
 * ```
 *
 * **Semantic search is not implemented.** {@link VectorIndex} is an interface and
 * nothing else; ADR-0006 defers local vector search to a later milestone and
 * keeps it off until a workspace is explicitly indexed. This package ships no
 * vector dependency and no embedding code. See `docs/roadmap.md`.
 *
 * Design rationale: docs/architecture/adr/0006-retrieval.md
 */

// --- Chunking ---
export { chunkFile } from './chunk.js';
// --- Filesystem helpers ---
export type { WalkOptions, WalkResult } from './files.js';
export { modificationTimes, walkFiles } from './files.js';
// --- Grammars (lazy, local, WASM) ---
export type {
  GrammarLoad,
  GrammarOptions,
  GrammarProvider,
  LoadedGrammar,
  QueryCaptureLike,
  QueryMatchLike,
  SymbolQueryOutcome,
  SyntaxNodeLike,
} from './grammars.js';
export { GrammarRegistry, splitQueryPatterns } from './grammars.js';
// --- Language registry: adding a language is data plus a query ---
export type {
  BlockStyle,
  ContainerRule,
  HeuristicRule,
  LanguageDefinition,
} from './languages.js';
export {
  fileExtension,
  isNameCapture,
  kindFromCaptureName,
  LANGUAGES,
  languageById,
  languageForPath,
  supportedExtensions,
} from './languages.js';
// --- The provider ---
export type { LocalRetrievalProviderOptions } from './provider.js';
export { LocalRetrievalProvider } from './provider.js';
// --- Ranking ---
export type { RankCandidate, RankInput, RankOutput } from './rank.js';
export { fuseResults, proximityScore, recencyScore, resolveRankingOptions } from './rank.js';
// --- ripgrep ---
export type {
  RipgrepListFilesOptions,
  RipgrepListFilesResult,
  RipgrepMatch,
  RipgrepOptions,
  RipgrepSearchResult,
} from './ripgrep.js';
export {
  buildRipgrepArgs,
  byteOffsetToColumn,
  escapeRegex,
  normalizeRelativePath,
  RipgrepUnavailableError,
  resolveRipgrepPath,
  ripgrepListFiles,
  ripgrepSearch,
} from './ripgrep.js';
// --- Symbols ---
export type { SymbolServiceOptions } from './symbols.js';
export { extractSymbolsHeuristic, SymbolService, symbolsFromMatches } from './symbols.js';
// --- Text utilities ---
export type { LineSpan } from './text.js';
export { estimateTokens, indentWidth, indexLines, isBlank, toPosixPath } from './text.js';
// --- Public types ---
export type {
  CaseSensitivity,
  Chunk,
  ChunkKind,
  ChunkOptions,
  DefinitionHit,
  DefinitionRequest,
  DefinitionResponse,
  DiagnosticSource,
  RankingOptions,
  ResolvedRankingOptions,
  RetrievalCapabilities,
  RetrievalDiagnostic,
  RetrievalMode,
  RetrievalProvider,
  RetrievalRequest,
  RetrievalResponse,
  RetrievalResult,
  RetrievalSignals,
  SignalName,
  SourceRange,
  SymbolExtraction,
  SymbolExtractor,
  SymbolInfo,
  SymbolKind,
  TruncationReason,
  VectorHit,
  VectorIndex,
  VectorQuery,
} from './types.js';
// --- Vectors: interface only, deferred by ADR-0006 ---
export { semanticUnavailableDiagnostic, VECTOR_INDEX_DIRECTORY } from './vectors.js';
