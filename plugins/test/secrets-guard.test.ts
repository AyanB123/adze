/**
 * The most important assertions in this directory: `adze.secrets-guard` denies, and the
 * denial stops the call inside `@adze/core`'s real dispatcher.
 *
 * Every test here runs {@link dispatch}, which is `dispatchToolCall` from `@adze/core` —
 * the only place in the engine that calls a tool's `execute`. So `seen()` being
 * `undefined` is not a claim about this plugin's return value; it is evidence that the
 * write never happened.
 *
 * Credential fixtures are built at runtime by {@link fakeCredential} rather than written
 * as literals. A committed file containing a real-looking key would need this plugin's
 * own exemption marker to survive this plugin, which would make the fixture prove the
 * exemption instead of the rule.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { LoadedPlugin } from '../../packages/plugin-sdk/src/loader.js';
import { dispatch, fakeCredential, harness, loadFirstPartyPlugin } from './support.js';

let plugin: LoadedPlugin;

beforeAll(async () => {
  plugin = await loadFirstPartyPlugin('adze-secrets-guard');
});

describe('the plugin loads through the real loader', () => {
  it('registers both hooks the manifest declares', () => {
    expect(plugin.manifest.id).toBe('adze.secrets-guard');
    expect(plugin.hooks.map((hook) => hook.event).sort()).toEqual(['edit.pre', 'tool.pre']);
  });

  it('asks for no filesystem, network, or environment access', () => {
    // A policy hook that inspects text it is handed needs nothing. Asserted because a
    // plugin asking for more than it needs is a plugin users should decline, and the
    // only way that stays true is if it is checked.
    expect(plugin.permissions).toEqual({ filesystem: 'none', network: [], env: [] });
  });
});

describe('a credential in a search/replace edit is denied', () => {
  it('stops the edit and never runs the tool body', async () => {
    const h = harness(plugin);
    const secret = fakeCredential('sk-', 32);

    const outcome = await dispatch(h, 'edit', {
      path: 'src/client.ts',
      edits: [{ search: 'const key = process.env.KEY;', replace: `const key = '${secret}';` }],
    });

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    // `source: 'hook'` rather than `'gate'` is what proves the plugin stopped it: the
    // spy tools declare no effects, so the gate had nothing it could refuse.
    expect(outcome.source).toBe('hook');
    expect(outcome.reason).toContain('adze.secrets-guard');
    // The property under test. A denial that let the body run would satisfy every
    // other assertion in this file.
    expect(h.seen()).toBeUndefined();
  });

  it('explains what to do instead, so the model can adapt in one step', async () => {
    const h = harness(plugin);
    const outcome = await dispatch(h, 'edit', {
      path: 'src/client.ts',
      edits: [{ search: 'x', replace: fakeCredential('ghp_', 40) }],
    });

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.reason).toContain('environment variable');
    expect(outcome.reason).toContain('adze:allow-secret');
  });

  it.each([
    ['an OpenAI key', 'sk-', 32],
    ['a GitHub token', 'ghp_', 40],
    ['a Google API key', 'AIza', 35],
    ['an npm token', 'npm_', 36],
    ['a live Stripe key', 'sk_live_', 24],
    ['a Slack token', 'xoxb-', 24],
  ] as const)('denies %s', async (_label, prefix, length) => {
    const h = harness(plugin);
    const outcome = await dispatch(h, 'edit', {
      path: 'src/config.ts',
      edits: [{ search: 'placeholder', replace: fakeCredential(prefix, length) }],
    });
    expect(outcome.kind).toBe('denied');
    expect(h.seen()).toBeUndefined();
  });

  it('denies an AWS access key id, which has a fixed length rather than a minimum', async () => {
    const h = harness(plugin);
    const outcome = await dispatch(h, 'edit', {
      path: 'terraform/main.tf',
      edits: [{ search: 'var.key', replace: 'AKIAIOSFODNN7EXAMPLE'.slice(0, 20) }],
    });
    expect(outcome.kind).toBe('denied');
  });

  it('denies a PEM private key header', async () => {
    const h = harness(plugin);
    const outcome = await dispatch(h, 'edit', {
      path: 'deploy/id_rsa',
      edits: [{ search: '', replace: '-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n' }],
    });
    expect(outcome.kind).toBe('denied');
    expect(h.seen()).toBeUndefined();
  });
});

describe('a credential in a whole-file write is denied', () => {
  it('is caught on tool.pre, which is the only event that can see it', async () => {
    // The gap this plugin exists to work around: `edit.pre`'s payload reports a
    // whole-file write as `edits: []`, so the content is not there. If this ever
    // starts passing through, a `write` has become a way to bypass the guard.
    const h = harness(plugin);
    const outcome = await dispatch(h, 'write', {
      path: '.env',
      content: `OPENAI_API_KEY=${fakeCredential('sk-', 40)}\n`,
    });

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.source).toBe('hook');
    expect(h.seen()).toBeUndefined();
  });

  it('names the path being written, not just the rule', async () => {
    const h = harness(plugin);
    const outcome = await dispatch(h, 'write', {
      path: 'config/production.json',
      content: `{"token":"${fakeCredential('ghs_', 40)}"}`,
    });
    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.reason).toContain('config/production.json');
  });
});

describe('a credential in a shell command is denied', () => {
  it('refuses a redirect that would write one', async () => {
    const h = harness(plugin);
    const outcome = await dispatch(h, 'bash', {
      command: `echo "${fakeCredential('sk-', 32)}" > .env`,
    });

    expect(outcome.kind).toBe('denied');
    expect(h.seen()).toBeUndefined();
  });

  it('refuses one passed as an HTTP header, which never reaches a file', async () => {
    // The value would live only in the shell history and the trajectory log, and both
    // are places a leaked credential is just as compromised.
    const h = harness(plugin);
    const outcome = await dispatch(h, 'bash', {
      command: `curl -H "Authorization: Bearer ${fakeCredential('sk-ant-', 40)}" https://x`,
    });

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.reason).toContain('a shell command');
  });
});

describe('CI workflow files require human review', () => {
  it.each([
    '.github/workflows/ci.yml',
    '.github/actions/setup/action.yml',
    '.gitlab-ci.yml',
    '.circleci/config.yml',
    'Jenkinsfile',
  ])('denies an unapproved edit to %s', async (path) => {
    const h = harness(plugin);
    const outcome = await dispatch(h, 'edit', {
      path,
      edits: [{ search: 'node-version: 22', replace: 'node-version: 24' }],
    });

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.reason).toContain('grants privileges');
    expect(h.seen()).toBeUndefined();
  });

  it('allows the same edit once a human has approved the path', async () => {
    // The `approvedByHuman` half of the rule. Without this the policy would be "never
    // edit CI", which is not reviewable, just blocked.
    const h = harness(plugin, { approvedByHuman: (path) => path === '.github/workflows/ci.yml' });

    const outcome = await dispatch(h, 'edit', {
      path: '.github/workflows/ci.yml',
      edits: [{ search: 'node-version: 22', replace: 'node-version: 24' }],
    });

    expect(outcome.kind).toBe('executed');
    expect(h.seen()).toEqual({
      path: '.github/workflows/ci.yml',
      edits: [{ search: 'node-version: 22', replace: 'node-version: 24' }],
    });
  });

  it('still denies a credential in an approved CI file', async () => {
    // Approval covers the review rule, not the credential rule. A reviewer approving a
    // workflow change has not thereby approved hardcoding a token into it.
    const h = harness(plugin, { approvedByHuman: () => true });
    const outcome = await dispatch(h, 'edit', {
      path: '.github/workflows/ci.yml',
      edits: [{ search: 'token', replace: `token: ${fakeCredential('ghp_', 40)}` }],
    });
    expect(outcome.kind).toBe('denied');
  });
});

describe('the guard stays out of the way otherwise', () => {
  it('allows an ordinary edit', async () => {
    // The control. Without it, a dispatcher broken in some unrelated way would make
    // every denial above pass for the wrong reason.
    const h = harness(plugin);
    const outcome = await dispatch(h, 'edit', {
      path: 'src/index.ts',
      edits: [{ search: 'const a = 1;', replace: 'const a = 2;' }],
    });

    expect(outcome.kind).toBe('executed');
    expect(h.seen()).toEqual({
      path: 'src/index.ts',
      edits: [{ search: 'const a = 1;', replace: 'const a = 2;' }],
    });
  });

  it('does not fire on a prose mention of a key prefix', async () => {
    // The precision claim. `sk-` in documentation, or a `--sk-` flag, must not deny —
    // a guard that cries wolf gets uninstalled, and an uninstalled guard denies nothing.
    const h = harness(plugin);
    const outcome = await dispatch(h, 'edit', {
      path: 'docs/setup.md',
      edits: [
        {
          search: 'TODO',
          replace: 'Set OPENAI_API_KEY to your sk- key. Do not commit it. See also ghp_ tokens.',
        },
      ],
    });

    expect(outcome.kind).toBe('executed');
  });

  it('honours the exemption marker on the same line', async () => {
    const h = harness(plugin);
    const secret = fakeCredential('sk-', 32);
    const outcome = await dispatch(h, 'edit', {
      path: 'test/fixtures.ts',
      edits: [{ search: 'x', replace: `const fake = '${secret}'; // adze:allow-secret` }],
    });

    expect(outcome.kind).toBe('executed');
  });

  it('does not let the marker on one line exempt the next', async () => {
    // The marker is per line. If it exempted a block, one legitimate fixture would open
    // a hole for everything written after it.
    const h = harness(plugin);
    const outcome = await dispatch(h, 'edit', {
      path: 'test/fixtures.ts',
      edits: [
        {
          search: 'x',
          replace: `const ok = 'a'; // adze:allow-secret\nconst bad = '${fakeCredential('ghp_', 40)}';`,
        },
      ],
    });

    expect(outcome.kind).toBe('denied');
  });

  it('leaves a read alone entirely', async () => {
    const h = harness(plugin);
    const outcome = await dispatch(h, 'read', { path: '.env' });
    expect(outcome.kind).toBe('executed');
  });
});
