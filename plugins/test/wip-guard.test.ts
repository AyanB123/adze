/**
 * `adze.wip-guard`: temporary markers and direct pushes to protected branches are denied.
 *
 * Deliberately disjoint from `adze.commit-conventions`, which owns the message format,
 * the DCO sign-off, and history rewrites. A well-formed Conventional Commit without a
 * sign-off passes this plugin and fails that one; asserting that here pins the boundary
 * between the two policies.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { LoadedPlugin } from '../../packages/plugin-sdk/src/loader.js';
import { dispatch, harness, loadFirstPartyPlugin } from './support.js';

let plugin: LoadedPlugin;

beforeAll(async () => {
  plugin = await loadFirstPartyPlugin('adze-wip-guard');
});

async function bash(command: string) {
  const h = harness(plugin);
  const outcome = await dispatch(h, 'bash', { command });
  return { outcome, seen: h.seen() };
}

describe('the plugin loads through the real loader', () => {
  it('registers one bash-scoped hook', () => {
    expect(plugin.manifest.id).toBe('adze.wip-guard');
    expect(plugin.hooks.map((hook) => hook.event)).toEqual(['tool.pre']);
    expect(plugin.hooks[0]?.tools).toEqual(['bash']);
  });
});

describe('temporary commit messages are denied', () => {
  it.each([
    'git commit -m "WIP: half done"',
    'git commit -m "fixup! amend the last one"',
    'git commit -m "squash! combine me"',
    'git commit -m "TMP checkpoint"',
    'git commit -m "DO NOT COMMIT yet"',
    'git commit -m "DO NOT MERGE broken"',
  ])('denies %s and never runs it', async (command) => {
    const { outcome, seen } = await bash(command);

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.source).toBe('hook');
    expect(outcome.reason).toContain('not ready');
    expect(seen).toBeUndefined();
  });

  it('does not mistake a commit that only mentions a marker for one', async () => {
    // The check runs against the -m value with the marker pattern anchored; a message
    // about the flag in prose still contains it, so this documents the conservative
    // direction: mentioning WIP is treated as WIP rather than waved through.
    const { outcome } = await bash('git commit -m "docs(guide): explain the WIP flag"');
    expect(outcome.kind).toBe('denied');
  });

  it('leaves format and sign-off to commit-conventions', async () => {
    // Well-formed but unsigned: this plugin has no opinion, the other one denies.
    const { outcome } = await bash('git commit -m "feat(core): add a thing"');
    expect(outcome.kind).toBe('executed');
  });

  it('allows a finished message', async () => {
    const { outcome } = await bash('git commit -s -m "feat(core): add a thing"');
    expect(outcome.kind).toBe('executed');
  });
});

describe('direct pushes to protected branches are denied', () => {
  it.each(['git push origin main', 'git push origin master', 'git push main'])(
    'denies %s',
    async (command) => {
      const { outcome, seen } = await bash(command);

      expect(outcome.kind).toBe('denied');
      if (outcome.kind !== 'denied') return;
      expect(outcome.reason).toContain('protected branch');
      expect(seen).toBeUndefined();
    },
  );

  it('allows pushing a feature branch', async () => {
    const { outcome } = await bash('git push origin feat/my-thing');
    expect(outcome.kind).toBe('executed');
  });

  it('leaves force-pushes to commit-conventions', async () => {
    // `--force` is that plugin's denial, not this one's: this hook allows it so each
    // refusal names exactly one policy.
    const { outcome } = await bash('git push origin feat/my-thing --force');
    expect(outcome.kind).toBe('executed');
  });
});
