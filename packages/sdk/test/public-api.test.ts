/**
 * The stability boundary, asserted rather than trusted.
 *
 * `@adze/sdk` is semver-strict from 1.0 (architecture README §4). That guarantee is
 * worth nothing if a consumer can reach a `@adze/core` internal through this package,
 * because then core's refactors are this package's breaking changes and the tier is
 * decorative. ADR-0001 rule 4 promises third parties can build a surface "without our
 * involvement or permission", and a consumer who has accidentally pinned
 * `ScriptedProvider`'s constructor signature does not have that.
 *
 * Three checks, from three directions, because each one alone has a hole:
 *
 * 1. **No shared name.** Catches `export { Engine } from '@adze/core'`.
 * 2. **No shared value.** Catches a rename — `export { Engine as AdzeEngine }` — which
 *    the name check would pass.
 * 3. **No core import outside `src/internal/`.** Catches the case neither runtime check
 *    can see: a core *type* in a public signature. Types are erased at runtime, so a
 *    `provider: ModelProvider` parameter is invisible to checks 1 and 2 and would still
 *    put `import type { ModelProvider } from '@adze/core'` into the emitted `.d.ts`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as core from '@adze/core';
import * as protocol from '@adze/protocol';
import { describe, expect, it } from 'vitest';
import * as sdk from '../src/index.js';

const SRC = join(import.meta.dirname, '..', 'src');

/** The byte that starts every ANSI sequence. */
const ESCAPE = String.fromCharCode(0x1b);

function sourceFiles(directory: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

/**
 * A file with its comments removed.
 *
 * Both source checks below are claims about code, and this package's comments are
 * unusually full of the very strings they look for: `types.ts` explains at length why
 * `@adze/core` types are not exposed, and `index.ts` shows a consumer writing to
 * stdout. Matching raw text would make documenting the rule a violation of it.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/.*$/gm, '');
}

describe('the public API', () => {
  it('shares no exported name with @adze/core', () => {
    const shared = Object.keys(sdk).filter((name) => Object.hasOwn(core, name));
    expect(shared).toEqual([]);
  });

  it('shares no exported value with @adze/core, even under a different name', () => {
    const coreValues = new Set<unknown>(Object.values(core));
    const leaked = Object.entries(sdk)
      .filter(([, value]) => coreValues.has(value))
      .map(([name]) => name);
    expect(leaked).toEqual([]);
  });

  it('imports @adze/core only from src/internal/', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => /from '@adze\/core'/.test(code(readFileSync(path, 'utf8'))))
      .map((path) => relative(SRC, path))
      .filter((path) => !path.startsWith(`internal${sep}`));

    // The files that declare the public surface — `index.ts`, `types.ts`, `errors.ts` —
    // must be reachable without core in scope at all. That is what keeps a core type
    // out of a public signature, which no runtime check can detect.
    expect(offenders).toEqual([]);
  });

  it('names none of the engine classes core exports, under any alias', () => {
    const engineInternals = [
      'Engine',
      'ScriptedProvider',
      'PermissionGate',
      'ToolRegistry',
      'HookBus',
      'ContextAssembler',
      'BudgetTracker',
      'Session',
      'TurnEmitter',
      'EventLog',
      'NodeSubprocessBroker',
      'NullBroker',
      'ContinuationStore',
      'TurnConfigurationError',
      'PermissionError',
    ];
    for (const name of engineInternals) {
      expect(Object.hasOwn(sdk, name), `${name} must not be reachable from @adze/sdk`).toBe(false);
    }
  });

  it('re-exports the protocol vocabulary as the protocol’s own values', () => {
    // Identity, not a copy. A surface must be able to render the same event type
    // whether it embedded the engine through this package or spoke JSON-RPC to it; a
    // redeclared type would let the two drift and force a renderer rewrite.
    expect(sdk.ADZE_EVENT_TYPES).toBe(protocol.ADZE_EVENT_TYPES);
    expect(sdk.isTerminalEvent).toBe(protocol.isTerminalEvent);
    expect(sdk.DEFAULT_APPROVAL_POLICY).toBe(protocol.DEFAULT_APPROVAL_POLICY);
    expect(sdk.DEFAULT_SANDBOX_MODE).toBe(protocol.DEFAULT_SANDBOX_MODE);
    expect(sdk.PROTOCOL_VERSION).toBe(protocol.PROTOCOL_VERSION);
    expect(sdk.sandboxEnforcement).toBe(protocol.sandboxEnforcement);
    expect(sdk.refusesRatherThanPrompts).toBe(protocol.refusesRatherThanPrompts);
    expect(sdk.computeCacheHitRate).toBe(protocol.computeCacheHitRate);
    expect(sdk.SUPPORTED_PROTOCOL_VERSIONS).toBe(protocol.SUPPORTED_PROTOCOL_VERSIONS);
  });

  it('exports exactly the surface it documents', () => {
    // A guard against an accidental export, which is the usual way a stability tier
    // widens: something is exported for a test, and a consumer finds it.
    expect(Object.keys(sdk).toSorted()).toEqual(
      [
        'ADZE_EVENT_TYPES',
        'AdzeConfigError',
        'AdzeSessionError',
        'DEFAULT_APPROVAL_POLICY',
        'DEFAULT_SANDBOX_MODE',
        'PROTOCOL_VERSION',
        'SDK_VERSION',
        'SUPPORTED_PROTOCOL_VERSIONS',
        'computeCacheHitRate',
        'createClient',
        'isTerminalEvent',
        'refusesRatherThanPrompts',
        'sandboxEnforcement',
        'scriptedProvider',
      ].toSorted(),
    );
  });

  it('exposes no way to bypass the permission gate', () => {
    // Not a paraphrase of the rule — a check that the vocabulary a bypass would need
    // is absent. Every tool call passes the gate, including built-ins, and there must
    // be no code path around it (architecture invariant 4).
    const forbidden = /trust|bypass|skipPermission|skipApproval|allowAll|unsafe|autoApprove/i;
    const named = Object.keys(sdk).filter((name) => forbidden.test(name));
    expect(named).toEqual([]);

    // The same check over the declared option surface, which is where such a flag
    // would actually be added.
    const types = readFileSync(join(SRC, 'types.ts'), 'utf8');
    const declarations = types.match(/^\s{2}readonly [A-Za-z]+/gm) ?? [];
    expect(declarations.filter((line) => forbidden.test(line))).toEqual([]);
  });

  it('renders nothing: no source file writes to a stream or emits an escape', () => {
    for (const path of sourceFiles(SRC)) {
      const text = code(readFileSync(path, 'utf8'));
      const name = relative(SRC, path);
      expect(text, `${name} must not write to stdout`).not.toMatch(/process\.stdout/);
      expect(text, `${name} must not write to stderr`).not.toMatch(/process\.stderr/);
      expect(text, `${name} must not use console`).not.toMatch(/\bconsole\.\w+\(/);
      // A literal escape byte rather than a regex, because a control character in a
      // pattern is itself a lint error — and the assertion is about the byte.
      expect(text.includes(ESCAPE), `${name} must not emit a terminal escape`).toBe(false);
    }
  });
});
