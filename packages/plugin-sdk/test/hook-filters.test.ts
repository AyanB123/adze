/**
 * Host-side hook filters: manifest `tools`/`paths` on hook entries.
 *
 * Finding 2 in `plugins/FINDINGS.md`: every hook ran on every call of its
 * event, so a policy hook that only cared about `bash` paid a guest round-trip
 * per tool call to immediately return `allow`. The manifest now carries the
 * filter declaratively, the host applies it before guest dispatch, an invalid
 * glob is a load error, and a skipped dispatch is recorded as `skipped` rather
 * than silently dropped.
 */

import type { JsonValue } from '@adze/protocol';
import { describe, expect, it } from 'vitest';
import {
  HookHost,
  type HookInstance,
  matchesHookFilters,
  recordingObserver,
} from '../src/hooks.js';
import { loadPlugin } from '../src/loader.js';
import type { HookEvent } from '../src/manifest.js';
import { fakeGuest, fixedRuntime, manifestText, memoryPluginFiles, ROOT } from './support.js';

function hook(
  pluginId: string,
  event: HookEvent,
  answer: JsonValue,
  filters?: { readonly tools?: readonly string[]; readonly paths?: readonly string[] },
): HookInstance {
  return {
    pluginId,
    event,
    module: `hooks/${pluginId}.mjs`,
    runtime: 'js',
    timeoutMs: 1_000,
    exportName: event,
    guest: fakeGuest(() => answer),
    ...(filters?.tools === undefined ? {} : { tools: filters.tools }),
    ...(filters?.paths === undefined ? {} : { paths: filters.paths }),
  };
}

describe('matchesHookFilters', () => {
  it('matches everything when a hook declares no filters', () => {
    const outcome = matchesHookFilters(hook('acme.a', 'tool.pre', { kind: 'allow' }), {
      toolName: 'read',
      path: 'docs/a.md',
    });
    expect(outcome).toEqual({ matches: true });
  });

  it('matches a tools filter on equality and on glob', () => {
    const filtered = hook('acme.a', 'tool.pre', { kind: 'allow' }, { tools: ['bash'] });
    expect(matchesHookFilters(filtered, { toolName: 'bash' })).toEqual({ matches: true });
    const missed = matchesHookFilters(filtered, { toolName: 'read' });
    expect(missed.matches).toBe(false);

    const globbed = hook('acme.a', 'tool.pre', { kind: 'allow' }, { tools: ['*'] });
    expect(matchesHookFilters(globbed, { toolName: 'read' })).toEqual({ matches: true });
  });

  it('matches a paths filter POSIX-style', () => {
    const filtered = hook('acme.a', 'edit.pre', { kind: 'allow' }, { paths: ['docs/*.md'] });
    expect(matchesHookFilters(filtered, { path: 'docs/a.md' })).toEqual({ matches: true });
    // Backslashes are normalized, so a manifest behaves the same on Windows.
    expect(matchesHookFilters(filtered, { path: 'docs\\a.md' })).toEqual({ matches: true });
    expect(matchesHookFilters(filtered, { path: 'src/a.md' }).matches).toBe(false);
  });

  it('requires both filters to match when both are declared', () => {
    const filtered = hook(
      'acme.a',
      'edit.pre',
      { kind: 'allow' },
      { tools: ['edit'], paths: ['docs/*.md'] },
    );
    expect(matchesHookFilters(filtered, { toolName: 'edit', path: 'docs/a.md' })).toEqual({
      matches: true,
    });
    expect(matchesHookFilters(filtered, { toolName: 'write', path: 'docs/a.md' }).matches).toBe(
      false,
    );
    expect(matchesHookFilters(filtered, { toolName: 'edit', path: 'src/a.md' }).matches).toBe(
      false,
    );
  });

  it('skips rather than fires when the call carries nothing to match', () => {
    const filtered = hook('acme.a', 'tool.pre', { kind: 'allow' }, { tools: ['bash'] });
    expect(matchesHookFilters(filtered, {}).matches).toBe(false);
  });
});

describe('HookHost skips non-matching hooks before guest dispatch', () => {
  it('does not enter the guest for a skipped tool', async () => {
    let entered = 0;
    const host = new HookHost();
    host.register({
      ...hook('acme.a', 'tool.pre', { kind: 'deny', reason: 'no' }, { tools: ['bash'] }),
      guest: fakeGuest(() => {
        entered += 1;
        return { kind: 'deny', reason: 'no' };
      }),
    });

    const decision = await host.fireDecision(
      'tool.pre',
      { sessionId: 's', turnId: 't', callId: 'c', name: 'read', arguments: {} },
      {},
      { toolName: 'read' },
    );

    expect(decision).toEqual({ kind: 'allow' });
    expect(entered).toBe(0);
    expect(host.records.some((record) => record.kind === 'skipped')).toBe(true);
  });

  it('fires a matching hook and honours its denial', async () => {
    const host = new HookHost();
    host.register(
      hook('acme.a', 'tool.pre', { kind: 'deny', reason: 'bash is blocked' }, { tools: ['bash'] }),
    );

    const decision = await host.fireDecision(
      'tool.pre',
      { sessionId: 's', turnId: 't', callId: 'c', name: 'bash', arguments: {} },
      {},
      { toolName: 'bash' },
    );

    expect(decision).toEqual({ kind: 'deny', pluginId: 'acme.a', reason: 'bash is blocked' });
  });

  it('skips an edit.pre hook whose paths filter does not match', async () => {
    const observer = recordingObserver();
    const host = new HookHost({ observer });
    host.register(
      hook('acme.a', 'edit.pre', { kind: 'deny', reason: 'no' }, { paths: ['migrations/*.sql'] }),
    );

    const decision = await host.fireDecision(
      'edit.pre',
      {
        sessionId: 's',
        turnId: 't',
        callId: 'c',
        path: 'src/a.ts',
        edits: [],
        wholeFile: false,
        approvedByHuman: false,
        arguments: {},
      },
      {},
      { toolName: 'edit', path: 'src/a.ts' },
    );

    expect(decision).toEqual({ kind: 'allow' });
    expect(observer.records).toHaveLength(1);
    expect(observer.records[0]?.kind).toBe('skipped');
  });

  it('a skipped hook is not a diagnostic', async () => {
    const host = new HookHost();
    host.register(hook('acme.a', 'tool.pre', { kind: 'allow' }, { tools: ['bash'] }));
    await host.fireDecision(
      'tool.pre',
      { sessionId: 's', turnId: 't', callId: 'c', name: 'read', arguments: {} },
      {},
      { toolName: 'read' },
    );
    expect(host.diagnostics()).toEqual([]);
  });
});

describe('loader rejects invalid hook filter globs', () => {
  it('refuses a plugin whose tools filter does not compile', async () => {
    const files = memoryPluginFiles({
      [`${ROOT}/adze.plugin.json`]: manifestText({
        contributes: {
          hooks: [{ event: 'tool.pre', module: 'hooks/g.mjs', runtime: 'js', tools: ['a[b'] }],
        },
      }),
    });
    const outcome = await loadPlugin(ROOT, {
      engineVersion: '0.0.1',
      files,
      jsRuntime: fixedRuntime(
        'js',
        fakeGuest(() => ({ kind: 'allow' })),
      ),
      allowUnsandboxedJs: true,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics[0]?.code).toBe('manifest-schema');
    expect(outcome.diagnostics[0]?.message).toContain('tools');
  });

  it('keeps valid filters on the loaded hook', async () => {
    const files = memoryPluginFiles({
      [`${ROOT}/adze.plugin.json`]: manifestText({
        contributes: {
          hooks: [
            {
              event: 'tool.pre',
              module: 'hooks/g.mjs',
              runtime: 'js',
              tools: ['bash'],
              paths: ['docs/*.md'],
            },
          ],
        },
      }),
      [`${ROOT}/hooks/g.mjs`]: 'export function invoke() { return { kind: "allow" }; }\n',
    });
    const outcome = await loadPlugin(ROOT, {
      engineVersion: '0.0.1',
      files,
      jsRuntime: fixedRuntime(
        'js',
        fakeGuest(() => ({ kind: 'allow' })),
      ),
      allowUnsandboxedJs: true,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plugin.hooks[0]?.tools).toEqual(['bash']);
    expect(outcome.plugin.hooks[0]?.paths).toEqual(['docs/*.md']);
  });
});
