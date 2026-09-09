/**
 * The spec is the loader's documentation, so drift between them is a blocker.
 *
 * Finding 3 in `plugins/FINDINGS.md` is that `docs/plugins/spec.md` mentioned
 * neither `runtime` nor `allowUnsandboxedJs`, advertised `adze plugin add` and
 * `adze plugin dev` which do not exist, and pinned `engines.adze` to a range the
 * engine does not satisfy — three blockers before a third party's first
 * successful load. This file pins the fixes: if the spec regresses to any of
 * those states, or the guide regresses to teaching the pre-`content` workaround
 * (finding 1's hole), a test fails here rather than in a stranger's session.
 *
 * These read the committed markdown off disk. That is deliberate: the claim under
 * test is about what an author reading the repository actually sees.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkEngineCompatibility, parseManifest } from '../src/manifest.js';
import { satisfiesRange } from '../src/semver.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function readDoc(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), 'utf8');
}

const spec = () => readDoc('docs/plugins/spec.md');
const guide = () => readDoc('docs/guides/plugins.md');
const pluginsReadme = () => readDoc('plugins/README.md');

/** Every `engines.adze` range the spec shows in a manifest example. */
function specEngineRanges(text: string): string[] {
  const ranges: string[] = [];
  for (const match of text.matchAll(/"adze":\s*"([^"]+)"/g)) {
    const range = match[1];
    if (range !== undefined) ranges.push(range);
  }
  return ranges;
}

describe('the spec documents a plugin that can actually load', () => {
  it('shows no engines range the current engine fails', () => {
    const ranges = specEngineRanges(spec());
    expect(ranges.length).toBeGreaterThan(0);
    for (const range of ranges) {
      const outcome = satisfiesRange('0.0.1', range);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.satisfied).toBe(true);
    }
  });

  it('does not pin the stale example range the SDK never satisfied', () => {
    // The spec once showed ">=0.4.0 <2.0.0" against an engine at 0.0.1, so copying
    // the manifest verbatim produced `engine-mismatch` on first load.
    expect(spec()).not.toContain('>=0.4.0 <2.0.0');
  });

  it('names the runtime field and the unsandboxed-JS opt-in', () => {
    const text = spec();
    expect(text).toContain('runtime');
    expect(text).toContain('allowUnsandboxedJs');
  });

  it('says plainly that no WASM runtime ships and what refuses instead', () => {
    const text = spec();
    expect(text).toContain('no WASM runtime');
    expect(text).toContain('module-unloadable');
  });

  it('documents adze plugin add/dev as built local-only commands', () => {
    const text = spec();
    for (const command of [
      'adze plugin add',
      'adze plugin dev',
      'adze plugin list',
      'adze plugin remove',
      'adze plugin validate',
    ]) {
      expect(text).toContain(command);
    }
    // Local-only: state in .adze/plugins/, no registry service.
    expect(text).toContain('.adze/plugins/');
    // The programmatic path is still documented alongside the CLI.
    expect(text).toContain('loadPlugins');
  });

  it('gives manifest entry shapes instead of comments where shapes belong', () => {
    const text = spec();
    expect(text).toContain('"path": "commands/');
    expect(text).toContain('"path": "agents/');
    expect(text).toContain('"runtime"');
  });

  it('states the exactly-one-dot id rule the loader enforces', () => {
    expect(spec()).toContain('exactly one dot');
  });

  it('every engines range in the spec parses as a manifest the loader accepts', () => {
    // Stronger than the satisfaction check above: the documented range must also
    // survive the manifest schema and the compatibility check end to end.
    const base = {
      id: 'acme.example',
      version: '1.0.0',
      displayName: 'Example',
      description: 'An example plugin.',
      license: 'Apache-2.0',
      repository: 'https://github.com/acme/example',
    };
    for (const range of specEngineRanges(spec())) {
      const parsed = parseManifest(JSON.stringify({ ...base, engines: { adze: range } }));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(checkEngineCompatibility(parsed.manifest, '0.0.1').ok).toBe(true);
    }
  });
});

describe('the guide teaches the fixed edit.pre pattern', () => {
  it('tells authors to read content as well as edits', () => {
    const text = guide();
    expect(text).toContain('content');
    expect(text).toMatch(/edits\[\]\.replace|edits.*replace/);
  });

  it('no longer claims whole-file bytes are absent from the payload', () => {
    // The pre-fix sentence: "the bytes being written are not in the payload at
    // all". Teaching it after `content` landed would send an author back to
    // policing file writes by tool name — the coupling with the hole in it.
    expect(guide()).not.toContain('are not in the payload at all');
  });

  it('keeps tool.pre as the shell backstop, not the file-content key', () => {
    expect(guide()).toContain('bash');
  });
});

describe('the plugin directory documents the command that exists', () => {
  it('plugins/README.md shows adze plugin usage, not a missing command', () => {
    const text = pluginsReadme();
    expect(text).toContain('adze plugin add');
    expect(text).toContain('adze plugin dev');
    expect(text).not.toContain('does not exist');
  });
});
