/**
 * Manifest validation.
 *
 * The two required behaviours from the brief are here: an `engines.adze` mismatch is a
 * clear error, and a manifest carrying invisible characters is rejected outright. The
 * rest covers the fields that decide whether third-party code runs.
 */

import { describe, expect, it } from 'vitest';
import {
  canVeto,
  checkEngineCompatibility,
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_EVENTS,
  hookTimeoutMs,
  namespaceOf,
  normalizePermissions,
  parseManifest,
  resolveRuntime,
} from '../src/manifest.js';
import { manifestText } from './support.js';

function parsed(overrides: Readonly<Record<string, unknown>> = {}) {
  const outcome = parseManifest(manifestText(overrides));
  if (!outcome.ok) throw new Error(`expected a valid manifest: ${outcome.diagnostics[0]?.message}`);
  return outcome;
}

function codes(overrides: Readonly<Record<string, unknown>>): readonly string[] {
  const outcome = parseManifest(manifestText(overrides));
  if (outcome.ok) throw new Error('expected the manifest to be refused');
  return outcome.diagnostics.map((diagnostic) => diagnostic.code);
}

describe('parseManifest - the minimum viable plugin', () => {
  it('accepts a manifest with no contributions at all', () => {
    // A plugin is a directory containing a manifest. Everything else is optional, and
    // a manifest-only plugin has to parse or the declarative path is not the easy one.
    const outcome = parsed();
    expect(outcome.manifest.id).toBe('acme.example');
    expect(outcome.manifest.contributes).toBeUndefined();
  });

  it('denies every permission that was not requested', () => {
    expect(normalizePermissions(undefined)).toEqual({
      filesystem: 'none',
      network: [],
      env: [],
    });
    expect(parsed().permissions.filesystem).toBe('none');
  });

  it('keeps requested permissions verbatim, for display at install time', () => {
    const outcome = parsed({
      permissions: { filesystem: 'read', network: ['api.acme.com'], env: ['ACME_TOKEN'] },
    });
    expect(outcome.permissions).toEqual({
      filesystem: 'read',
      network: ['api.acme.com'],
      env: ['ACME_TOKEN'],
    });
  });

  it('warns about workspace-write and about each network host', () => {
    const outcome = parsed({
      permissions: { filesystem: 'workspace-write', network: ['a.example', 'b.example'] },
    });
    expect(outcome.warnings).toHaveLength(3);
    expect(outcome.warnings.every((warning) => warning.severity === 'warning')).toBe(true);
  });
});

describe('parseManifest - ids', () => {
  it('requires <namespace>.<name>', () => {
    expect(codes({ id: 'nodot' })).toEqual(['manifest-schema']);
    expect(codes({ id: 'Acme.Example' })).toEqual(['manifest-schema']);
    expect(codes({ id: 'acme.team.guard' })).toEqual(['manifest-schema']);
    expect(codes({ id: 'acme.' })).toEqual(['manifest-schema']);
  });

  it('extracts the namespace, which is what a claim applies to', () => {
    expect(namespaceOf('acme.migration-guard')).toBe('acme');
  });
});

describe('parseManifest - hidden characters are a hard failure', () => {
  it('rejects a bidi override inside a string value', () => {
    // The whole point of scanning before JSON.parse: this is valid JSON, and the
    // rendered manifest differs from the bytes.
    const raw = manifestText({ description: 'Safe plugin\u202E evil' });
    const outcome = parseManifest(raw);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics[0]?.code).toBe('hidden-characters');
  });

  it('rejects a zero-width character in the id', () => {
    expect(codes({ id: 'acme.exa\u200Bmple' })).toEqual(['hidden-characters']);
  });

  it('reports hidden characters before schema problems', () => {
    // Order matters: a manifest that is both malformed and carrying a payload should
    // report the payload, because that is the one a reviewer must see.
    const raw = manifestText({ id: 'BAD', description: 'x\u200Dy' });
    const outcome = parseManifest(raw);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics.map((d) => d.code)).toEqual(['hidden-characters']);
  });
});

describe('parseManifest - module paths cannot escape the plugin', () => {
  it('rejects a traversing hook module', () => {
    expect(
      codes({ contributes: { hooks: [{ event: 'tool.pre', module: '../../etc/passwd' }] } }),
    ).toEqual(['manifest-schema']);
  });

  it('rejects an absolute hook module on either platform', () => {
    expect(
      codes({ contributes: { hooks: [{ event: 'tool.pre', module: '/etc/passwd' }] } }),
    ).toEqual(['manifest-schema']);
    expect(
      codes({ contributes: { hooks: [{ event: 'tool.pre', module: 'C:\\windows\\x.wasm' }] } }),
    ).toEqual(['manifest-schema']);
  });

  it('rejects a traversing command reference', () => {
    expect(codes({ contributes: { commands: [{ path: 'commands/../../secrets.md' }] } })).toEqual([
      'manifest-schema',
    ]);
  });
});

describe('parseManifest - tool transports', () => {
  it('requires command for stdio and url for http', () => {
    expect(codes({ contributes: { tools: [{ name: 'db', transport: 'stdio' }] } })).toEqual([
      'transport-fields',
    ]);
    expect(codes({ contributes: { tools: [{ name: 'db', transport: 'http' }] } })).toEqual([
      'transport-fields',
    ]);
  });

  it('refuses a config that names both transports', () => {
    const outcome = codes({
      contributes: {
        tools: [{ name: 'db', transport: 'stdio', command: 'npx', url: 'https://x.example' }],
      },
    });
    expect(outcome).toEqual(['transport-fields']);
  });

  it('accepts a well-formed stdio server', () => {
    const outcome = parsed({
      contributes: {
        tools: [
          {
            name: 'acme-db',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@acme/mcp-database'],
            sandbox: 'workspace-write',
            autoApprove: ['query_schema'],
          },
        ],
      },
    });
    expect(outcome.manifest.contributes?.tools?.[0]?.name).toBe('acme-db');
  });
});

describe('parseManifest - duplicate names', () => {
  it('refuses two servers with one name', () => {
    expect(
      codes({
        contributes: {
          tools: [
            { name: 'db', transport: 'stdio', command: 'a' },
            { name: 'db', transport: 'stdio', command: 'b' },
          ],
        },
      }),
    ).toEqual(['duplicate-name']);
  });

  it('refuses two context providers claiming one trigger', () => {
    expect(
      codes({
        contributes: {
          contextProviders: [
            { type: 'glob', name: 'a', patterns: ['**/*.md'], trigger: '@docs' },
            { type: 'glob', name: 'b', patterns: ['**/*.txt'], trigger: '@docs' },
          ],
        },
      }),
    ).toEqual(['duplicate-name']);
  });

  it('requires a trigger to look like @name', () => {
    expect(
      codes({
        contributes: {
          contextProviders: [{ type: 'glob', name: 'a', patterns: ['**'], trigger: 'docs' }],
        },
      }),
    ).toEqual(['manifest-schema']);
  });
});

describe('checkEngineCompatibility', () => {
  it('accepts a satisfied range', () => {
    expect(checkEngineCompatibility(parsed().manifest, '0.0.1').ok).toBe(true);
  });

  it('refuses a mismatch and names both versions and the range', () => {
    const manifest = parsed({ engines: { adze: '>=0.4.0 <2.0.0' } }).manifest;
    const outcome = checkEngineCompatibility(manifest, '0.0.1');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostic.code).toBe('engine-mismatch');
    expect(outcome.diagnostic.message).toContain('>=0.4.0 <2.0.0');
    expect(outcome.diagnostic.message).toContain('0.0.1');
    expect(outcome.diagnostic.message).toContain('Upgrade Adze');
  });

  it('refuses an unparseable range as its own distinct failure', () => {
    const manifest = parsed({ engines: { adze: 'sometime after next tuesday' } }).manifest;
    const outcome = checkEngineCompatibility(manifest, '0.0.1');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Not `engine-mismatch`: the fix is to correct the range, not to upgrade.
    expect(outcome.diagnostic.code).toBe('engine-range-unparseable');
  });

  it('never treats an unreadable range as compatible', () => {
    const manifest = parsed({ engines: { adze: '1.x' } }).manifest;
    expect(checkEngineCompatibility(manifest, '1.5.0').ok).toBe(false);
  });
});

describe('hook contributions', () => {
  it('exposes all nine events from the spec', () => {
    expect([...HOOK_EVENTS]).toEqual([
      'session.start',
      'session.turnStart',
      'context.pre',
      'tool.pre',
      'tool.post',
      'edit.pre',
      'edit.post',
      'session.compact',
      'session.turnEnd',
    ]);
  });

  it('marks exactly tool.pre and edit.pre as able to veto', () => {
    expect(HOOK_EVENTS.filter(canVeto)).toEqual(['tool.pre', 'edit.pre']);
  });

  it('rejects an unknown event rather than ignoring the hook', () => {
    expect(codes({ contributes: { hooks: [{ event: 'tool.middle', module: 'h.wasm' }] } })).toEqual(
      ['manifest-schema'],
    );
  });

  it('defaults timeoutMs and caps an absurd one', () => {
    expect(hookTimeoutMs({ event: 'tool.pre', module: 'h.wasm' })).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    expect(
      codes({
        contributes: { hooks: [{ event: 'tool.pre', module: 'h.wasm', timeoutMs: 600000 }] },
      }),
    ).toEqual(['manifest-schema']);
  });

  it('infers a runtime from .wasm and .mjs, and refuses to guess otherwise', () => {
    expect(resolveRuntime('hooks/policy.wasm', undefined)).toEqual({ ok: true, runtime: 'wasm' });
    expect(resolveRuntime('hooks/policy.mjs', undefined)).toEqual({ ok: true, runtime: 'js' });
    const unknown = resolveRuntime('hooks/policy.so', undefined);
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    // Guessing `native` here would silently run unsandboxed code.
    expect(unknown.message).toContain('never inferred');
  });

  it('warns loudly when a hook declares itself native', () => {
    const outcome = parsed({
      contributes: { hooks: [{ event: 'tool.pre', module: 'hooks/p.so', runtime: 'native' }] },
    });
    expect(outcome.warnings.some((w) => w.message.includes('UNSANDBOXED'))).toBe(true);
  });
});

describe('parseManifest - malformed input', () => {
  it('reports invalid JSON as its own code', () => {
    const outcome = parseManifest('{ "id": ');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics[0]?.code).toBe('manifest-invalid-json');
  });

  it('names the field for each schema problem', () => {
    const outcome = parseManifest(JSON.stringify({ id: 'acme.x' }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const fields = outcome.diagnostics.map((diagnostic) => diagnostic.field);
    expect(fields).toContain('version');
    expect(fields).toContain('license');
    expect(fields).toContain('engines');
  });
});
