/**
 * Surfaces 5 and 6, plus the two load-time refusals that are security properties
 * rather than validation niceties.
 *
 * `src/agents.ts` cites this file for the claim that a subagent cannot widen its
 * parent's grant, and the citation was written before the file existed. Every
 * assertion below is written from the widening direction — asking for more than the
 * parent has — because a test that only asks for less passes against an
 * implementation that ignores the parent entirely.
 */

import { describe, expect, it } from 'vitest';
import { narrowSubagent, type ParentGrant, parseSubagent } from '../src/agents.js';
import { checkEngineCompatibility, NO_PERMISSIONS, parseManifest } from '../src/manifest.js';
import {
  assertNoEngineUi,
  EngineUiRefusedError,
  partitionUi,
  surfaceUiContributions,
} from '../src/ui.js';
import { manifestText } from './support.js';

const PARENT: ParentGrant = {
  tools: ['read', 'grep', 'edit', 'bash'],
  permissions: {
    filesystem: 'read',
    network: ['registry.npmjs.org'],
    env: ['HOME'],
  },
  maxSteps: 20,
};

function subagent(frontmatter: string, prompt = 'Review the staged diff.'): string {
  return `---\n${frontmatter}\n---\n${prompt}\n`;
}

function definitionOf(frontmatter: string) {
  const outcome = parseSubagent('acme.example', 'agents/security.md', subagent(frontmatter));
  if (!outcome.ok) throw new Error(outcome.diagnostics.map((d) => d.message).join('; '));
  return outcome.definition;
}

describe('surface 5 - a subagent narrows and cannot widen', () => {
  it('intersects the requested allowlist with the parent, keeping only the overlap', () => {
    const outcome = narrowSubagent(
      definitionOf('name: security\ndescription: Audit\ntools: [read, grep]'),
      PARENT,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.narrowed.tools).toEqual(['read', 'grep']);
    // The parent's extra tools are not inherited just because they exist.
    expect(outcome.narrowed.tools).not.toContain('bash');
  });

  it('refuses a tool the parent does not have rather than dropping it quietly', () => {
    const outcome = narrowSubagent(
      definitionOf('name: security\ndescription: Audit\ntools: [read, deploy]'),
      PARENT,
    );

    // An error, not a smaller allowlist. A subagent silently missing the tool it was
    // told to use fails in a way that reads as the model being incompetent.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics[0]?.message).toContain('deploy');
    expect(outcome.diagnostics[0]?.severity).toBe('error');
  });

  it('clamps a wider filesystem request to the parent and says it did', () => {
    const outcome = narrowSubagent(
      definitionOf(
        'name: security\ndescription: Audit\ntools: [read]\npermissions: { filesystem: workspace-write }',
      ),
      PARENT,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Asked for workspace-write under a read-only parent.
    expect(outcome.narrowed.permissions.filesystem).toBe('read');
    expect(outcome.narrowed.narrowings).not.toHaveLength(0);
    expect(outcome.narrowed.narrowings[0]?.message).toContain('cannot widen');
  });

  it('accepts a narrower filesystem request', () => {
    const outcome = narrowSubagent(
      definitionOf(
        'name: security\ndescription: Audit\ntools: [read]\npermissions: { filesystem: none }',
      ),
      PARENT,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.narrowed.permissions.filesystem).toBe('none');
  });

  it('lowers a step ceiling and refuses to raise one', () => {
    const lower = narrowSubagent(
      definitionOf('name: a\ndescription: d\ntools: [read]\nmaxSteps: 5'),
      PARENT,
    );
    expect(lower.ok).toBe(true);
    if (lower.ok) expect(lower.narrowed.maxSteps).toBe(5);

    const higher = narrowSubagent(
      definitionOf('name: a\ndescription: d\ntools: [read]\nmaxSteps: 500'),
      PARENT,
    );
    expect(higher.ok).toBe(true);
    // An unbounded child under a bounded parent would let delegation launder the
    // budget, so the parent's ceiling wins.
    if (higher.ok) expect(higher.narrowed.maxSteps).toBe(20);
  });

  it('cannot reach a host or an env var the parent lacks', () => {
    // `network` and `env` cannot be expressed in front matter at all — see the
    // refusals below — so the narrowing that matters here is the fallback: an
    // unspecified request inherits the parent's grant exactly, never more.
    const outcome = narrowSubagent(definitionOf('name: a\ndescription: d\ntools: [read]'), PARENT);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.narrowed.permissions.network).toEqual(['registry.npmjs.org']);
    expect(outcome.narrowed.permissions.env).toEqual(['HOME']);
  });

  it('refuses a network or env narrowing the front-matter grammar cannot carry', () => {
    // Regression. `parseSubagent` hardcoded `permissions: undefined`, so every
    // declared narrowing was discarded in silence and the permission half of
    // `narrowSubagent` was unreachable. A list inside an inline mapping parses as
    // text, so these two are refused with the reason named rather than accepted and
    // dropped.
    for (const line of [
      'permissions: { network: [evil.example] }',
      'permissions: { env: [AWS_SECRET_ACCESS_KEY] }',
    ]) {
      const outcome = parseSubagent(
        'acme.example',
        'agents/security.md',
        subagent(`name: a\ndescription: d\ntools: [read]\n${line}`),
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.diagnostics[0]?.message).toContain('front matter cannot express a list');
    }
  });

  it('refuses a permission key that is not narrowable here', () => {
    const outcome = parseSubagent(
      'acme.example',
      'agents/security.md',
      subagent('name: a\ndescription: d\ntools: [read]\npermissions: { process: true }'),
    );
    expect(outcome.ok).toBe(false);
  });

  it('refuses an unusable filesystem level', () => {
    const outcome = parseSubagent(
      'acme.example',
      'agents/security.md',
      subagent('name: a\ndescription: d\ntools: [read]\npermissions: { filesystem: root }'),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics[0]?.message).toContain('workspace-write');
  });

  it('gives an empty grant nothing to widen from', () => {
    // The degenerate parent. A subagent under a parent holding nothing must resolve to
    // nothing rather than to a default.
    const empty: ParentGrant = { tools: [], permissions: NO_PERMISSIONS, maxSteps: undefined };
    const outcome = narrowSubagent(definitionOf('name: a\ndescription: d\ntools: [read]'), empty);
    expect(outcome.ok).toBe(false);
  });

  it('requires an explicit allowlist rather than inheriting the parent’s', () => {
    const outcome = parseSubagent(
      'acme.example',
      'agents/security.md',
      subagent('name: a\ndescription: d\ntools: []'),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics[0]?.message).toContain('not narrower than its parent');
  });
});

describe('surface 6 - the engine refuses UI', () => {
  const contribution = {
    id: 'acme.status',
    surface: 'cli' as const,
    kind: 'status-bar-item' as const,
  };

  it('throws when a UI contribution is offered to the engine', () => {
    // ADR-0001 rule 3. A thrown error rather than a filter: at registration time the
    // mistake is in code, and a silent filter leaves the author thinking it worked.
    expect(() => assertNoEngineUi([{ ...contribution, pluginId: 'acme.example' }])).toThrow(
      EngineUiRefusedError,
    );
  });

  it('accepts an empty list, so a plugin without UI binds normally', () => {
    expect(() => assertNoEngineUi([])).not.toThrow();
  });

  it('names the plugin and the contribution in the refusal', () => {
    try {
      assertNoEngineUi([{ ...contribution, pluginId: 'acme.example' }]);
      throw new Error('expected a refusal');
    } catch (error) {
      if (!(error instanceof EngineUiRefusedError)) throw error;
      expect(error.pluginId).toBe('acme.example');
      expect(error.contributionId).toBe('acme.status');
      expect(error.message).toContain('ADR-0001');
    }
  });

  it('still loads the plugin, routing UI to the surface that asked', () => {
    // The plugin's hook has to keep working. Refusing to parse `contributes.ui` would
    // cost a plugin its policy in order to protect the engine from a panel it was
    // never going to render.
    const { forSurfaces, refusals } = partitionUi('acme.example', [contribution]);
    expect(refusals).toHaveLength(1);
    expect(surfaceUiContributions(forSurfaces, 'cli')).toHaveLength(1);
    expect(surfaceUiContributions(forSurfaces, 'vscode')).toHaveLength(0);
  });
});

describe('load-time refusals that are security properties', () => {
  it('fails a manifest containing an invisible character', () => {
    // A zero-width joiner inside the display name. The first self-propagating worm on
    // a major extension registry hid its payload in characters a reviewer renders as
    // nothing, so this is an error rather than a warning by intent.
    const outcome = parseManifest(manifestText({ displayName: 'Exa\u200dmple' }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics.some((d) => d.code === 'hidden-characters')).toBe(true);
    expect(outcome.diagnostics.every((d) => d.severity === 'error')).toBe(true);
  });

  it('fails a manifest containing a bidi control character', () => {
    // U+202E right-to-left override: the mechanism behind visually reordered source.
    const outcome = parseManifest(manifestText({ description: 'safe\u202egnorts' }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics.some((d) => d.code === 'hidden-characters')).toBe(true);
  });

  it('refuses an engine range the running engine does not satisfy, and says both', () => {
    const manifest = parseManifest(manifestText({ engines: { adze: '>=2.0.0' } }));
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;

    const outcome = checkEngineCompatibility(manifest.manifest, '0.0.1');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The message has to carry the range and the running version, or the user cannot
    // tell whether to upgrade the engine or the plugin.
    expect(outcome.diagnostic.message).toContain('>=2.0.0');
    expect(outcome.diagnostic.message).toContain('0.0.1');
    expect(outcome.diagnostic.severity).toBe('error');
  });

  it('accepts a range the engine satisfies', () => {
    const manifest = parseManifest(manifestText());
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(checkEngineCompatibility(manifest.manifest, '0.0.1').ok).toBe(true);
  });
});
