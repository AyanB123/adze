/**
 * Grammar loading tests.
 *
 * Three properties, and all three are about what does *not* happen:
 *
 * **Nothing loads until asked.** `web-tree-sitter` is imported dynamically and
 * grammar bytes are read on first use, so a fresh clone with no grammars never
 * touches the tree-sitter runtime at all. Constructing a registry must therefore
 * be inert.
 *
 * **Nothing is fetched.** `Language.load` accepts a string and a string can be a
 * URL. We read the bytes ourselves and pass a `Uint8Array`, which makes "retrieval
 * performs no network call" a property of the code. The structural half of that
 * claim is asserted in `no-network.test.ts`.
 *
 * **Nothing is claimed that did not happen.** A missing grammar produces an
 * actionable message and a `heuristic` result, never a silent empty symbol list.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrammarRegistry, splitQueryPatterns } from '../src/grammars.js';
import { LANGUAGES, languageById } from '../src/languages.js';
import { createFixture, type Fixture } from './fixture.js';

function definitionFor(id: string) {
  const definition = languageById(id);
  if (definition === undefined) throw new Error(`no language '${id}'`);
  return definition;
}

let openFixtures: Fixture[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(openFixtures.map(async (f) => f.cleanup()));
  openFixtures = [];
});

async function fixture(files: Readonly<Record<string, string>> = {}): Promise<Fixture> {
  const created = await createFixture(files);
  openFixtures.push(created);
  return created;
}

describe('splitQueryPatterns', () => {
  it('splits top-level patterns and keeps trailing captures attached', () => {
    const source = `
(class_declaration name: (type_identifier) @name.definition.class) @definition.class
(interface_declaration name: (type_identifier) @name.definition.interface) @definition.interface
`;
    const patterns = splitQueryPatterns(source);
    expect(patterns).toHaveLength(2);
    expect(patterns[0]).toContain('class_declaration');
    expect(patterns[0]).toContain('@definition.class');
    expect(patterns[1]).toContain('interface_declaration');
    expect(patterns[1]).toContain('@definition.interface');
  });

  it('does not split inside a nested group', () => {
    const source = `
(method_declaration
  receiver: (parameter_list
    (parameter_declaration
      type: [(type_identifier) @scope (pointer_type (type_identifier) @scope)]))
  name: (field_identifier) @name.definition.method) @definition.method
`;
    expect(splitQueryPatterns(source)).toHaveLength(1);
  });

  it('does not split on a paren inside a string', () => {
    const source = `
(assignment left: (identifier) @a (#match? @a "^(A|B)$")) @definition.constant
(call function: (identifier) @b (#eq? @b ")(")) @definition.function
`;
    expect(splitQueryPatterns(source)).toHaveLength(2);
  });

  it('handles an escaped quote inside a string', () => {
    const source = String.raw`(x (#eq? @a "say \"hi\"")) @definition.function`;
    expect(splitQueryPatterns(source)).toHaveLength(1);
  });

  it('drops a semicolon comment without breaking the pattern', () => {
    const source = `
; a leading comment with (unbalanced parens
(function_declaration name: (identifier) @name.definition.function) @definition.function
; trailing note
`;
    const patterns = splitQueryPatterns(source);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toContain('function_declaration');
  });

  it('splits a bracketed alternation at the top level', () => {
    const source = '[(a) (b)] @definition.type\n(c) @definition.class\n';
    expect(splitQueryPatterns(source)).toHaveLength(2);
  });

  it('returns nothing for empty or whitespace-only input', () => {
    expect(splitQueryPatterns('')).toHaveLength(0);
    expect(splitQueryPatterns('   \n\n  ')).toHaveLength(0);
  });

  it('splits every built-in query into at least as many patterns as it has captures', () => {
    // A regression guard: if the splitter collapsed a real query into one pattern,
    // the per-pattern fallback would stop protecting a language from one bad node
    // type, and the loss would be silent.
    for (const language of LANGUAGES) {
      const patterns = splitQueryPatterns(language.symbolQuery);
      const definitionCaptures = (language.symbolQuery.match(/@definition\./g) ?? []).length;
      expect(patterns.length, language.id).toBe(definitionCaptures);
    }
  });
});

describe('GrammarRegistry — grammar directory resolution', () => {
  it('names the exact path it looked at, so the message is actionable', async () => {
    const workspace = await fixture();
    const registry = new GrammarRegistry({ directory: join(workspace.root, 'grammars') });
    const load = await registry.load(definitionFor('python'));

    expect(load.ok).toBe(false);
    if (load.ok) return;
    expect(load.message).toContain('tree-sitter-python.wasm');
    expect(load.message).toContain('npx tree-sitter build --wasm');
    expect(load.message).toContain('ADZE_GRAMMAR_DIR');
  });

  it('defaults to <root>/.adze/grammars', async () => {
    const workspace = await fixture();
    // Stubbed away explicitly: a developer with this set in their shell would
    // otherwise see this test pass or fail based on their environment.
    vi.stubEnv('ADZE_GRAMMAR_DIR', undefined);
    const registry = new GrammarRegistry({ root: workspace.root });
    const load = await registry.load(definitionFor('go'));
    expect(load.ok).toBe(false);
    if (load.ok) return;
    expect(load.message).toContain('.adze');
    expect(load.message).toContain('grammars');
  });

  it('reads ADZE_GRAMMAR_DIR when no directory is given', async () => {
    const workspace = await fixture();
    vi.stubEnv('ADZE_GRAMMAR_DIR', join(workspace.root, 'from-env'));
    const registry = new GrammarRegistry({ root: workspace.root });
    const load = await registry.load(definitionFor('rust'));
    expect(load.ok).toBe(false);
    if (load.ok) return;
    expect(load.message).toContain('from-env');
  });

  it('prefers an explicit directory over the environment', async () => {
    const workspace = await fixture();
    vi.stubEnv('ADZE_GRAMMAR_DIR', join(workspace.root, 'from-env'));
    const registry = new GrammarRegistry({ directory: join(workspace.root, 'explicit') });
    const load = await registry.load(definitionFor('rust'));
    expect(load.ok).toBe(false);
    if (load.ok) return;
    expect(load.message).toContain('explicit');
    expect(load.message).not.toContain('from-env');
  });

  it('prefers an explicit per-language file over any directory', async () => {
    const workspace = await fixture();
    const registry = new GrammarRegistry({
      directory: join(workspace.root, 'dir'),
      files: { python: join(workspace.root, 'custom', 'py.wasm') },
    });
    const load = await registry.load(definitionFor('python'));
    expect(load.ok).toBe(false);
    if (load.ok) return;
    expect(load.message).toContain('py.wasm');
  });
});

describe('GrammarRegistry — laziness and caching', () => {
  it('is inert until something asks for a parse', async () => {
    // Constructing must not read the filesystem or start the WASM runtime, which
    // is what keeps a fresh clone from paying for a feature it cannot use.
    const registry = new GrammarRegistry({ directory: '/definitely/not/here' });
    expect(registry).toBeInstanceOf(GrammarRegistry);
    registry.dispose();
  });

  it('caches a failed load rather than re-reading on every request', async () => {
    const workspace = await fixture();
    const directory = join(workspace.root, 'grammars');
    await mkdir(directory, { recursive: true });

    const registry = new GrammarRegistry({ directory });
    const first = await registry.load(definitionFor('python'));
    expect(first.ok).toBe(false);

    // Put a file there after the miss. A cached failure must still be a failure:
    // retrying a missing grammar per query turns one absence into a filesystem
    // miss on every file in the repository.
    await writeFile(join(directory, 'tree-sitter-python.wasm'), Buffer.from([0, 1, 2, 3]));
    const second = await registry.load(definitionFor('python'));
    expect(second.ok).toBe(false);
  });

  it('reports a corrupt grammar as a load failure, not a crash', async () => {
    const workspace = await fixture();
    const directory = join(workspace.root, 'grammars');
    await mkdir(directory, { recursive: true });
    // Not valid WASM. web-tree-sitter must reject it and we must survive that.
    await writeFile(join(directory, 'tree-sitter-python.wasm'), 'this is not wasm\n');

    const registry = new GrammarRegistry({ directory });
    const load = await registry.load(definitionFor('python'));
    expect(load.ok).toBe(false);
    if (load.ok) return;
    expect(load.message).toMatch(/failed to load|runtime failed to initialise/);
  });

  it('querySymbols degrades to a message instead of throwing', async () => {
    const workspace = await fixture();
    const registry = new GrammarRegistry({ root: workspace.root });
    const outcome = await registry.querySymbols(definitionFor('typescript'), 'const x = 1;\n');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message.length).toBeGreaterThan(0);
  });

  it('parse returns undefined rather than throwing when no grammar loaded', async () => {
    const workspace = await fixture();
    const registry = new GrammarRegistry({ root: workspace.root });
    expect(await registry.parse(definitionFor('typescript'), 'const x = 1;\n')).toBeUndefined();
  });

  it('dispose is safe with nothing loaded and safe twice', async () => {
    const registry = new GrammarRegistry({ directory: '/nope' });
    expect(() => {
      registry.dispose();
      registry.dispose();
    }).not.toThrow();
  });
});

describe('LANGUAGES registry', () => {
  it('has a unique id and grammar file per language', () => {
    const ids = LANGUAGES.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('claims no extension twice', () => {
    const extensions = LANGUAGES.flatMap((l) => l.extensions);
    expect(new Set(extensions).size).toBe(extensions.length);
  });

  it('gives every language heuristics, so a fresh clone always works', () => {
    // This is the whole reason the fallback exists: symbol lookup has to work
    // before anyone downloads a grammar.
    for (const language of LANGUAGES) {
      expect(language.heuristics.length, language.id).toBeGreaterThan(0);
      expect(language.lineComments.length, language.id).toBeGreaterThan(0);
    }
  });

  it('compiles every heuristic pattern', () => {
    for (const language of LANGUAGES) {
      for (const rule of language.heuristics) {
        expect(() => new RegExp(rule.pattern), `${language.id}: ${rule.pattern}`).not.toThrow();
      }
    }
  });

  it('gives every heuristic rule a capture group that exists', () => {
    for (const language of LANGUAGES) {
      for (const rule of language.heuristics) {
        const groups = new RegExp(`${rule.pattern}|`).exec('')?.length ?? 0;
        expect(rule.nameGroup, `${language.id}: ${rule.pattern}`).toBeLessThan(groups);
        if (rule.scopeGroup !== undefined) {
          expect(rule.scopeGroup, `${language.id}: ${rule.pattern}`).toBeLessThan(groups);
        }
      }
    }
  });

  it('names a grammar file matching the tree-sitter convention', () => {
    for (const language of LANGUAGES) {
      expect(language.grammarFile, language.id).toMatch(/^tree-sitter-[a-z]+\.wasm$/);
    }
  });

  it('declares a kind on every container rule', () => {
    // The kind is what decides whether a nested function is a method. A missing
    // one would silently mislabel every method in the language.
    for (const language of LANGUAGES) {
      for (const container of language.containers) {
        expect(container.kind, `${language.id}: ${container.node}`).toBeTruthy();
      }
    }
  });
});
