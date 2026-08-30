/**
 * `engines.adze` range checking.
 *
 * The property that matters most is at the bottom: an unparseable range is **not**
 * satisfied and is not an unsatisfied range either. Collapsing those two would make a
 * typo look like an incompatible engine, and the fixes differ.
 */

import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersion, satisfiesRange } from '../src/semver.js';

function satisfied(version: string, range: string): boolean {
  const outcome = satisfiesRange(version, range);
  if (!outcome.ok) throw new Error(`range '${range}' did not parse: ${outcome.message}`);
  return outcome.satisfied;
}

describe('parseVersion', () => {
  it('parses a release', () => {
    const outcome = parseVersion('1.2.3');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.version).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  it('parses a prerelease with mixed identifiers', () => {
    const outcome = parseVersion('1.0.0-rc.1');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.version.prerelease).toEqual(['rc', 1]);
  });

  it('ignores build metadata, which carries no precedence', () => {
    const outcome = parseVersion('1.0.0+build.5');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.version.prerelease).toEqual([]);
  });

  it('rejects a leading zero and a partial version', () => {
    expect(parseVersion('01.2.3').ok).toBe(false);
    expect(parseVersion('1.2').ok).toBe(false);
    expect(parseVersion('v1.2.3').ok).toBe(false);
  });
});

describe('compareVersions', () => {
  it('orders by major, minor, then patch', () => {
    const a = parseVersion('1.2.3');
    const b = parseVersion('1.3.0');
    if (!a.ok || !b.ok) throw new Error('setup');
    expect(compareVersions(a.version, b.version)).toBe(-1);
  });

  it('ranks a release above any prerelease of the same triple', () => {
    const release = parseVersion('1.0.0');
    const rc = parseVersion('1.0.0-rc.1');
    if (!release.ok || !rc.ok) throw new Error('setup');
    expect(compareVersions(release.version, rc.version)).toBe(1);
  });

  it('ranks numeric prerelease identifiers below alphanumeric ones', () => {
    const numeric = parseVersion('1.0.0-1');
    const alpha = parseVersion('1.0.0-alpha');
    if (!numeric.ok || !alpha.ok) throw new Error('setup');
    expect(compareVersions(numeric.version, alpha.version)).toBe(-1);
  });
});

describe('satisfiesRange - the forms the spec uses', () => {
  it('handles the spec example, a space-separated conjunction', () => {
    expect(satisfied('1.0.0', '>=0.4.0 <2.0.0')).toBe(true);
    expect(satisfied('2.0.0', '>=0.4.0 <2.0.0')).toBe(false);
    expect(satisfied('0.3.9', '>=0.4.0 <2.0.0')).toBe(false);
  });

  it('reports that the spec example refuses the current engine version', () => {
    // Recorded as a test rather than only as prose: the spec's own manifest example
    // would fail to load against 0.0.1, which is what the engine actually is.
    expect(satisfied('0.0.1', '>=0.4.0 <2.0.0')).toBe(false);
  });

  it('handles caret at and above 1.0.0', () => {
    expect(satisfied('1.9.9', '^1.2.0')).toBe(true);
    expect(satisfied('2.0.0', '^1.2.0')).toBe(false);
    expect(satisfied('1.1.0', '^1.2.0')).toBe(false);
  });

  it('handles caret below 1.0.0, where a minor bump is breaking', () => {
    expect(satisfied('0.2.9', '^0.2.3')).toBe(true);
    expect(satisfied('0.3.0', '^0.2.3')).toBe(false);
    // ^0.0.x pins exactly: below 0.1.0 every segment can break.
    expect(satisfied('0.0.3', '^0.0.3')).toBe(true);
    expect(satisfied('0.0.4', '^0.0.3')).toBe(false);
  });

  it('handles tilde', () => {
    expect(satisfied('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfied('1.3.0', '~1.2.3')).toBe(false);
  });

  it('handles disjunction', () => {
    expect(satisfied('2.5.0', '^1.0.0 || ^2.0.0')).toBe(true);
    expect(satisfied('3.0.0', '^1.0.0 || ^2.0.0')).toBe(false);
  });

  it('treats * as any release', () => {
    expect(satisfied('7.1.2', '*')).toBe(true);
  });
});

describe('satisfiesRange - prereleases', () => {
  it('does not let a prerelease slip into a plain range', () => {
    // Otherwise `>=0.4.0` accepts 1.0.0-alpha.1, and a plugin loads against an engine
    // build that was explicitly not ready.
    expect(satisfied('1.0.0-alpha.1', '>=0.4.0 <2.0.0')).toBe(false);
  });

  it('admits a prerelease when a comparator names one on the same triple', () => {
    expect(satisfied('1.0.0-rc.2', '>=1.0.0-rc.1 <2.0.0')).toBe(true);
  });

  it('still refuses a prerelease of a different triple', () => {
    expect(satisfied('1.5.0-rc.1', '>=1.0.0-rc.1 <2.0.0')).toBe(false);
  });

  it('does not admit a prerelease through *', () => {
    expect(satisfied('1.0.0-rc.1', '*')).toBe(false);
  });
});

describe('satisfiesRange - an unreadable range is never satisfied', () => {
  it('refuses an X-range instead of guessing the bound', () => {
    const outcome = satisfiesRange('1.2.3', '1.x');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('X-range');
  });

  it('refuses a hyphen range by name', () => {
    const outcome = satisfiesRange('1.2.3', '1.0.0 - 2.0.0');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('hyphen');
  });

  it('refuses a partial version in a comparator', () => {
    expect(satisfiesRange('1.2.3', '>=1').ok).toBe(false);
  });

  it('refuses an empty range and points at *', () => {
    const outcome = satisfiesRange('1.2.3', '   ');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('"*"');
  });

  it('refuses * combined with a comparator, which is a typo not a wildcard', () => {
    expect(satisfiesRange('1.2.3', '>=1.0.0 *').ok).toBe(false);
  });

  it('refuses an empty alternative around ||', () => {
    expect(satisfiesRange('1.2.3', '^1.0.0 ||').ok).toBe(false);
  });
});
