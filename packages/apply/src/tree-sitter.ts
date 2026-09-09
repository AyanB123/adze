/**
 * Tree-sitter validation for `@adze/apply`.
 *
 * Three properties matter here, and all three are the same discipline
 * `@adze/retrieval` follows in its own loader — duplicated, not shared, because
 * service packages must not import each other. If the two loaders drift, the plan
 * (P1.1) says to extract the shared piece into a package both depend on, under
 * its own ADR. Until then two loaders is wasteful rather than incorrect: Node
 * caches the `web-tree-sitter` module itself.
 *
 * **Lazy.** Nothing here runs until a caller actually asks for a real parse.
 * `web-tree-sitter` is imported dynamically, so on a fresh clone with no grammars
 * present the tree-sitter runtime WASM is never even read.
 *
 * **Local.** `Language.load` accepts a string, and a string can be a URL. We
 * never hand it one: grammar bytes are read from disk with `fs.readFile` and
 * passed as a `Uint8Array`. That makes "apply performs no network call" a
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
 * `.adze/` is gitignored and deletable: without it validation falls back to the
 * structural checker and says so in `ValidationResult.validator`.
 *
 * # What counts as a failure
 *
 * ADR-0005 commits to "a real parse. Reject on error nodes." A parse that
 * completed with an `ERROR` node or a `MISSING` node anywhere in the tree is a
 * rejection. Anything else — no grammar mapping for the language, no file at the
 * resolved path, a runtime that would not start, a parse that produced no tree —
 * is not a verdict about the content at all, so this module returns `undefined`
 * and the caller falls back rather than branching on an exception.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Language, Parser, Tree, TreeCursor } from 'web-tree-sitter';
import type { ValidationResult } from './types.js';

export interface GrammarOptions {
  /** Directory holding `tree-sitter-*.wasm` files. */
  readonly directory?: string;
  /** Explicit per-language absolute paths. Takes precedence over `directory`. */
  readonly files?: Readonly<Record<string, string>>;
  /**
   * Workspace root, used for the `<root>/.adze/grammars` default. Defaults to
   * the current working directory.
   */
  readonly root?: string;
}

/**
 * File extension (as `detectLanguage` reports it) to compiled grammar filename.
 *
 * Only languages with a known-good WASM build are listed. An extension absent
 * here never touches the filesystem: validation falls back without a miss.
 */
const GRAMMAR_FILES: Readonly<Record<string, string>> = {
  ts: 'tree-sitter-typescript.wasm',
  mts: 'tree-sitter-typescript.wasm',
  cts: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  js: 'tree-sitter-javascript.wasm',
  mjs: 'tree-sitter-javascript.wasm',
  cjs: 'tree-sitter-javascript.wasm',
  jsx: 'tree-sitter-javascript.wasm',
  py: 'tree-sitter-python.wasm',
  pyi: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rs: 'tree-sitter-rust.wasm',
};

/**
 * Compiled grammar filename for a language, or undefined when apply has no
 * grammar mapping for it. Pure, so tests can pin the convention without grammars.
 */
export function grammarFileForLanguage(language: string): string | undefined {
  return GRAMMAR_FILES[language];
}

/** Candidate directory for grammar files, in resolution order. */
export function resolveGrammarDirectory(options: GrammarOptions): string {
  if (options.directory !== undefined) return options.directory;
  const fromEnvironment = process.env.ADZE_GRAMMAR_DIR;
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) return fromEnvironment;
  return join(options.root ?? process.cwd(), '.adze', 'grammars');
}

/**
 * Absolute grammar path for a language, or undefined when the language has no
 * mapping. Pure, so the resolution order is testable with no filesystem.
 */
export function resolveGrammarPath(language: string, options: GrammarOptions): string | undefined {
  const file = grammarFileForLanguage(language);
  if (file === undefined) return undefined;
  const explicit = options.files?.[language];
  if (explicit !== undefined) return explicit;
  return join(resolveGrammarDirectory(options), file);
}

type TreeSitterModule = typeof import('web-tree-sitter');

type LoadedParser = { readonly ok: true; readonly parser: Parser } | { readonly ok: false };

let modulePromise: Promise<TreeSitterModule | undefined> | undefined;
/**
 * Parsers by absolute grammar path. A failed load is cached too: retrying a
 * missing file on every request would turn one absent grammar into a filesystem
 * miss on every edit.
 */
const parserCache = new Map<string, Promise<LoadedParser>>();

/**
 * Load `web-tree-sitter` and initialise it once.
 *
 * Returns undefined rather than throwing when the runtime cannot start, so a
 * broken WASM environment degrades to the structural checker.
 */
async function treeSitter(): Promise<TreeSitterModule | undefined> {
  modulePromise ??= (async (): Promise<TreeSitterModule | undefined> => {
    try {
      const module = await import('web-tree-sitter');
      await module.Parser.init();
      return module;
    } catch {
      return undefined;
    }
  })();
  return modulePromise;
}

/** Load a grammar and bind a parser to it. Cached, including failures. */
async function loadParser(grammarPath: string): Promise<LoadedParser> {
  const cached = parserCache.get(grammarPath);
  if (cached !== undefined) return cached;

  const pending = (async (): Promise<LoadedParser> => {
    const module = await treeSitter();
    if (module === undefined) return { ok: false };

    let bytes: Uint8Array;
    try {
      // Read the bytes ourselves. `Language.load` would accept a string, and a
      // string can be a URL — this is the line that makes a network fetch
      // impossible rather than merely unlikely.
      bytes = await readFile(grammarPath);
    } catch {
      return { ok: false };
    }

    let language: Language;
    try {
      language = await module.Language.load(bytes);
    } catch {
      return { ok: false };
    }

    try {
      const parser = new module.Parser();
      parser.setLanguage(language);
      return { ok: true, parser };
    } catch {
      return { ok: false };
    }
  })();

  parserCache.set(grammarPath, pending);
  return pending;
}

interface SyntaxProblem {
  readonly line: number;
  readonly message: string;
}

/**
 * First syntax problem in document order.
 *
 * The walk is pre-order, so start positions are non-decreasing and the first
 * problem found is the earliest and outermost — the diagnostic a model can most
 * usefully retry against. A cursor walk keeps this iterative: validation runs on
 * every edit, including adversarially nested files.
 */
function firstProblem(cursor: TreeCursor): SyntaxProblem | undefined {
  for (;;) {
    if (cursor.nodeIsMissing) {
      return {
        line: cursor.startPosition.row + 1,
        message: `missing '${cursor.nodeType}'`,
      };
    }
    if (cursor.nodeType === 'ERROR' || cursor.currentNode.isError) {
      return { line: cursor.startPosition.row + 1, message: 'syntax error' };
    }
    if (cursor.gotoFirstChild()) continue;
    for (;;) {
      if (cursor.gotoNextSibling()) break;
      if (!cursor.gotoParent()) return undefined;
    }
  }
}

/**
 * The only place in this package that reports the tree-sitter level.
 *
 * Widening `structural` to `tree-sitter` anywhere else must require editing this
 * function, not scattering another literal — `test/tree-sitter.test.ts` pins
 * that there is exactly one.
 */
function treeSitterResult(ok: boolean, message?: string, line?: number): ValidationResult {
  return {
    ok,
    validator: 'tree-sitter',
    ...(message === undefined ? {} : { message }),
    ...(line === undefined ? {} : { line }),
  };
}

/**
 * Parse `content` with the grammar for `language`.
 *
 * Returns undefined whenever no parse completed — no mapping, no file, a runtime
 * that would not start, a corrupt grammar, a parse that produced no tree — so
 * the caller falls back to the structural checker. Returns a `tree-sitter`
 * result only when a parse actually completed: `ok: true` for a clean tree,
 * `ok: false` naming the first error or missing node.
 */
export async function validateTreeSitter(
  content: string,
  language: string,
  options: GrammarOptions = {},
): Promise<ValidationResult | undefined> {
  const grammarPath = resolveGrammarPath(language, options);
  if (grammarPath === undefined) return undefined;

  const loaded = await loadParser(grammarPath);
  if (!loaded.ok) return undefined;

  let tree: Tree | null;
  try {
    tree = loaded.parser.parse(content);
  } catch {
    return undefined;
  }
  if (tree === null) return undefined;

  try {
    if (!tree.rootNode.hasError) return treeSitterResult(true);
    const cursor = tree.rootNode.walk();
    try {
      const problem = firstProblem(cursor);
      if (problem === undefined) {
        // An error flag with no locatable node is still a completed parse that
        // found something wrong: reject, without inventing a line number.
        return treeSitterResult(false, 'syntax error');
      }
      return treeSitterResult(false, problem.message, problem.line);
    } finally {
      cursor.delete();
    }
  } finally {
    tree.delete();
  }
}
