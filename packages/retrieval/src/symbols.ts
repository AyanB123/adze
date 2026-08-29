/**
 * Symbol extraction: "where is X defined", and the boundaries chunking needs.
 *
 * Two levels, and it degrades honestly — the same contract `@adze/apply` uses
 * for parse validation:
 *
 *   `tree-sitter`  a real parse. Requires a grammar WASM file to be present.
 *   `heuristic`    the documented regex scanner below. Always available.
 *   `none`         the language is not in the registry and we declined to guess.
 *
 * {@link SymbolExtraction.extractor} reports which level actually ran. That field
 * is a claim about evidence: benchmark reports depend on it, so it is never
 * widened from `heuristic` to `tree-sitter` for cosmetic reasons.
 *
 * # What the heuristic scanner does and does not do
 *
 * It is line-oriented. For each line it tries the language's rules in order and
 * takes the first match, tracking enclosing scope by brace depth or by
 * indentation. String literals, single-line block comments, and line comments are
 * removed before brace counting.
 *
 * It will therefore be wrong about: a declaration split across lines, a brace
 * inside a multi-line template literal or docstring, and a construct that simply
 * has no rule. It reports fewer symbols than a parse and occasionally a wrong
 * scope. It never blocks anything, because retrieval degrading to lexical-only is
 * a worse outcome than an approximate symbol list.
 */

import type { GrammarProvider, QueryMatchLike, SyntaxNodeLike } from './grammars.js';
import {
  isNameCapture,
  isTypeLikeKind,
  kindFromCaptureName,
  type LanguageDefinition,
  languageForPath,
} from './languages.js';
import { indentWidth, indexLines, isBlank, type LineSpan } from './text.js';
import type {
  SourceRange,
  SymbolExtraction,
  SymbolExtractor,
  SymbolInfo,
  SymbolKind,
} from './types.js';

/**
 * Compiled rule cache.
 *
 * Compiled **without** the global flag on purpose. A non-global `RegExp` carries
 * no `lastIndex`, so caching one is safe; caching a global one would make results
 * depend on how many times the rule had been used before.
 */
const RULE_CACHE = new Map<string, RegExp>();

function compileRule(pattern: string): RegExp {
  const cached = RULE_CACHE.get(pattern);
  if (cached !== undefined) return cached;
  const compiled = new RegExp(pattern);
  RULE_CACHE.set(pattern, compiled);
  return compiled;
}

/** Remove strings and comments so brace counting is not fooled by them. */
function codeOnly(line: string, lineComments: readonly string[]): string {
  let out = line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/\/\*.*?\*\//g, '');
  for (const marker of lineComments) {
    const at = out.indexOf(marker);
    if (at !== -1) out = out.slice(0, at);
  }
  return out;
}

function braceDelta(code: string): number {
  let delta = 0;
  for (const char of code) {
    if (char === '{') delta++;
    else if (char === '}') delta--;
  }
  return delta;
}

/** Last line of a brace-delimited block that starts on `startIndex`. */
function endOfBraceBlock(deltas: readonly number[], startIndex: number): number {
  let depth = deltas[startIndex] ?? 0;
  if (depth <= 0) return startIndex;
  for (let i = startIndex + 1; i < deltas.length; i++) {
    depth += deltas[i] ?? 0;
    if (depth <= 0) return i;
  }
  return deltas.length - 1;
}

/** Last line of an indentation-delimited block that starts on `startIndex`. */
function endOfIndentBlock(lines: readonly LineSpan[], startIndex: number): number {
  const start = lines[startIndex];
  if (start === undefined) return startIndex;
  const baseIndent = indentWidth(start.text);
  let end = startIndex;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    if (isBlank(line.text)) continue;
    if (indentWidth(line.text) <= baseIndent) break;
    end = i;
  }
  return end;
}

function rangeFromLines(
  lines: readonly LineSpan[],
  startLineIndex: number,
  startColumn: number,
  endLineIndex: number,
): SourceRange {
  const start = lines[startLineIndex];
  const end = lines[endLineIndex] ?? start;
  const startOffset = start?.start ?? 0;
  const endText = end?.text ?? '';
  return {
    startLine: startLineIndex + 1,
    startColumn: startColumn + 1,
    endLine: endLineIndex + 1,
    endColumn: endText.length + 1,
    startIndex: startOffset + startColumn,
    endIndex: end?.end ?? startOffset,
  };
}

/** An enclosing scope: its name, and what kind of thing it is. */
interface ScopeRef {
  readonly name: string;
  readonly kind: SymbolKind;
}

interface ScopeFrame extends ScopeRef {
  /** Brace depth to return to before this scope closes. */
  readonly closeDepth: number;
  /** Indentation width that closes this scope, for indent-style languages. */
  readonly indent: number;
}

/**
 * Decide whether a matched function should be reported as a method.
 *
 * Three things have to line up: the language says a method is syntactically a
 * nested function, the symbol is a function, and the enclosing scope is something
 * that can own methods. Without the third condition a free function inside a Rust
 * `mod` is reported as a method of that module, which is not a thing.
 */
function resolveKind(
  kind: SymbolKind,
  definition: LanguageDefinition,
  scope: ScopeRef | undefined,
): SymbolKind {
  if (!definition.promoteFunctionsToMethods) return kind;
  if (kind !== 'function' || scope === undefined) return kind;
  return isTypeLikeKind(scope.kind) ? 'method' : kind;
}

/** Pop scopes a dedent has closed, for indentation-style languages. */
function closeScopesByIndent(scopes: ScopeFrame[], currentIndent: number): void {
  while (scopes.length > 0) {
    const top = scopes[scopes.length - 1];
    if (top === undefined || top.indent < currentIndent) break;
    scopes.pop();
  }
}

/** Pop scopes whose brace depth has been returned to, for braces languages. */
function closeScopesByDepth(scopes: ScopeFrame[], depth: number): void {
  while (scopes.length > 0) {
    const top = scopes[scopes.length - 1];
    if (top === undefined || depth > top.closeDepth) break;
    scopes.pop();
  }
}

/**
 * The scope a matched declaration belongs to.
 *
 * An explicit scope capture — a Go method receiver, say — always names a type, so
 * it counts as one regardless of the surrounding frame.
 */
function scopeForMatch(matched: RuleMatch, scopes: readonly ScopeFrame[]): ScopeRef | undefined {
  if (matched.scope !== undefined) return { name: matched.scope, kind: 'type' };
  const enclosing = scopes[scopes.length - 1];
  return enclosing === undefined ? undefined : { name: enclosing.name, kind: enclosing.kind };
}

/** What the line scan needs that does not vary from line to line. */
interface HeuristicScan {
  readonly lines: readonly LineSpan[];
  readonly deltas: readonly number[];
  readonly definition: LanguageDefinition;
  /** True for brace-delimited languages, false for indentation-delimited ones. */
  readonly braces: boolean;
}

/** Where a match was found, which decides its range and the scope it opens. */
interface MatchPosition {
  readonly lineIndex: number;
  /** Brace depth before this line's delta is applied. */
  readonly depthBefore: number;
  readonly indent: number;
}

/**
 * Record what one matched declaration amounts to: a symbol, a scope, or both.
 *
 * The two effects are independent, which is why they are two conditions rather
 * than one branch. A `scopeOnly` rule — a Rust `impl` block is the motivating
 * case — opens a scope without being a symbol itself, while a leaf declaration
 * names a symbol without opening one.
 */
function recordMatch(
  matched: RuleMatch,
  at: MatchPosition,
  scan: HeuristicScan,
  symbols: SymbolInfo[],
  scopes: ScopeFrame[],
): void {
  const scope = scopeForMatch(matched, scopes);
  if (matched.rule.scopeOnly !== true) {
    const endLineIndex = scan.braces
      ? endOfBraceBlock(scan.deltas, at.lineIndex)
      : endOfIndentBlock(scan.lines, at.lineIndex);
    symbols.push({
      name: matched.name,
      kind: resolveKind(matched.kind, scan.definition, scope),
      range: rangeFromLines(scan.lines, at.lineIndex, matched.column, endLineIndex),
      ...(scope === undefined ? {} : { scope: scope.name }),
    });
  }
  if (matched.rule.container === true) {
    scopes.push({
      name: matched.name,
      kind: matched.kind,
      closeDepth: at.depthBefore,
      indent: at.indent,
    });
  }
}

/**
 * True when a line holds nothing but a comment.
 *
 * `code` has already had strings and comments stripped, so for a language that
 * has line comments an empty result means the line contributed no code.
 */
function isCommentOnlyLine(code: string | undefined, definition: LanguageDefinition): boolean {
  return definition.lineComments.length > 0 && (code ?? '').trim().length === 0;
}

/**
 * Scan for symbols using the language's regex rules.
 *
 * Exported so it can be tested directly, and so a caller that knows grammars are
 * absent can skip the load attempt entirely.
 */
export function extractSymbolsHeuristic(
  path: string,
  source: string,
  definition: LanguageDefinition,
): SymbolExtraction {
  const lines = indexLines(source);
  const codes = lines.map((line) => codeOnly(line.text, definition.lineComments));
  const deltas = codes.map(braceDelta);
  const deny = new Set(definition.heuristicDenyNames);
  const braces = definition.blockStyle === 'braces';
  const scan: HeuristicScan = { lines, deltas, definition, braces };
  const symbols: SymbolInfo[] = [];
  const scopes: ScopeFrame[] = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const depthBefore = depth;
    // Applied up front rather than at the end of the body: nothing below reads
    // `depth` except `closeScopesByDepth`, which wants the post-line value, and
    // `recordMatch`, which is given `depthBefore` explicitly.
    depth += deltas[i] ?? 0;

    if (isBlank(line.text)) continue;

    const indent = indentWidth(line.text);
    if (!braces) closeScopesByIndent(scopes, indent);

    const matched = isCommentOnlyLine(codes[i], definition)
      ? undefined
      : matchRule(line.text, definition, deny);
    if (matched !== undefined) {
      recordMatch(matched, { lineIndex: i, depthBefore, indent }, scan, symbols, scopes);
    }

    if (braces) closeScopesByDepth(scopes, depth);
  }

  return { path, language: definition.id, extractor: 'heuristic', symbols };
}

interface RuleMatch {
  readonly rule: LanguageDefinition['heuristics'][number];
  readonly name: string;
  readonly kind: SymbolKind;
  /** 0-based column of the name within the line. */
  readonly column: number;
  readonly scope?: string;
}

function matchRule(
  line: string,
  definition: LanguageDefinition,
  deny: ReadonlySet<string>,
): RuleMatch | undefined {
  for (const rule of definition.heuristics) {
    const match = compileRule(rule.pattern).exec(line);
    if (match === null) continue;
    const name = match[rule.nameGroup];
    if (name === undefined || name.length === 0) continue;
    if (deny.has(name)) continue;

    const scope = rule.scopeGroup === undefined ? undefined : match[rule.scopeGroup];
    // Locate the name within the line so the reported column points at the
    // identifier rather than at the start of the declaration.
    const column = Math.max(0, line.indexOf(name, match.index));
    return {
      rule,
      name,
      kind: rule.kind,
      column,
      ...(scope === undefined || scope.length === 0 ? {} : { scope }),
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// tree-sitter path
// ---------------------------------------------------------------------------

/**
 * Resolve a symbol's enclosing scope by walking ancestors for a container node.
 *
 * Driven entirely by {@link LanguageDefinition.containers}, so a new language
 * declares its containers as data rather than adding a branch here.
 */
function scopeFromAncestors(
  node: SyntaxNodeLike,
  definition: LanguageDefinition,
): ScopeRef | undefined {
  const byNode = new Map(definition.containers.map((rule) => [rule.node, rule] as const));
  let current = node.parent;
  while (current !== null) {
    const rule = byNode.get(current.type);
    if (rule !== undefined) {
      const nameNode = current.childForFieldName(rule.nameField);
      if (nameNode !== null && nameNode.text.length > 0) {
        return { name: nameNode.text, kind: rule.kind };
      }
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Column of `name` on `lineText`, given tree-sitter's reported column.
 *
 * The web binding's column is documented as a byte offset but is a UTF-16 code
 * unit offset for string input; the two agree for ASCII, which covers virtually
 * all identifiers. Rather than depend on which reading is current, verify the
 * reported column actually lands on the name and search the line if it does not.
 */
function columnOfName(lineText: string, reported: number, name: string): number {
  if (lineText.startsWith(name, reported)) return reported;
  const found = lineText.indexOf(name);
  return found === -1 ? Math.min(reported, lineText.length) : found;
}

/** What one query match's captures amount to, before ranges are computed. */
interface ReadCaptures {
  readonly kind: SymbolKind | undefined;
  readonly definitionNode: SyntaxNodeLike | undefined;
  readonly nameNode: SyntaxNodeLike | undefined;
  readonly explicitScope: string | undefined;
}

/**
 * Interpret one match's captures.
 *
 * A capture is one of three things: the node whose range is the symbol, the
 * identifier giving its name, or an explicit `@scope`. Anything else — including
 * a `definition.<kind>` whose kind is not a {@link SymbolKind} — is dropped,
 * because a typo in a contributed query should lose that capture rather than
 * invent a symbol kind.
 */
function readCaptures(match: QueryMatchLike): ReadCaptures {
  let kind: SymbolKind | undefined;
  let definitionNode: SyntaxNodeLike | undefined;
  let nameNode: SyntaxNodeLike | undefined;
  let explicitScope: string | undefined;

  for (const capture of match.captures) {
    if (capture.name === 'scope') {
      explicitScope ??= capture.node.text;
      continue;
    }
    const captureKind = kindFromCaptureName(capture.name);
    if (captureKind === undefined) continue;
    if (isNameCapture(capture.name)) {
      nameNode ??= capture.node;
    } else {
      definitionNode ??= capture.node;
    }
    kind ??= captureKind;
  }

  return { kind, definitionNode, nameNode, explicitScope };
}

/** Convert query matches into symbols, deduplicated by node span and name. */
export function symbolsFromMatches(
  matches: readonly QueryMatchLike[],
  lines: readonly LineSpan[],
  definition: LanguageDefinition,
): SymbolInfo[] {
  interface Candidate {
    readonly patternIndex: number;
    readonly symbol: SymbolInfo;
  }
  const byKey = new Map<string, Candidate>();
  const lastRow = Math.max(0, lines.length - 1);

  for (const match of matches) {
    const { kind, definitionNode, nameNode, explicitScope } = readCaptures(match);
    if (kind === undefined || nameNode === undefined) continue;
    const name = nameNode.text;
    if (name.length === 0) continue;

    const node = definitionNode ?? nameNode;
    const startRow = Math.min(node.startPosition.row, lastRow);
    const endRow = Math.min(node.endPosition.row, lastRow);
    const nameRow = Math.min(nameNode.startPosition.row, lastRow);
    const nameColumn = columnOfName(
      lines[nameRow]?.text ?? '',
      nameNode.startPosition.column,
      name,
    );
    const startColumn =
      node === nameNode
        ? nameColumn
        : Math.min(node.startPosition.column, (lines[startRow]?.text ?? '').length);

    const scope =
      explicitScope === undefined || explicitScope.length === 0
        ? scopeFromAncestors(nameNode, definition)
        : ({ name: explicitScope, kind: 'type' } as const);

    const symbol: SymbolInfo = {
      name,
      kind: resolveKind(kind, definition, scope),
      range: rangeFromLines(lines, startRow, startColumn, endRow),
      ...(scope === undefined ? {} : { scope: scope.name }),
    };

    // Two patterns can capture the same node — a `const` that holds an arrow
    // function matches both the function and the constant pattern. The earlier
    // pattern wins, which is why query order is documented as significant.
    const key = `${symbol.range.startIndex}:${symbol.range.endIndex}:${name}`;
    const existing = byKey.get(key);
    if (existing === undefined || match.patternIndex < existing.patternIndex) {
      byKey.set(key, { patternIndex: match.patternIndex, symbol });
    }
  }

  return [...byKey.values()]
    .map((candidate) => candidate.symbol)
    .sort((a, b) => a.range.startIndex - b.range.startIndex);
}

export interface SymbolServiceOptions {
  /** Omit to skip tree-sitter entirely and use the heuristic scanner. */
  readonly grammars?: GrammarProvider;
}

/**
 * Extracts symbols, preferring a real parse and falling back honestly.
 *
 * Failure reasons are cached per language so one missing grammar does not cost a
 * filesystem miss on every file, and so the provider can report *why* it
 * degraded rather than only that it did.
 */
export class SymbolService {
  private readonly grammars: GrammarProvider | undefined;
  private readonly fallbackReasons = new Map<string, string>();
  private sawRealParse = false;

  constructor(options: SymbolServiceOptions = {}) {
    this.grammars = options.grammars;
  }

  /** Reasons a language fell back, for reporting as diagnostics. */
  fallbackDiagnostics(): readonly string[] {
    return [...this.fallbackReasons.values()];
  }

  /**
   * The best extractor level that has *actually run* so far.
   *
   * Deliberately backward-looking. Reporting `tree-sitter` because a grammar
   * might load would be exactly the claim `ValidationResult.validator` in
   * `@adze/apply` forbids, so this answers `heuristic` until a real parse has
   * happened and been used.
   */
  bestObservedExtractor(): SymbolExtractor {
    return this.sawRealParse ? 'tree-sitter' : 'heuristic';
  }

  async extract(path: string, source: string): Promise<SymbolExtraction> {
    const definition = languageForPath(path);
    if (definition === undefined) {
      return {
        path,
        language: '',
        extractor: 'none',
        symbols: [],
        message: `no symbol support for '${path}'`,
      };
    }

    if (this.grammars === undefined) {
      return extractSymbolsHeuristic(path, source, definition);
    }

    const outcome = await this.grammars.querySymbols(definition, source);
    if (!outcome.ok) {
      this.fallbackReasons.set(definition.id, outcome.message);
      return {
        ...extractSymbolsHeuristic(path, source, definition),
        message: `${outcome.message}. Used the heuristic scanner instead.`,
      };
    }

    this.sawRealParse = true;
    const symbols = symbolsFromMatches(outcome.matches, indexLines(source), definition);
    return {
      path,
      language: definition.id,
      extractor: 'tree-sitter',
      symbols,
      ...(outcome.droppedPatterns > 0
        ? {
            message:
              `${outcome.droppedPatterns} query pattern(s) did not compile against the ` +
              `installed ${definition.displayName} grammar and were skipped.`,
          }
        : {}),
    };
  }

  dispose(): void {
    this.grammars?.dispose();
    this.fallbackReasons.clear();
  }
}
