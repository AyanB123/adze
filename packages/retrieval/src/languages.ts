/**
 * The language registry.
 *
 * # Adding a language
 *
 * Adding a language is **data plus a query**. There is no engine code to touch,
 * which is why `CONTRIBUTING.md` lists it as a good first contribution. Append a
 * {@link LanguageDefinition} to {@link LANGUAGES} with:
 *
 * 1. `id`, `extensions`, and `grammarFile` — the name of the compiled grammar,
 *    built with `npx tree-sitter build --wasm node_modules/tree-sitter-<lang>`.
 * 2. `symbolQuery` — a tree-sitter query in the standard *tags* convention, so a
 *    grammar's own `queries/tags.scm` can usually be adapted with light edits:
 *
 *    - `@definition.<kind>` captures the node whose range is the symbol.
 *    - `@name.definition.<kind>` captures the identifier giving its name.
 *    - `@scope` optionally captures an enclosing name the tree cannot supply by
 *      ancestry, such as a Go method receiver.
 *
 *    `<kind>` must be one of {@link SymbolKind}. Patterns are tried in order and
 *    an earlier pattern wins a tie on the same node, so put specific patterns
 *    first. Each top-level pattern is compiled **independently**: one pattern
 *    referring to a node type your grammar version does not have degrades that
 *    pattern, not the language.
 * 3. `heuristics` — regexes for the fallback scanner, so the language still works
 *    on a fresh clone with no grammars present.
 *
 * A query can also be overridden without rebuilding: drop `<id>.scm` beside the
 * grammar files and it is used instead of the built-in one. Fixing a query is
 * therefore a data change, which is the whole point.
 */

import type { SymbolKind } from './types.js';

/** How the fallback scanner decides where a block ends. */
export type BlockStyle = 'braces' | 'indent';

/**
 * A rule for the fallback scanner: one regex, applied to one line.
 *
 * The pattern is stored as a **string**, not a `RegExp`. A module-level `RegExp`
 * with the global flag carries `lastIndex` between calls, which turns shared
 * rules into an order-dependent bug. Compiling per scan costs nothing measurable
 * and removes the class of bug entirely.
 */
export interface HeuristicRule {
  readonly kind: SymbolKind;
  /** Regex source, matched against a single line without flags. */
  readonly pattern: string;
  /** Capture group holding the symbol name. */
  readonly nameGroup: number;
  /** Capture group holding an explicit scope name, e.g. a Go receiver type. */
  readonly scopeGroup?: number;
  /** When true, a match opens a named scope for the lines it encloses. */
  readonly container?: boolean;
  /**
   * When true the rule opens a scope but emits no symbol of its own. Rust's
   * `impl` blocks are the motivating case: they name a scope without being one.
   */
  readonly scopeOnly?: boolean;
}

/** A node type whose named child supplies an enclosing scope for descendants. */
export interface ContainerRule {
  readonly node: string;
  /** Field name holding the container's own name. */
  readonly nameField: string;
  /**
   * What sort of thing this container is.
   *
   * Read by {@link isTypeLikeKind} to decide whether a function nested inside it
   * is a method. A function inside a `struct`'s `impl` is a method; a function
   * inside a `mod` is not, and reporting one as a method is simply wrong.
   */
  readonly kind: SymbolKind;
}

export interface LanguageDefinition {
  readonly id: string;
  readonly displayName: string;
  /** Lower-case extensions without the dot. */
  readonly extensions: readonly string[];
  /** Expected filename of the compiled grammar inside the grammar directory. */
  readonly grammarFile: string;
  readonly symbolQuery: string;
  readonly containers: readonly ContainerRule[];
  /**
   * Report a `function` with a non-empty scope as a `method`. True for languages
   * where a method is syntactically just a function inside a type (Python, Rust);
   * false where the grammar has a distinct node (TypeScript, Go).
   */
  readonly promoteFunctionsToMethods: boolean;
  readonly blockStyle: BlockStyle;
  readonly heuristics: readonly HeuristicRule[];
  /**
   * Names the heuristic scanner must never emit. Without this, `if (x) {` reads
   * as a method called `if`.
   */
  readonly heuristicDenyNames: readonly string[];
  readonly lineComments: readonly string[];
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

const TS_QUERY = `
(class_declaration name: (type_identifier) @name.definition.class) @definition.class
(abstract_class_declaration name: (type_identifier) @name.definition.class) @definition.class
(interface_declaration name: (type_identifier) @name.definition.interface) @definition.interface
(type_alias_declaration name: (type_identifier) @name.definition.type) @definition.type
(enum_declaration name: (identifier) @name.definition.enum) @definition.enum
(internal_module name: (identifier) @name.definition.module) @definition.module
(method_definition name: (property_identifier) @name.definition.method) @definition.method
(abstract_method_signature name: (property_identifier) @name.definition.method) @definition.method
(function_declaration name: (identifier) @name.definition.function) @definition.function
(generator_function_declaration name: (identifier) @name.definition.function) @definition.function
(variable_declarator
  name: (identifier) @name.definition.function
  value: [(arrow_function) (function_expression)]) @definition.function
(variable_declarator name: (identifier) @name.definition.constant) @definition.constant
`;

const JS_QUERY = `
(class_declaration name: (identifier) @name.definition.class) @definition.class
(method_definition name: (property_identifier) @name.definition.method) @definition.method
(function_declaration name: (identifier) @name.definition.function) @definition.function
(generator_function_declaration name: (identifier) @name.definition.function) @definition.function
(variable_declarator
  name: (identifier) @name.definition.function
  value: [(arrow_function) (function_expression)]) @definition.function
(variable_declarator name: (identifier) @name.definition.constant) @definition.constant
`;

/** Identifier shape shared by TypeScript and JavaScript, including `$` and `_`. */
const JS_NAME = String.raw`[A-Za-z_$][\w$]*`;
const JS_MODIFIERS = String.raw`(?:export\s+)?(?:default\s+)?(?:declare\s+)?`;

const JS_HEURISTICS: readonly HeuristicRule[] = [
  {
    kind: 'class',
    pattern: String.raw`^\s*${JS_MODIFIERS}(?:abstract\s+)?class\s+(${JS_NAME})`,
    nameGroup: 1,
    container: true,
  },
  {
    kind: 'interface',
    pattern: String.raw`^\s*${JS_MODIFIERS}interface\s+(${JS_NAME})`,
    nameGroup: 1,
    container: true,
  },
  {
    kind: 'enum',
    pattern: String.raw`^\s*${JS_MODIFIERS}(?:const\s+)?enum\s+(${JS_NAME})`,
    nameGroup: 1,
    container: true,
  },
  {
    kind: 'module',
    pattern: String.raw`^\s*${JS_MODIFIERS}(?:namespace|module)\s+(${JS_NAME})`,
    nameGroup: 1,
    container: true,
  },
  {
    kind: 'type',
    pattern: String.raw`^\s*${JS_MODIFIERS}type\s+(${JS_NAME})\s*[<=]`,
    nameGroup: 1,
  },
  {
    kind: 'function',
    pattern: String.raw`^\s*${JS_MODIFIERS}(?:async\s+)?function\s*\*?\s*(${JS_NAME})`,
    nameGroup: 1,
  },
  // `const f = () => {}` and `const f = function () {}`. The arrow variant looks
  // for `=>` anywhere on the right-hand side, which also catches an object of
  // arrow functions — a function-valued binding either way.
  {
    kind: 'function',
    pattern: String.raw`^\s*${JS_MODIFIERS}(?:const|let|var)\s+(${JS_NAME})\s*(?::[^;]*)?=[^;]*=>`,
    nameGroup: 1,
  },
  {
    kind: 'function',
    pattern: String.raw`^\s*${JS_MODIFIERS}(?:const|let|var)\s+(${JS_NAME})\s*(?::[^;]*)?=\s*(?:async\s+)?function\b`,
    nameGroup: 1,
  },
  {
    kind: 'constant',
    pattern: String.raw`^\s*${JS_MODIFIERS}const\s+(${JS_NAME})`,
    nameGroup: 1,
  },
  {
    kind: 'variable',
    pattern: String.raw`^\s*${JS_MODIFIERS}(?:let|var)\s+(${JS_NAME})`,
    nameGroup: 1,
  },
  // A method must be indented (so it is inside something) and open a brace on
  // the same line. Both conditions cut the false-positive rate sharply.
  {
    kind: 'method',
    pattern: String.raw`^[ \t]+(?:(?:public|private|protected|static|abstract|readonly|override|async)\s+)*(?:(?:get|set)\s+)?\*?\s*(${JS_NAME})\s*(?:<[^>]*>)?\s*\(.*\)\s*(?::[^{;]*)?\s*\{`,
    nameGroup: 1,
  },
];

/**
 * Words the method rule would otherwise capture. `constructor` is intentionally
 * absent: it is a real method name.
 */
const JS_DENY: readonly string[] = [
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'catch',
  'try',
  'finally',
  'return',
  'throw',
  'new',
  'typeof',
  'instanceof',
  'await',
  'yield',
  'delete',
  'void',
  'in',
  'of',
  'with',
  'function',
  'class',
  'const',
  'let',
  'var',
  'import',
  'export',
  'default',
  'super',
  'this',
  'extends',
  'implements',
];

const JS_LINE_COMMENTS: readonly string[] = ['//'];

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PYTHON_QUERY = `
(class_definition name: (identifier) @name.definition.class) @definition.class
(function_definition name: (identifier) @name.definition.function) @definition.function
(assignment
  left: (identifier) @name.definition.constant
  (#match? @name.definition.constant "^[A-Z][A-Z0-9_]*$")) @definition.constant
`;

const PYTHON_HEURISTICS: readonly HeuristicRule[] = [
  {
    kind: 'class',
    pattern: String.raw`^\s*class\s+([A-Za-z_]\w*)`,
    nameGroup: 1,
    container: true,
  },
  {
    kind: 'function',
    pattern: String.raw`^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)`,
    nameGroup: 1,
  },
  // Module-level SCREAMING_CASE only. Anything else is a local, and reporting
  // every assignment as a symbol makes the symbol list useless.
  {
    kind: 'constant',
    pattern: String.raw`^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=(?!=)`,
    nameGroup: 1,
  },
];

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const GO_QUERY = `
(method_declaration
  receiver: (parameter_list
    (parameter_declaration
      type: [(type_identifier) @scope (pointer_type (type_identifier) @scope)]))
  name: (field_identifier) @name.definition.method) @definition.method
(method_declaration name: (field_identifier) @name.definition.method) @definition.method
(function_declaration name: (identifier) @name.definition.function) @definition.function
(type_spec name: (type_identifier) @name.definition.struct type: (struct_type)) @definition.struct
(type_spec
  name: (type_identifier) @name.definition.interface
  type: (interface_type)) @definition.interface
(type_spec name: (type_identifier) @name.definition.type) @definition.type
(const_spec name: (identifier) @name.definition.constant) @definition.constant
(var_spec name: (identifier) @name.definition.variable) @definition.variable
`;

const GO_HEURISTICS: readonly HeuristicRule[] = [
  {
    kind: 'method',
    pattern: String.raw`^func\s*\(\s*\w+\s+\*?([A-Za-z_]\w*)\s*\)\s*([A-Za-z_]\w*)`,
    nameGroup: 2,
    scopeGroup: 1,
  },
  { kind: 'function', pattern: String.raw`^func\s+([A-Za-z_]\w*)`, nameGroup: 1 },
  {
    kind: 'struct',
    pattern: String.raw`^\s*type\s+([A-Za-z_]\w*)\s+struct\b`,
    nameGroup: 1,
    container: true,
  },
  {
    kind: 'interface',
    pattern: String.raw`^\s*type\s+([A-Za-z_]\w*)\s+interface\b`,
    nameGroup: 1,
    container: true,
  },
  { kind: 'type', pattern: String.raw`^\s*type\s+([A-Za-z_]\w*)\s`, nameGroup: 1 },
  { kind: 'constant', pattern: String.raw`^\s*const\s+([A-Za-z_]\w*)`, nameGroup: 1 },
  { kind: 'variable', pattern: String.raw`^\s*var\s+([A-Za-z_]\w*)`, nameGroup: 1 },
];

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

const RUST_QUERY = `
(function_item name: (identifier) @name.definition.function) @definition.function
(struct_item name: (type_identifier) @name.definition.struct) @definition.struct
(enum_item name: (type_identifier) @name.definition.enum) @definition.enum
(union_item name: (type_identifier) @name.definition.struct) @definition.struct
(trait_item name: (type_identifier) @name.definition.trait) @definition.trait
(type_item name: (type_identifier) @name.definition.type) @definition.type
(const_item name: (identifier) @name.definition.constant) @definition.constant
(static_item name: (identifier) @name.definition.constant) @definition.constant
(mod_item name: (identifier) @name.definition.module) @definition.module
`;

/** `pub`, `pub(crate)`, `pub(in path)`. */
const RUST_VIS = String.raw`(?:pub(?:\([^)]*\))?\s+)?`;

const RUST_HEURISTICS: readonly HeuristicRule[] = [
  // `impl Trait for Type` and `impl Type` both name the scope their functions
  // belong to, without themselves being symbols.
  {
    kind: 'type',
    pattern: String.raw`^\s*impl(?:<[^>]*>)?\s+(?:[\w:]+(?:<[^>]*>)?\s+for\s+)?([A-Za-z_]\w*)`,
    nameGroup: 1,
    container: true,
    scopeOnly: true,
  },
  {
    kind: 'function',
    pattern: String.raw`^\s*${RUST_VIS}(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)`,
    nameGroup: 1,
  },
  {
    kind: 'struct',
    pattern: String.raw`^\s*${RUST_VIS}struct\s+([A-Za-z_]\w*)`,
    nameGroup: 1,
    container: true,
  },
  {
    kind: 'enum',
    pattern: String.raw`^\s*${RUST_VIS}enum\s+([A-Za-z_]\w*)`,
    nameGroup: 1,
    container: true,
  },
  {
    kind: 'trait',
    pattern: String.raw`^\s*${RUST_VIS}(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)`,
    nameGroup: 1,
    container: true,
  },
  { kind: 'type', pattern: String.raw`^\s*${RUST_VIS}type\s+([A-Za-z_]\w*)`, nameGroup: 1 },
  {
    kind: 'constant',
    pattern: String.raw`^\s*${RUST_VIS}(?:const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)`,
    nameGroup: 1,
  },
  {
    kind: 'module',
    pattern: String.raw`^\s*${RUST_VIS}mod\s+([A-Za-z_]\w*)`,
    nameGroup: 1,
    container: true,
  },
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const TS_CONTAINERS: readonly ContainerRule[] = [
  { node: 'class_declaration', nameField: 'name', kind: 'class' },
  { node: 'abstract_class_declaration', nameField: 'name', kind: 'class' },
  { node: 'interface_declaration', nameField: 'name', kind: 'interface' },
  { node: 'enum_declaration', nameField: 'name', kind: 'enum' },
  { node: 'internal_module', nameField: 'name', kind: 'module' },
];

/**
 * Starter languages. Four languages, six grammars: TypeScript ships `typescript`
 * and `tsx` as separate grammars, and JavaScript's grammar has no `interface` or
 * `type` nodes, so it needs its own query.
 */
export const LANGUAGES: readonly LanguageDefinition[] = [
  {
    id: 'typescript',
    displayName: 'TypeScript',
    extensions: ['ts', 'mts', 'cts'],
    grammarFile: 'tree-sitter-typescript.wasm',
    symbolQuery: TS_QUERY,
    containers: TS_CONTAINERS,
    promoteFunctionsToMethods: false,
    blockStyle: 'braces',
    heuristics: JS_HEURISTICS,
    heuristicDenyNames: JS_DENY,
    lineComments: JS_LINE_COMMENTS,
  },
  {
    id: 'tsx',
    displayName: 'TypeScript (JSX)',
    extensions: ['tsx'],
    grammarFile: 'tree-sitter-tsx.wasm',
    symbolQuery: TS_QUERY,
    containers: TS_CONTAINERS,
    promoteFunctionsToMethods: false,
    blockStyle: 'braces',
    heuristics: JS_HEURISTICS,
    heuristicDenyNames: JS_DENY,
    lineComments: JS_LINE_COMMENTS,
  },
  {
    id: 'javascript',
    displayName: 'JavaScript',
    extensions: ['js', 'mjs', 'cjs', 'jsx'],
    grammarFile: 'tree-sitter-javascript.wasm',
    symbolQuery: JS_QUERY,
    containers: [{ node: 'class_declaration', nameField: 'name', kind: 'class' }],
    promoteFunctionsToMethods: false,
    blockStyle: 'braces',
    heuristics: JS_HEURISTICS,
    heuristicDenyNames: JS_DENY,
    lineComments: JS_LINE_COMMENTS,
  },
  {
    id: 'python',
    displayName: 'Python',
    extensions: ['py', 'pyi'],
    grammarFile: 'tree-sitter-python.wasm',
    symbolQuery: PYTHON_QUERY,
    containers: [{ node: 'class_definition', nameField: 'name', kind: 'class' }],
    promoteFunctionsToMethods: true,
    blockStyle: 'indent',
    heuristics: PYTHON_HEURISTICS,
    heuristicDenyNames: [],
    lineComments: ['#'],
  },
  {
    id: 'go',
    displayName: 'Go',
    extensions: ['go'],
    grammarFile: 'tree-sitter-go.wasm',
    symbolQuery: GO_QUERY,
    containers: [],
    promoteFunctionsToMethods: false,
    blockStyle: 'braces',
    heuristics: GO_HEURISTICS,
    heuristicDenyNames: ['if', 'for', 'switch', 'select', 'range', 'return', 'go', 'defer'],
    lineComments: ['//'],
  },
  {
    id: 'rust',
    displayName: 'Rust',
    extensions: ['rs'],
    grammarFile: 'tree-sitter-rust.wasm',
    symbolQuery: RUST_QUERY,
    containers: [
      { node: 'struct_item', nameField: 'name', kind: 'struct' },
      { node: 'enum_item', nameField: 'name', kind: 'enum' },
      { node: 'trait_item', nameField: 'name', kind: 'trait' },
      { node: 'impl_item', nameField: 'type', kind: 'type' },
      // A `mod` names a scope without being a type, so a function inside one
      // stays a function. `promoteFunctionsToMethods` consults this kind.
      { node: 'mod_item', nameField: 'name', kind: 'module' },
    ],
    promoteFunctionsToMethods: true,
    blockStyle: 'braces',
    heuristics: RUST_HEURISTICS,
    heuristicDenyNames: ['if', 'else', 'for', 'while', 'loop', 'match', 'return', 'unsafe'],
    lineComments: ['//'],
  },
];

const BY_EXTENSION: ReadonlyMap<string, LanguageDefinition> = new Map(
  LANGUAGES.flatMap((language) =>
    language.extensions.map((extension) => [extension, language] as const),
  ),
);

const BY_ID: ReadonlyMap<string, LanguageDefinition> = new Map(
  LANGUAGES.map((language) => [language.id, language] as const),
);

/** Lower-cased extension of a path, without the dot. Empty when there is none. */
export function fileExtension(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** Look up a language by file path. Undefined when the extension is unknown. */
export function languageForPath(path: string): LanguageDefinition | undefined {
  return BY_EXTENSION.get(fileExtension(path));
}

export function languageById(id: string): LanguageDefinition | undefined {
  return BY_ID.get(id);
}

/** Every extension the registry recognises, for building glob filters. */
export function supportedExtensions(): readonly string[] {
  return [...BY_EXTENSION.keys()];
}

/**
 * Kinds that own methods.
 *
 * A function nested inside one of these is a method; a function nested inside a
 * `module` is still a function. This is the whole of the rule
 * {@link LanguageDefinition.promoteFunctionsToMethods} consults, and it is shared
 * so the heuristic scanner and the tree-sitter path cannot disagree about it.
 */
const TYPE_LIKE_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'class',
  'interface',
  'struct',
  'trait',
  'enum',
  'type',
]);

export function isTypeLikeKind(kind: SymbolKind): boolean {
  return TYPE_LIKE_KINDS.has(kind);
}

/** Kinds a capture name may resolve to, so an unknown capture is rejected. */
const KNOWN_KINDS: ReadonlySet<string> = new Set<SymbolKind>([
  'function',
  'method',
  'class',
  'interface',
  'type',
  'enum',
  'struct',
  'trait',
  'constant',
  'variable',
  'module',
  'property',
]);

/**
 * Parse `definition.class` or `name.definition.class` into its kind.
 *
 * Returns undefined for any other capture name, including a kind that is not in
 * {@link SymbolKind}. A typo in a contributed query should drop that capture,
 * not invent a symbol kind.
 */
export function kindFromCaptureName(captureName: string): SymbolKind | undefined {
  const marker = 'definition.';
  const at = captureName.lastIndexOf(marker);
  if (at === -1) return undefined;
  const kind = captureName.slice(at + marker.length);
  return KNOWN_KINDS.has(kind) ? (kind as SymbolKind) : undefined;
}

/** True for the capture that supplies a symbol's name rather than its range. */
export function isNameCapture(captureName: string): boolean {
  return captureName.startsWith('name.definition.');
}
