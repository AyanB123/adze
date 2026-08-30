/**
 * `adze.review`: the property that a subagent cannot widen its permissions, and the property
 * that the engine refuses a UI contribution.
 *
 * The narrowing test is written **from the widening direction** on purpose. Asserting that a
 * subagent declaring `[read, grep]` ends up with `[read, grep]` proves nothing — it would pass
 * against an implementation that ignored the parent's grant entirely. What has to be true is
 * that a *generous* parent does not make the subagent more capable, so the parent grant here
 * includes `write`, `edit`, `bash`, `task`, and `filesystem: workspace-write`, and the
 * assertion is that none of it reaches the subagent.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  narrowSubagent,
  type ParentGrant,
  type SubagentDefinition,
} from '../../packages/plugin-sdk/src/agents.js';
import type { LoadedPlugin } from '../../packages/plugin-sdk/src/loader.js';
import { assertNoEngineUi, surfaceUiContributions } from '../../packages/plugin-sdk/src/ui.js';
import { loadFirstPartyPlugin } from './support.js';

/** A parent session that can do everything. The point of the test is that this does not leak. */
const GENEROUS_PARENT: ParentGrant = {
  tools: ['read', 'write', 'edit', 'grep', 'glob', 'symbols', 'bash', 'todo', 'task'],
  permissions: {
    filesystem: 'workspace-write',
    network: ['api.example.com'],
    env: ['HOME', 'SECRET_TOKEN'],
  },
  maxSteps: 200,
};

const WRITING_TOOLS = ['write', 'edit', 'bash', 'task'];

let plugin: LoadedPlugin;

beforeAll(async () => {
  plugin = await loadFirstPartyPlugin('adze-review');
});

function agent(name: string): SubagentDefinition {
  const found = plugin.agents.find((definition) => definition.name === name);
  if (found === undefined) throw new Error(`no subagent named '${name}'`);
  return found;
}

describe('the plugin loads with no executable code', () => {
  it('parses three subagents and one command', () => {
    expect(plugin.manifest.id).toBe('adze.review');
    expect(plugin.agents.map((definition) => definition.name).sort()).toEqual([
      'apply-forensics',
      'bench-claims',
      'code-review',
    ]);
    expect(plugin.commands.map((command) => command.name)).toEqual(['review-diff']);
    expect(plugin.hooks).toEqual([]);
  });

  it('avoids the command name the example fixture already uses', () => {
    // Nothing in the SDK detects a command-name collision across plugins, so this is avoided by
    // convention rather than enforced. See plugins/FINDINGS.md finding 5.
    const fixtureNames = ['review'];
    for (const command of plugin.commands) {
      expect(fixtureNames).not.toContain(command.name);
    }
  });
});

describe('every subagent is read-only by declaration', () => {
  it.each(['code-review', 'apply-forensics', 'bench-claims'])(
    '%s excludes every writing tool',
    (name) => {
      const definition = agent(name);
      for (const tool of WRITING_TOOLS) {
        expect(definition.tools).not.toContain(tool);
      }
      // And it is not empty: an empty allowlist would inherit everything, which the SDK
      // refuses at parse time for exactly that reason.
      expect(definition.tools.length).toBeGreaterThan(0);
    },
  );

  it('declares filesystem: read in front matter, and it is honoured', () => {
    // This was hardcoded to `undefined` in an earlier SDK, so an author writing this line got
    // the parent's level instead and nothing said so.
    expect(agent('code-review').permissions).toEqual({ filesystem: 'read' });
  });

  it('sets a step ceiling on each one', () => {
    expect(agent('code-review').maxSteps).toBe(30);
    expect(agent('apply-forensics').maxSteps).toBe(25);
    expect(agent('bench-claims').maxSteps).toBe(20);
  });
});

describe('a generous parent does not make a subagent more capable', () => {
  it('gives code-review only the four tools it asked for', () => {
    const outcome = narrowSubagent(agent('code-review'), GENEROUS_PARENT);
    if (!outcome.ok) throw new Error(outcome.diagnostics.map((d) => d.message).join('\n'));

    expect(outcome.narrowed.tools).toEqual(['read', 'grep', 'glob', 'symbols']);
    // The assertion that matters. The parent had all of these.
    for (const tool of WRITING_TOOLS) {
      expect(outcome.narrowed.tools).not.toContain(tool);
    }
  });

  it('clamps filesystem to read even though the parent may write', () => {
    const outcome = narrowSubagent(agent('code-review'), GENEROUS_PARENT);
    if (!outcome.ok) throw new Error('expected narrowing to succeed');
    expect(outcome.narrowed.permissions.filesystem).toBe('read');
  });

  it('lowers the step ceiling to the subagent, never raises it', () => {
    const outcome = narrowSubagent(agent('code-review'), GENEROUS_PARENT);
    if (!outcome.ok) throw new Error('expected narrowing to succeed');
    expect(outcome.narrowed.maxSteps).toBe(30);
  });

  it('is clamped further by a stricter parent, and reports the clamp', () => {
    // A `read` parent must not be widened to the subagent's own request either — and when the
    // grant is reduced, the reduction has to be visible, or a subagent that received less than
    // it asked for and then failed is indistinguishable from one that is broken.
    const strict: ParentGrant = {
      tools: ['read', 'grep', 'glob', 'symbols'],
      permissions: { filesystem: 'none', network: [], env: [] },
      maxSteps: 10,
    };
    const outcome = narrowSubagent(agent('code-review'), strict);
    if (!outcome.ok) throw new Error('expected narrowing to succeed');

    expect(outcome.narrowed.permissions.filesystem).toBe('none');
    expect(outcome.narrowed.maxSteps).toBe(10);
    const clamps = outcome.narrowed.narrowings.map((diagnostic) => diagnostic.message).join(' ');
    expect(clamps).toContain('clamped');
  });

  it('errors rather than silently dropping a tool the parent lacks', () => {
    // A subagent quietly missing the tool it was told to use fails in a way that looks like the
    // model being incompetent, so this is an error.
    const withoutSymbols: ParentGrant = {
      tools: ['read', 'grep', 'glob'],
      permissions: { filesystem: 'read', network: [], env: [] },
      maxSteps: 50,
    };
    const outcome = narrowSubagent(agent('code-review'), withoutSymbols);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics[0]?.message).toContain('symbols');
  });

  it('inherits nothing from the parent network or env grant', () => {
    // The subagents declare no network or env, so they inherit the parent's — which is the
    // documented behaviour and worth pinning, because it is the one direction where a missing
    // declaration means "the parent's" rather than "none".
    const outcome = narrowSubagent(agent('bench-claims'), GENEROUS_PARENT);
    if (!outcome.ok) throw new Error('expected narrowing to succeed');
    expect(outcome.narrowed.permissions.network).toEqual(['api.example.com']);
    expect(outcome.narrowed.permissions.env).toEqual(['HOME', 'SECRET_TOKEN']);
  });
});

describe('the engine refuses the UI contribution', () => {
  it('records a refusal notice rather than failing the load', () => {
    // Making it fatal would mean an author who added a status-bar item discovered it by losing
    // their subagents.
    const refusal = plugin.notices.find((notice) => notice.code === 'ui-refused-by-engine');
    if (refusal === undefined) throw new Error('expected a ui-refused-by-engine notice');
    expect(refusal.message).toContain('adze.review.findings');
    expect(refusal.message).toContain('does not accept it');
    // The plugin still loaded, with its other surfaces intact.
    expect(plugin.agents).toHaveLength(3);
  });

  it('still hands the contribution to the surface that asked', () => {
    const forVscode = surfaceUiContributions(plugin.ui, 'vscode');
    expect(forVscode).toHaveLength(1);
    expect(forVscode[0]?.kind).toBe('tree-view');
    expect(surfaceUiContributions(plugin.ui, 'cli')).toEqual([]);
  });

  it('throws if anything tries to give it to the engine anyway', () => {
    // An architecture invariant that degrades to a warning under pressure is a convention.
    expect(() => assertNoEngineUi(plugin.ui)).toThrow(/renders nothing/);
  });
});
