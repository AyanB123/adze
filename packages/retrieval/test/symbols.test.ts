/**
 * Symbol extraction tests.
 *
 * The contract under test is the honesty one, and it is the same contract
 * `ValidationResult.validator` carries in `@adze/apply`:
 * `SymbolExtraction.extractor` reports the level that *actually ran*. So every
 * language is asserted twice — once through the heuristic scanner, once through
 * the tree-sitter path — and each asserts the reported level as well as the
 * symbols. A test that only checked symbols would pass on a package that lied
 * about how it found them, which is the failure mode that matters here because
 * benchmark reports read that field.
 *
 * The tree-sitter path is driven by a hand-built tree (see `./tree-stub.ts`)
 * because grammar WASM files are absent on a fresh clone. Tests against real
 * grammars are at the bottom, gated on `ADZE_GRAMMAR_DIR`.
 */

import { describe, expect, it } from 'vitest';
import { GrammarRegistry } from '../src/grammars.js';
import { languageById, languageForPath } from '../src/languages.js';
import { extractSymbolsHeuristic, SymbolService, symbolsFromMatches } from '../src/symbols.js';
import { indexLines } from '../src/text.js';
import type { SymbolInfo, SymbolKind } from '../src/types.js';
import {
  lineNode,
  match,
  missingGrammarProvider,
  node,
  StubGrammarProvider,
  succeedingProvider,
} from './tree-stub.js';

function definitionFor(path: string) {
  const definition = languageForPath(path);
  if (definition === undefined) throw new Error(`no language registered for '${path}'`);
  return definition;
}

/** `name:kind` pairs, the shape most assertions want. */
function named(symbols: readonly SymbolInfo[]): string[] {
  return symbols.map((s) => `${s.name}:${s.kind}`);
}

function find(symbols: readonly SymbolInfo[], name: string): SymbolInfo | undefined {
  return symbols.find((s) => s.name === name);
}

// ---------------------------------------------------------------------------
// Heuristic scanner — always available, must always say it is what ran
// ---------------------------------------------------------------------------

const TS_SOURCE = [
  "import { thing } from './thing.js';",
  '',
  'export interface Repo {',
  '  find(id: string): string;',
  '}',
  '',
  'export type Id = string;',
  '',
  'export class UserService {',
  '  constructor(private readonly repo: Repo) {}',
  '',
  '  async findUser(id: string): Promise<string> {',
  '    return this.repo.find(id);',
  '  }',
  '}',
  '',
  'export function retryWithBackoff(attempts: number): void {',
  '  if (attempts > 0) {',
  '    work();',
  '  }',
  '}',
  '',
  'export const withTimeout = async (ms: number): Promise<void> => {',
  '  await sleep(ms);',
  '};',
  '',
  'export const MAX = 10;',
  '',
  'export enum Mode { A, B }',
  '',
].join('\n');

describe('extractSymbolsHeuristic — TypeScript', () => {
  const extraction = extractSymbolsHeuristic('src/a.ts', TS_SOURCE, definitionFor('src/a.ts'));

  it('reports heuristic as the level that ran, never tree-sitter', () => {
    expect(extraction.extractor).toBe('heuristic');
    expect(extraction.language).toBe('typescript');
  });

  it('finds declarations of each kind', () => {
    expect(named(extraction.symbols)).toEqual([
      'Repo:interface',
      'Id:type',
      'UserService:class',
      'constructor:method',
      'findUser:method',
      'retryWithBackoff:function',
      'withTimeout:function',
      'MAX:constant',
      'Mode:enum',
    ]);
  });

  it('attributes methods to their enclosing class', () => {
    expect(find(extraction.symbols, 'findUser')?.scope).toBe('UserService');
    expect(find(extraction.symbols, 'retryWithBackoff')?.scope).toBeUndefined();
  });

  it('reports a symbol range that spans its whole body', () => {
    const service = find(extraction.symbols, 'UserService');
    expect(service?.range.startLine).toBe(9);
    expect(service?.range.endLine).toBe(15);
  });

  it('points the column at the identifier, not at the start of the line', () => {
    const retry = find(extraction.symbols, 'retryWithBackoff');
    const line = TS_SOURCE.split('\n')[16] ?? '';
    expect(retry?.range.startColumn).toBe(line.indexOf('retryWithBackoff') + 1);
  });

  it('classifies an arrow-function binding as a function, not a constant', () => {
    // Rule order decides this, and getting it backwards makes every helper in a
    // modern codebase look like a value.
    expect(find(extraction.symbols, 'withTimeout')?.kind).toBe('function');
  });

  it('does not mistake a control-flow keyword for a method', () => {
    // `if (attempts > 0) {` is indented and opens a brace, so the method rule
    // matches it. The deny list is the only thing standing between that and a
    // symbol called `if`.
    expect(find(extraction.symbols, 'if')).toBeUndefined();
    expect(find(extraction.symbols, 'for')).toBeUndefined();
  });

  it('ignores a declaration that appears inside a comment', () => {
    const source = '// export function ghost(): void {}\nexport function real(): void {}\n';
    const out = extractSymbolsHeuristic('a.ts', source, definitionFor('a.ts'));
    expect(named(out.symbols)).toEqual(['real:function']);
  });

  it('does not count braces inside a string literal', () => {
    const source = [
      'export class Holder {',
      '  render(): string {',
      '    return "{{{";',
      '  }',
      '}',
      'export function after(): void {}',
      '',
    ].join('\n');
    const out = extractSymbolsHeuristic('a.ts', source, definitionFor('a.ts'));
    // If the string's braces were counted, `after` would land inside Holder.
    expect(find(out.symbols, 'after')?.scope).toBeUndefined();
    expect(find(out.symbols, 'render')?.scope).toBe('Holder');
  });
});

describe('extractSymbolsHeuristic — JavaScript', () => {
  const source = [
    'class Widget {',
    '  render() {',
    '    return 1;',
    '  }',
    '}',
    '',
    'function helper() {}',
    '',
    'const arrow = () => {};',
    '',
    'const NAME = "x";',
    '',
  ].join('\n');
  const extraction = extractSymbolsHeuristic('src/w.js', source, definitionFor('src/w.js'));

  it('reports the heuristic level and the javascript language', () => {
    expect(extraction.extractor).toBe('heuristic');
    expect(extraction.language).toBe('javascript');
  });

  it('finds classes, methods, functions, and constants', () => {
    expect(named(extraction.symbols)).toEqual([
      'Widget:class',
      'render:method',
      'helper:function',
      'arrow:function',
      'NAME:constant',
    ]);
    expect(find(extraction.symbols, 'render')?.scope).toBe('Widget');
  });

  it('treats .jsx and .mjs as JavaScript', () => {
    expect(languageForPath('a.jsx')?.id).toBe('javascript');
    expect(languageForPath('a.mjs')?.id).toBe('javascript');
    expect(languageForPath('a.tsx')?.id).toBe('tsx');
  });
});

describe('extractSymbolsHeuristic — Python', () => {
  const source = [
    'import os',
    '',
    'MAX_RETRIES = 3',
    'lowercase_local = 1',
    '',
    'class UserService:',
    '    def __init__(self, repo):',
    '        self.repo = repo',
    '',
    '    def find_user(self, id):',
    '        return self.repo.find(id)',
    '',
    'def retry_with_backoff(attempts):',
    '    return attempts',
    '',
    'async def fetch(url):',
    '    return url',
    '',
  ].join('\n');
  const extraction = extractSymbolsHeuristic('src/svc.py', source, definitionFor('src/svc.py'));

  it('reports the heuristic level', () => {
    expect(extraction.extractor).toBe('heuristic');
    expect(extraction.language).toBe('python');
  });

  it('promotes a function inside a class to a method', () => {
    expect(named(extraction.symbols)).toEqual([
      'MAX_RETRIES:constant',
      'UserService:class',
      '__init__:method',
      'find_user:method',
      'retry_with_backoff:function',
      'fetch:function',
    ]);
    expect(find(extraction.symbols, 'find_user')?.scope).toBe('UserService');
  });

  it('reports only module-level SCREAMING_CASE as a constant', () => {
    // Every assignment being a symbol makes the symbol list useless.
    expect(find(extraction.symbols, 'lowercase_local')).toBeUndefined();
  });

  it('closes an indentation scope on dedent', () => {
    expect(find(extraction.symbols, 'retry_with_backoff')?.scope).toBeUndefined();
  });

  it('ends a class range at the last indented line', () => {
    const service = find(extraction.symbols, 'UserService');
    expect(service?.range.startLine).toBe(6);
    expect(service?.range.endLine).toBe(11);
  });
});

describe('extractSymbolsHeuristic — Go', () => {
  const source = [
    'package main',
    '',
    'type UserService struct {',
    '\trepo Repo',
    '}',
    '',
    'type Repo interface {',
    '\tFind(id string) string',
    '}',
    '',
    'func (s *UserService) FindUser(id string) string {',
    '\treturn s.repo.Find(id)',
    '}',
    '',
    'func RetryWithBackoff(n int) error {',
    '\treturn nil',
    '}',
    '',
    'const MaxRetries = 3',
    '',
    'var counter = 0',
    '',
    'type Id = string',
    '',
  ].join('\n');
  const extraction = extractSymbolsHeuristic('main.go', source, definitionFor('main.go'));

  it('reports the heuristic level', () => {
    expect(extraction.extractor).toBe('heuristic');
    expect(extraction.language).toBe('go');
  });

  it('reads a method receiver as the enclosing type', () => {
    // Go's receiver is the only place the scope comes from the declaration itself
    // rather than from nesting, which is why HeuristicRule has a scopeGroup.
    const method = find(extraction.symbols, 'FindUser');
    expect(method?.kind).toBe('method');
    expect(method?.scope).toBe('UserService');
  });

  it('distinguishes struct, interface, and alias type declarations', () => {
    expect(find(extraction.symbols, 'UserService')?.kind).toBe('struct');
    expect(find(extraction.symbols, 'Repo')?.kind).toBe('interface');
    expect(find(extraction.symbols, 'Id')?.kind).toBe('type');
  });

  it('finds package-level functions, constants, and variables', () => {
    expect(find(extraction.symbols, 'RetryWithBackoff')?.kind).toBe('function');
    expect(find(extraction.symbols, 'MaxRetries')?.kind).toBe('constant');
    expect(find(extraction.symbols, 'counter')?.kind).toBe('variable');
  });
});

describe('extractSymbolsHeuristic — Rust', () => {
  const source = [
    'use std::collections::HashMap;',
    '',
    'pub struct UserService {',
    '    repo: HashMap<String, String>,',
    '}',
    '',
    'pub trait Repo {',
    '    fn find(&self, id: &str) -> String;',
    '}',
    '',
    'impl UserService {',
    '    pub fn find_user(&self, id: &str) -> String {',
    '        String::new()',
    '    }',
    '}',
    '',
    'impl Repo for UserService {',
    '    fn find(&self, id: &str) -> String {',
    '        String::new()',
    '    }',
    '}',
    '',
    'pub fn retry_with_backoff(n: u32) -> u32 {',
    '    n',
    '}',
    '',
    'pub const MAX: u32 = 10;',
    '',
    'pub mod deep {',
    '    pub fn inner() {}',
    '}',
    '',
  ].join('\n');
  const extraction = extractSymbolsHeuristic('src/lib.rs', source, definitionFor('src/lib.rs'));

  it('reports the heuristic level', () => {
    expect(extraction.extractor).toBe('heuristic');
    expect(extraction.language).toBe('rust');
  });

  it('attributes an impl block method to the type it implements for', () => {
    // `impl Repo for UserService` names UserService as the scope, not Repo, and
    // the impl block itself is not a symbol.
    const inherent = extraction.symbols.find(
      (s) => s.name === 'find_user' && s.scope === 'UserService',
    );
    expect(inherent?.kind).toBe('method');
    const implemented = extraction.symbols.filter(
      (s) => s.name === 'find' && s.scope === 'UserService',
    );
    expect(implemented).toHaveLength(1);
  });

  it('does not emit the impl block as a symbol of its own', () => {
    expect(extraction.symbols.filter((s) => s.kind === 'type')).toHaveLength(0);
  });

  it('keeps a free function inside a mod a function, not a method', () => {
    // A `mod` names a scope without being a type. Promoting here would report
    // `inner` as a method of a module, which is not a thing that exists.
    const inner = find(extraction.symbols, 'inner');
    expect(inner?.kind).toBe('function');
    expect(inner?.scope).toBe('deep');
  });

  it('finds structs, traits, constants, and modules', () => {
    expect(find(extraction.symbols, 'UserService')?.kind).toBe('struct');
    expect(find(extraction.symbols, 'Repo')?.kind).toBe('trait');
    expect(find(extraction.symbols, 'MAX')?.kind).toBe('constant');
    expect(find(extraction.symbols, 'deep')?.kind).toBe('module');
  });

  it('accepts every visibility spelling', () => {
    const visibilities = [
      'pub fn a() {}',
      'pub(crate) fn b() {}',
      'pub(in crate::x) fn c() {}',
      'fn d() {}',
      'pub async unsafe fn e() {}',
      'pub const fn f() {}',
      '',
    ].join('\n');
    const out = extractSymbolsHeuristic('l.rs', visibilities, definitionFor('l.rs'));
    expect(out.symbols.map((s) => s.name)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

// ---------------------------------------------------------------------------
// tree-sitter path — asserted through a hand-built tree
// ---------------------------------------------------------------------------

describe('symbolsFromMatches', () => {
  const source = ['class UserService {', '  findUser(id) {}', '}', ''].join('\n');
  const lines = indexLines(source);
  const typescript = definitionFor('a.ts');

  it('builds a symbol from a definition capture and a name capture', () => {
    const nameNode = lineNode(source, 'type_identifier', 'UserService');
    const classNode = node('class_declaration', source, [0, 0], [2, 1]).field('name', nameNode);
    const symbols = symbolsFromMatches(
      [
        match(0, [
          ['definition.class', classNode],
          ['name.definition.class', nameNode],
        ]),
      ],
      lines,
      typescript,
    );
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('UserService');
    expect(symbols[0]?.kind).toBe('class');
    expect(symbols[0]?.range.startLine).toBe(1);
    expect(symbols[0]?.range.endLine).toBe(3);
  });

  it('resolves scope by walking ancestors declared as containers', () => {
    const className = lineNode(source, 'type_identifier', 'UserService');
    const classNode = node('class_declaration', source, [0, 0], [2, 1]).field('name', className);
    const methodName = lineNode(source, 'property_identifier', 'findUser');
    const methodNode = node('method_definition', '  findUser(id) {}', [1, 2], [1, 17]).field(
      'name',
      methodName,
    );
    classNode.contains(methodNode);

    const symbols = symbolsFromMatches(
      [
        match(0, [
          ['definition.method', methodNode],
          ['name.definition.method', methodName],
        ]),
      ],
      lines,
      typescript,
    );
    expect(symbols[0]?.scope).toBe('UserService');
  });

  it('prefers an earlier pattern when two patterns capture the same node', () => {
    // `const f = () => {}` matches both the function pattern and the constant
    // pattern. Query order is documented as significant; this is that promise.
    const src = 'const withTimeout = () => {};\n';
    const srcLines = indexLines(src);
    const nameNode = lineNode(src, 'identifier', 'withTimeout');
    const declarator = node('variable_declarator', 'withTimeout = () => {}', [0, 6], [0, 28]).field(
      'name',
      nameNode,
    );
    const symbols = symbolsFromMatches(
      [
        match(11, [
          ['definition.function', declarator],
          ['name.definition.function', nameNode],
        ]),
        match(12, [
          ['definition.constant', declarator],
          ['name.definition.constant', nameNode],
        ]),
      ],
      srcLines,
      typescript,
    );
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.kind).toBe('function');
  });

  it('reads an explicit @scope capture, as a Go method receiver needs', () => {
    const src = 'func (s *UserService) FindUser(id string) string {\n}\n';
    const srcLines = indexLines(src);
    const go = definitionFor('a.go');
    const receiver = lineNode(src, 'type_identifier', 'UserService');
    const nameNode = lineNode(src, 'field_identifier', 'FindUser');
    const methodNode = node('method_declaration', src, [0, 0], [1, 1]).field('name', nameNode);
    const symbols = symbolsFromMatches(
      [
        match(0, [
          ['definition.method', methodNode],
          ['name.definition.method', nameNode],
          ['scope', receiver],
        ]),
      ],
      srcLines,
      go,
    );
    expect(symbols[0]?.scope).toBe('UserService');
    expect(symbols[0]?.kind).toBe('method');
  });

  it('promotes a nested function to a method only inside a type', () => {
    const src = ['class C:', '    def m(self):', '        pass', ''].join('\n');
    const srcLines = indexLines(src);
    const python = definitionFor('a.py');
    const className = lineNode(src, 'identifier', 'C');
    const classNode = node('class_definition', src, [0, 0], [2, 12]).field('name', className);
    const fnName = lineNode(src, 'identifier', 'm');
    const fnNode = node('function_definition', 'def m(self):', [1, 4], [2, 12]).field(
      'name',
      fnName,
    );
    classNode.contains(fnNode);

    const symbols = symbolsFromMatches(
      [
        match(0, [
          ['definition.function', fnNode],
          ['name.definition.function', fnName],
        ]),
      ],
      srcLines,
      python,
    );
    expect(symbols[0]?.kind).toBe('method');
    expect(symbols[0]?.scope).toBe('C');
  });

  it('leaves a function inside a Rust mod a function', () => {
    const src = ['pub mod deep {', '    pub fn inner() {}', '}', ''].join('\n');
    const srcLines = indexLines(src);
    const rust = definitionFor('a.rs');
    const modName = lineNode(src, 'identifier', 'deep');
    const modNode = node('mod_item', src, [0, 0], [2, 1]).field('name', modName);
    const fnName = lineNode(src, 'identifier', 'inner');
    const fnNode = node('function_item', 'pub fn inner() {}', [1, 4], [1, 21]).field(
      'name',
      fnName,
    );
    modNode.contains(fnNode);

    const symbols = symbolsFromMatches(
      [
        match(0, [
          ['definition.function', fnNode],
          ['name.definition.function', fnName],
        ]),
      ],
      srcLines,
      rust,
    );
    expect(symbols[0]?.kind).toBe('function');
    expect(symbols[0]?.scope).toBe('deep');
  });

  it('drops a capture whose kind is not a SymbolKind', () => {
    // A typo in a contributed query should lose that capture, not invent a kind.
    const nameNode = lineNode(source, 'type_identifier', 'UserService');
    const classNode = node('class_declaration', source, [0, 0], [2, 1]).field('name', nameNode);
    const symbols = symbolsFromMatches(
      [
        match(0, [
          ['definition.wibble', classNode],
          ['name.definition.wibble', nameNode],
        ]),
      ],
      lines,
      typescript,
    );
    expect(symbols).toHaveLength(0);
  });

  it('ignores a match with no name capture', () => {
    const classNode = node('class_declaration', source, [0, 0], [2, 1]);
    const symbols = symbolsFromMatches(
      [match(0, [['definition.class', classNode]])],
      lines,
      typescript,
    );
    expect(symbols).toHaveLength(0);
  });

  it('returns symbols in source order', () => {
    const first = lineNode(source, 'type_identifier', 'UserService');
    const second = lineNode(source, 'property_identifier', 'findUser');
    const symbols = symbolsFromMatches(
      [
        match(1, [
          ['definition.method', second],
          ['name.definition.method', second],
        ]),
        match(0, [
          ['definition.class', first],
          ['name.definition.class', first],
        ]),
      ],
      lines,
      typescript,
    );
    expect(symbols.map((s) => s.name)).toEqual(['UserService', 'findUser']);
  });
});

describe('SymbolService — reports the level that actually ran', () => {
  it('uses the heuristic scanner and says so when no grammar source is given', async () => {
    const service = new SymbolService();
    const extraction = await service.extract('a.ts', TS_SOURCE);
    expect(extraction.extractor).toBe('heuristic');
    expect(service.bestObservedExtractor()).toBe('heuristic');
  });

  it('reports tree-sitter only when a real parse produced the symbols', async () => {
    const source = 'class UserService {}\n';
    const nameNode = lineNode(source, 'type_identifier', 'UserService');
    const classNode = node('class_declaration', source, [0, 0], [0, 20]).field('name', nameNode);
    const grammars = succeedingProvider([
      match(0, [
        ['definition.class', classNode],
        ['name.definition.class', nameNode],
      ]),
    ]);

    const service = new SymbolService({ grammars });
    const extraction = await service.extract('a.ts', source);

    expect(extraction.extractor).toBe('tree-sitter');
    expect(named(extraction.symbols)).toEqual(['UserService:class']);
    expect(service.bestObservedExtractor()).toBe('tree-sitter');
    expect(service.fallbackDiagnostics()).toHaveLength(0);
  });

  it('falls back to the heuristic scanner and names the reason', async () => {
    const grammars = missingGrammarProvider('no grammar for TypeScript at /nowhere/x.wasm');
    const service = new SymbolService({ grammars });
    const extraction = await service.extract('a.ts', TS_SOURCE);

    // The level must be the honest one even though a grammar was configured.
    expect(extraction.extractor).toBe('heuristic');
    expect(extraction.message).toContain('no grammar for TypeScript');
    expect(extraction.message).toContain('heuristic scanner');
    // And the symbols are still there: degrading must not mean returning nothing.
    expect(extraction.symbols.length).toBeGreaterThan(5);
    expect(service.fallbackDiagnostics()).toContain('no grammar for TypeScript at /nowhere/x.wasm');
    expect(service.bestObservedExtractor()).toBe('heuristic');
  });

  it('falls back when a parse produces no tree', async () => {
    const grammars = new StubGrammarProvider(() => ({
      ok: false,
      message: 'TypeScript parse produced no tree',
    }));
    const service = new SymbolService({ grammars });
    const extraction = await service.extract('a.ts', TS_SOURCE);
    expect(extraction.extractor).toBe('heuristic');
    expect(extraction.message).toContain('produced no tree');
  });

  it('falls back when the query itself throws', async () => {
    const grammars = new StubGrammarProvider(() => ({
      ok: false,
      message: 'TypeScript symbol query failed: bad node type',
    }));
    const service = new SymbolService({ grammars });
    const extraction = await service.extract('a.ts', TS_SOURCE);
    expect(extraction.extractor).toBe('heuristic');
    expect(extraction.message).toContain('symbol query failed');
  });

  it('reports dropped patterns as a partial loss, still at tree-sitter level', async () => {
    // A pattern referring to a node type this grammar version lacks costs that
    // pattern, not the language. Reporting it keeps a thin result explicable.
    const grammars = succeedingProvider([], { droppedPatterns: 3 });
    const service = new SymbolService({ grammars });
    const extraction = await service.extract('a.ts', 'const x = 1;\n');
    expect(extraction.extractor).toBe('tree-sitter');
    expect(extraction.message).toContain('3 query pattern(s) did not compile');
  });

  it('declines to guess for an unregistered language', async () => {
    const service = new SymbolService();
    const extraction = await service.extract('Makefile', 'all:\n\techo hi\n');
    expect(extraction.extractor).toBe('none');
    expect(extraction.language).toBe('');
    expect(extraction.symbols).toHaveLength(0);
    expect(extraction.message).toContain('no symbol support');
  });

  it('never attempts a parse for an unregistered language', async () => {
    const grammars = succeedingProvider([]);
    const service = new SymbolService({ grammars });
    await service.extract('notes.txt', 'whatever\n');
    expect(grammars.calls).toHaveLength(0);
  });

  it('disposes the grammar source it was given', async () => {
    const grammars = succeedingProvider([]);
    const service = new SymbolService({ grammars });
    await service.extract('a.ts', 'const x = 1;\n');
    service.dispose();
    expect(grammars.disposed).toBe(true);
  });

  it('extracts from every registered language at the heuristic level', async () => {
    const service = new SymbolService();
    const samples: ReadonlyArray<readonly [string, string, string, SymbolKind]> = [
      ['a.ts', 'export function f(): void {}\n', 'f', 'function'],
      ['a.tsx', 'export function f(): void {}\n', 'f', 'function'],
      ['a.js', 'function f() {}\n', 'f', 'function'],
      ['a.py', 'def f():\n    pass\n', 'f', 'function'],
      ['a.go', 'func F() {}\n', 'F', 'function'],
      ['a.rs', 'pub fn f() {}\n', 'f', 'function'],
    ];
    for (const [path, source, name, kind] of samples) {
      const extraction = await service.extract(path, source);
      expect(extraction.extractor, path).toBe('heuristic');
      expect(find(extraction.symbols, name)?.kind, path).toBe(kind);
    }
  });
});

// ---------------------------------------------------------------------------
// Real grammars — opt-in, because WASM files are not vendored
// ---------------------------------------------------------------------------

const grammarDirectory = process.env.ADZE_GRAMMAR_DIR;
const withGrammars = grammarDirectory === undefined ? describe.skip : describe;

withGrammars('SymbolService — with real tree-sitter grammars', () => {
  it('parses TypeScript and reports tree-sitter', async () => {
    const registry = new GrammarRegistry({ directory: grammarDirectory ?? '' });
    const service = new SymbolService({ grammars: registry });
    try {
      const extraction = await service.extract('a.ts', TS_SOURCE);
      expect(extraction.extractor).toBe('tree-sitter');
      expect(find(extraction.symbols, 'UserService')?.kind).toBe('class');
      expect(find(extraction.symbols, 'findUser')?.scope).toBe('UserService');
    } finally {
      service.dispose();
    }
  });

  it('parses every language whose grammar is present', async () => {
    const registry = new GrammarRegistry({ directory: grammarDirectory ?? '' });
    const service = new SymbolService({ grammars: registry });
    try {
      for (const id of ['typescript', 'javascript', 'python', 'go', 'rust']) {
        const definition = languageById(id);
        expect(definition, id).toBeDefined();
        const outcome = await registry.querySymbols(definition ?? definitionFor('a.ts'), 'x\n');
        // A grammar that is present must produce a usable query, not a partial one.
        if (outcome.ok) expect(outcome.droppedPatterns).toBe(0);
      }
    } finally {
      service.dispose();
    }
  });
});
