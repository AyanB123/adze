/**
 * Local semantic search: interface only, deliberately unimplemented.
 *
 * ADR-0006 accepts local vector search as the *third* signal and defers it, for
 * two reasons worth restating because they are easy to lose:
 *
 * 1. **Ordering is a conclusion, not a preference.** Lexical search plus symbol
 *    lookup outperforms vector search on most repositories. Vectors earn their
 *    place for "find the thing I cannot name", which is real but a minority of
 *    queries. Building them first would invert the evidence.
 * 2. **A vector index makes a tool useless until it finishes building.** Keeping
 *    it off until a workspace is explicitly indexed is what makes the first run
 *    on a large repository usable at all.
 *
 * So this package ships **no vector dependency, no embedding code, and no index
 * format**. {@link VectorIndex} in `./types.ts` is the seam an implementation will
 * fill; `bench:retrieval` is what will decide whether it is worth filling. See
 * `docs/roadmap.md` for the milestone.
 *
 * Any future implementation is bound by two constraints from ADR-0006 that are
 * product promises rather than implementation details:
 *
 * - **Embeddings are computed locally by default.** A remote embedding provider
 *   is a deliberate configuration change that the CLI reports and the extension
 *   surfaces. This is the one privacy claim Adze can make that the incumbent
 *   cannot, and a convenience default would forfeit it permanently.
 * - **Index artifacts live under `.adze/index/`**, gitignored, and deleting the
 *   directory must break nothing.
 */

import type { RetrievalDiagnostic } from './types.js';

/**
 * Where a future index must live, relative to the workspace root.
 *
 * Exported so that when an implementation lands there is one definition of this
 * path rather than a string literal in three files.
 */
export const VECTOR_INDEX_DIRECTORY = '.adze/index';

/**
 * The diagnostic to return when semantic retrieval is requested and no
 * {@link VectorIndex} is available.
 *
 * A single function so the message cannot drift into implying the capability
 * exists. "Not implemented" and "not indexed" are different states and both are
 * reported as themselves.
 */
export function semanticUnavailableDiagnostic(
  reason: 'no-provider' | 'not-indexed',
): RetrievalDiagnostic {
  if (reason === 'not-indexed') {
    return {
      source: 'semantic',
      level: 'info',
      message:
        'semantic retrieval is off because this workspace has not been indexed. ' +
        'Indexing is explicit by design; lexical and symbol signals need no index.',
    };
  }
  return {
    source: 'semantic',
    level: 'info',
    message:
      'semantic retrieval is not implemented in this milestone. VectorIndex is an ' +
      'interface with no built-in implementation; supply one to enable the signal.',
  };
}
