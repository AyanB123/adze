/**
 * A hand-built syntax tree, so the tree-sitter code path is testable.
 *
 * Grammar WASM files are not vendored and are absent on a fresh clone, which is
 * exactly the environment CI runs in. Without this the `extractor: 'tree-sitter'`
 * branch — the one whose honesty the whole package depends on — would be
 * untested, and "we tested the fallback" is not the same claim.
 *
 * These stubs satisfy {@link SyntaxNodeLike} structurally, which is the same
 * contract a real `web-tree-sitter` `Node` satisfies. Nothing here runs in
 * production; `GrammarRegistry` is the only implementation that ships.
 *
 * Real grammars are exercised separately, gated on `ADZE_GRAMMAR_DIR`. See the
 * module comment in `src/grammars.ts` for the resolution order and how to build
 * a grammar.
 */

import type {
  GrammarProvider,
  QueryMatchLike,
  SymbolQueryOutcome,
  SyntaxNodeLike,
} from '../src/grammars.js';
import type { LanguageDefinition } from '../src/languages.js';

/** A node whose parent and named children can be wired after construction. */
export class StubNode implements SyntaxNodeLike {
  parent: SyntaxNodeLike | null = null;
  private readonly fields = new Map<string, StubNode>();

  constructor(
    readonly type: string,
    readonly text: string,
    readonly startPosition: { readonly row: number; readonly column: number },
    readonly endPosition: { readonly row: number; readonly column: number },
  ) {}

  /** Attach a named child, as a grammar field, and set its parent. */
  field(name: string, child: StubNode): this {
    this.fields.set(name, child);
    child.parent = this;
    return this;
  }

  /** Attach a child with no field name, only for ancestry. */
  contains(child: StubNode): this {
    child.parent = this;
    return this;
  }

  childForFieldName(field: string): SyntaxNodeLike | null {
    return this.fields.get(field) ?? null;
  }
}

/** Rows are 0-based, as tree-sitter reports them. */
export function node(
  type: string,
  text: string,
  start: readonly [number, number],
  end: readonly [number, number],
): StubNode {
  return new StubNode(
    type,
    text,
    { row: start[0], column: start[1] },
    { row: end[0], column: end[1] },
  );
}

/** A single-line node, positioned by locating its text in the source. */
export function lineNode(source: string, type: string, text: string, occurrence = 1): StubNode {
  const lines = source.split('\n');
  let seen = 0;
  for (const [row, line] of lines.entries()) {
    let from = 0;
    for (;;) {
      const column = line.indexOf(text, from);
      if (column === -1) break;
      seen++;
      if (seen === occurrence) {
        return node(type, text, [row, column], [row, column + text.length]);
      }
      from = column + 1;
    }
  }
  throw new Error(`stub: '${text}' occurrence ${occurrence} not found in source`);
}

export function match(
  patternIndex: number,
  captures: ReadonlyArray<readonly [string, StubNode]>,
): QueryMatchLike {
  return {
    patternIndex,
    captures: captures.map(([name, n]) => ({ name, node: n })),
  };
}

/**
 * A grammar provider driven by a callback.
 *
 * Records the sources it was asked about, so a test can assert that grammar work
 * happened lazily — or did not happen at all.
 */
export class StubGrammarProvider implements GrammarProvider {
  readonly calls: Array<{ readonly language: string; readonly source: string }> = [];
  disposed = false;

  constructor(
    private readonly respond: (
      definition: LanguageDefinition,
      source: string,
    ) => SymbolQueryOutcome,
  ) {}

  async querySymbols(definition: LanguageDefinition, source: string): Promise<SymbolQueryOutcome> {
    this.calls.push({ language: definition.id, source });
    return await Promise.resolve(this.respond(definition, source));
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** A provider that always reports the grammar as missing. */
export function missingGrammarProvider(
  message = "no grammar for TypeScript at '/nowhere/tree-sitter-typescript.wasm'",
): StubGrammarProvider {
  return new StubGrammarProvider(() => ({ ok: false, message }));
}

/** A provider that returns fixed matches, as a real successful parse would. */
export function succeedingProvider(
  matches: readonly QueryMatchLike[],
  extra: { readonly droppedPatterns?: number } = {},
): StubGrammarProvider {
  return new StubGrammarProvider(() => ({
    ok: true,
    matches,
    droppedPatterns: extra.droppedPatterns ?? 0,
    querySource: 'builtin',
  }));
}
