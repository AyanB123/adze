/**
 * `adze.commit-conventions`: the sign-off denial, the history-rewrite denials, the
 * Conventional Commits check, and the one `modify` in the plugin.
 *
 * Every case runs through `dispatchToolCall` from `@adze/core`, so an allowed command
 * reaches the `bash` spy and a denied one does not. `h.seen()` is the evidence either way.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { LoadedPlugin } from '../../packages/plugin-sdk/src/loader.js';
import { dispatch, harness, loadFirstPartyPlugin } from './support.js';

let plugin: LoadedPlugin;

beforeAll(async () => {
  plugin = await loadFirstPartyPlugin('adze-commit-conventions');
});

async function bash(command: string) {
  const h = harness(plugin);
  const outcome = await dispatch(h, 'bash', { command });
  return { outcome, seen: h.seen() };
}

describe('the plugin loads through the real loader', () => {
  it('parses both slash commands and the hook', () => {
    expect(plugin.manifest.id).toBe('adze.commit-conventions');
    expect(plugin.commands.map((command) => command.name).sort()).toEqual(['changeset', 'commit']);
    expect(plugin.hooks.map((hook) => hook.event)).toEqual(['tool.pre']);
  });

  it('gives /commit a tool allowlist that cannot write', () => {
    const commit = plugin.commands.find((command) => command.name === 'commit');
    if (commit === undefined) throw new Error('expected a /commit command');
    // The command drafts a message and prints it. It has `bash` because it reads the diff,
    // and deliberately no `write` or `edit`.
    expect(commit.tools).toEqual(['read', 'grep', 'bash']);
    expect(commit.tools).not.toContain('write');
    expect(commit.tools).not.toContain('edit');
  });

  it('keeps the !`git` blocks in the template rather than expanding them at load', () => {
    // Interpolation happens at invocation with a gate-checked runner, not at load. If the
    // template arrived pre-expanded, the command would inline a diff from load time.
    const commit = plugin.commands.find((command) => command.name === 'commit');
    if (commit === undefined) throw new Error('expected a /commit command');
    expect(commit.template).toContain('!`git --no-pager diff --cached`');
  });
});

describe('a commit without a sign-off is denied', () => {
  it('denies a plain -m commit and never runs it', async () => {
    const { outcome, seen } = await bash('git commit -m "feat(core): add a thing"');

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.source).toBe('hook');
    expect(outcome.reason).toContain('Developer Certificate of Origin');
    expect(seen).toBeUndefined();
  });

  it('explains why it is not corrected automatically', async () => {
    // The design decision this plugin exists to demonstrate. If this assertion is ever
    // removed because someone made it a `modify`, the plugin has started signing the DCO
    // on the author's behalf.
    const { outcome } = await bash('git commit -m "fix(apply): stop guessing"');
    if (outcome.kind !== 'denied') throw new Error('expected a denial');
    expect(outcome.reason).toContain('certified something on your behalf');
  });

  it('allows -s', async () => {
    const { outcome, seen } = await bash('git commit -s -m "feat(core): add a thing"');
    expect(outcome.kind).toBe('executed');
    expect(seen).toEqual({ command: 'git commit -s -m "feat(core): add a thing"' });
  });

  it('allows --signoff', async () => {
    const { outcome } = await bash('git commit --signoff -m "docs(adr): record the decision"');
    expect(outcome.kind).toBe('executed');
  });

  it('allows a combined short flag cluster', async () => {
    const { outcome } = await bash('git commit -sm "chore(deps): bump the catalog"');
    expect(outcome.kind).toBe('executed');
  });

  it('allows a sign-off written into the message body', async () => {
    const message = 'fix(core): stop leaking a timer\n\nSigned-off-by: A Name <a@example.com>';
    const { outcome } = await bash(`git commit -m "${message}"`);
    expect(outcome.kind).toBe('executed');
  });

  it('denies -F without -s, because the file cannot be read from a hook', async () => {
    const { outcome } = await bash('git commit -F .git/MSG');
    if (outcome.kind !== 'denied') throw new Error('expected a denial');
    expect(outcome.reason).toContain('cannot read');
  });

  it('allows -s -F, which is the documented Windows path', async () => {
    const { outcome } = await bash('git commit -s -F .git/MSG');
    expect(outcome.kind).toBe('executed');
  });

  it('is not fooled by -s inside the commit message', async () => {
    // A false negative on a policy check is the direction that matters: reading the `-s`
    // in the message text as a sign-off flag would allow an unsigned commit.
    const { outcome } = await bash('git commit -m "docs(cli): explain the -s flag"');
    expect(outcome.kind).toBe('denied');
  });
});

describe('history rewrites are denied', () => {
  it('denies --amend', async () => {
    const { outcome, seen } = await bash('git commit -s --amend -m "fix(core): tweak"');
    if (outcome.kind !== 'denied') throw new Error('expected a denial');
    expect(outcome.reason).toContain('follow-up commit');
    expect(seen).toBeUndefined();
  });

  it('denies --no-verify', async () => {
    const { outcome } = await bash('git commit -s --no-verify -m "fix(core): tweak"');
    expect(outcome.kind).toBe('denied');
  });

  it.each([
    'git push --force origin main',
    'git push -f origin main',
    'git push --force-with-lease',
  ])('denies %s', async (command) => {
    const { outcome, seen } = await bash(command);
    if (outcome.kind !== 'denied') throw new Error('expected a denial');
    expect(outcome.reason).toContain('rewrites the remote branch');
    expect(seen).toBeUndefined();
  });

  it('allows an ordinary push', async () => {
    const { outcome } = await bash('git push origin main');
    expect(outcome.kind).toBe('executed');
  });
});

describe('the message must be a Conventional Commit', () => {
  it.each([
    ['no type prefix', 'git commit -s -m "made the thing faster"'],
    ['an unknown type', 'git commit -s -m "improve(core): make it faster"'],
    ['a trailing period', 'git commit -s -m "perf(core): make it faster."'],
    ['a capitalised summary', 'git commit -s -m "perf(core): Make it faster"'],
  ])('denies %s', async (_label, command) => {
    const { outcome, seen } = await bash(command);
    expect(outcome.kind).toBe('denied');
    expect(seen).toBeUndefined();
  });

  it('names the accepted types, so the retry is informed', async () => {
    const { outcome } = await bash('git commit -s -m "improve(core): make it faster"');
    if (outcome.kind !== 'denied') throw new Error('expected a denial');
    expect(outcome.reason).toContain('refactor');
    expect(outcome.reason).toContain('chore');
  });

  it('allows a breaking-change marker', async () => {
    const { outcome } = await bash('git commit -s -m "feat(protocol)!: rename the event"');
    expect(outcome.kind).toBe('executed');
  });

  it('allows a scopeless subject', async () => {
    const { outcome } = await bash('git commit -s -m "chore: retire the old script"');
    expect(outcome.kind).toBe('executed');
  });
});

describe('a compound command is checked segment by segment', () => {
  it('finds the commit after a &&', async () => {
    // A model writes staging and committing as one bash call. A check anchored at the
    // start of the string would miss this entirely.
    const { outcome, seen } = await bash('git add plugins && git commit -m "feat(plugins): add"');
    expect(outcome.kind).toBe('denied');
    expect(seen).toBeUndefined();
  });

  it('finds a forced push after a semicolon', async () => {
    const { outcome } = await bash('git status; git push --force origin main');
    expect(outcome.kind).toBe('denied');
  });

  it('does not read `git log --grep commit` as a commit', async () => {
    // `commit` appears as an argument rather than as the subcommand. Denying here would
    // block a read-only search.
    const { outcome } = await bash('git log --grep commit --no-pager');
    expect(outcome.kind).toBe('executed');
  });
});

describe('a pageable git command is rewritten rather than denied', () => {
  it('inserts --no-pager, and the rewrite reaches the tool body', async () => {
    // The only `modify` here, and the reason it is one: nothing is being asserted, and a
    // pager in a non-interactive shell presents to the agent as a hung tool call.
    const h = harness(plugin);
    const outcome = await dispatch(h, 'bash', { command: 'git log --oneline -5' });

    expect(outcome.kind).toBe('executed');
    expect(h.seen()).toEqual({ command: 'git --no-pager log --oneline -5' });
  });

  it.each(['diff', 'show', 'blame', 'shortlog'])('rewrites git %s', async (subcommand) => {
    const h = harness(plugin);
    await dispatch(h, 'bash', { command: `git ${subcommand} HEAD` });
    expect(h.seen()).toEqual({ command: `git --no-pager ${subcommand} HEAD` });
  });

  it('does not rewrite twice', async () => {
    const h = harness(plugin);
    await dispatch(h, 'bash', { command: 'git --no-pager log' });
    expect(h.seen()).toEqual({ command: 'git --no-pager log' });
  });

  it('leaves a non-pageable git command alone', async () => {
    const h = harness(plugin);
    await dispatch(h, 'bash', { command: 'git status --short' });
    expect(h.seen()).toEqual({ command: 'git status --short' });
  });
});

describe('the hook stays out of the way otherwise', () => {
  it('ignores a non-git command', async () => {
    const { outcome, seen } = await bash('node --version');
    expect(outcome.kind).toBe('executed');
    expect(seen).toEqual({ command: 'node --version' });
  });

  it('ignores tools other than bash', async () => {
    const h = harness(plugin);
    const outcome = await dispatch(h, 'edit', {
      path: 'src/index.ts',
      edits: [{ search: 'a', replace: 'b' }],
    });
    expect(outcome.kind).toBe('executed');
  });
});
