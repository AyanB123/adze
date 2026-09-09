/**
 * `adze.destructive-guard`: irreversible shell commands are refused before they run.
 *
 * Every case runs through `dispatchToolCall` from `@adze/core`, so a denied command
 * never reaches the `bash` spy. The negative cases matter most here: `echo "rm -rf /"`
 * prints a string and deletes nothing, and a guard that denies it gets uninstalled.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { LoadedPlugin } from '../../packages/plugin-sdk/src/loader.js';
import { dispatch, harness, loadFirstPartyPlugin } from './support.js';

let plugin: LoadedPlugin;

beforeAll(async () => {
  plugin = await loadFirstPartyPlugin('adze-destructive-guard');
});

async function bash(command: string) {
  const h = harness(plugin);
  const outcome = await dispatch(h, 'bash', { command });
  return { outcome, seen: h.seen() };
}

describe('the plugin loads through the real loader', () => {
  it('registers one bash-scoped hook', () => {
    expect(plugin.manifest.id).toBe('adze.destructive-guard');
    expect(plugin.hooks.map((hook) => hook.event)).toEqual(['tool.pre']);
    expect(plugin.hooks[0]?.tools).toEqual(['bash']);
  });
});

describe('recursive deletes aimed at broad roots are denied', () => {
  it.each(['rm -rf /', 'rm -rf ~', 'rm -rf .', 'rm -rf $HOME', 'rm -rf /tmp'])(
    'denies %s and never runs it',
    async (command) => {
      const { outcome, seen } = await bash(command);

      expect(outcome.kind).toBe('denied');
      if (outcome.kind !== 'denied') return;
      expect(outcome.source).toBe('hook');
      expect(outcome.reason).toContain('recursive');
      expect(seen).toBeUndefined();
    },
  );

  it('denies the long flag form too', async () => {
    const { outcome } = await bash('rm --recursive --force /');
    expect(outcome.kind).toBe('denied');
  });

  it('allows a scoped remove', async () => {
    const { outcome } = await bash('rm -rf ./packages/thing/dist');
    expect(outcome.kind).toBe('executed');
  });

  it('allows printing the string without running it', async () => {
    // Quoted text is blanked before matching: this deletes nothing.
    const { outcome } = await bash('echo "rm -rf /"');
    expect(outcome.kind).toBe('executed');
  });
});

describe('git discards without recovery are denied', () => {
  it('denies git reset --hard', async () => {
    const { outcome, seen } = await bash('git reset --hard HEAD');

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.reason).toContain('no way to get it back');
    expect(seen).toBeUndefined();
  });

  it('denies git clean -fdx after listing first', async () => {
    const { outcome } = await bash('git clean -fdx');
    if (outcome.kind !== 'denied') throw new Error('expected a denial');
    expect(outcome.reason).toContain('git clean -nd');
  });

  it('allows a soft reset', async () => {
    const { outcome } = await bash('git reset --soft HEAD~1');
    expect(outcome.kind).toBe('executed');
  });
});

describe('database destruction is denied', () => {
  it('denies DROP DATABASE', async () => {
    const { outcome, seen } = await bash('psql -c "DROP DATABASE prod"');

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.reason).toContain('backup');
    expect(seen).toBeUndefined();
  });

  it('denies DELETE without WHERE', async () => {
    const { outcome } = await bash('psql -c "DELETE FROM users"');
    if (outcome.kind !== 'denied') throw new Error('expected a denial');
    expect(outcome.reason).toContain('no WHERE clause');
  });

  it('allows DELETE with WHERE', async () => {
    const { outcome } = await bash('psql -c "DELETE FROM users WHERE id = 1"');
    expect(outcome.kind).toBe('executed');
  });

  it('allows SELECT', async () => {
    const { outcome } = await bash('psql -c "SELECT * FROM users"');
    expect(outcome.kind).toBe('executed');
  });
});

describe('cluster and device destruction is denied', () => {
  it('denies kubectl delete --all', async () => {
    const { outcome } = await bash('kubectl delete pods --all');
    expect(outcome.kind).toBe('denied');
  });

  it('denies deleting a namespace', async () => {
    const { outcome } = await bash('kubectl delete namespace prod');
    expect(outcome.kind).toBe('denied');
  });

  it('denies writing to a device node', async () => {
    const { outcome } = await bash('dd if=image.iso of=/dev/sda bs=4M');
    expect(outcome.kind).toBe('denied');
  });

  it('denies a fork bomb unconditionally', async () => {
    const { outcome } = await bash(':(){ :|:& };:');
    expect(outcome.kind).toBe('denied');
  });

  it('allows naming one pod', async () => {
    const { outcome } = await bash('kubectl get pods');
    expect(outcome.kind).toBe('executed');
  });
});
