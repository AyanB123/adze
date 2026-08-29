import { describe, expect, it } from 'vitest';
import {
  negotiateProtocolVersion,
  PROTOCOL_VERSION,
  ProtocolVersionSchema,
  parseProtocolVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../src/version.js';

describe('protocol version', () => {
  it('advertises the current version as supported', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(PROTOCOL_VERSION);
  });

  it('accepts MAJOR.MINOR and rejects anything else', () => {
    expect(ProtocolVersionSchema.safeParse('0.1').success).toBe(true);
    expect(ProtocolVersionSchema.safeParse('12.34').success).toBe(true);
    // A patch component would imply a distinction we do not make: a patch release
    // cannot change a wire contract.
    expect(ProtocolVersionSchema.safeParse('0.1.0').success).toBe(false);
    expect(ProtocolVersionSchema.safeParse('v0.1').success).toBe(false);
    expect(ProtocolVersionSchema.safeParse('0').success).toBe(false);
    expect(ProtocolVersionSchema.safeParse('').success).toBe(false);
  });

  it('parses components as numbers', () => {
    expect(parseProtocolVersion('3.14')).toEqual({ major: 3, minor: 14 });
    expect(parseProtocolVersion('nope')).toBeUndefined();
  });
});

describe('version negotiation', () => {
  it('agrees when both peers speak the same single version', () => {
    expect(negotiateProtocolVersion(['0.1'], ['0.1'])).toEqual({ ok: true, version: '0.1' });
  });

  it('picks the newest shared version, not the first offered', () => {
    const result = negotiateProtocolVersion(['0.1', '0.3', '0.2'], ['0.2', '0.3']);
    expect(result).toEqual({ ok: true, version: '0.3' });
  });

  it('compares minor versions numerically rather than as strings', () => {
    // '0.9' > '0.10' lexicographically, which is the classic version-sort bug.
    const result = negotiateProtocolVersion(['0.9', '0.10'], ['0.9', '0.10']);
    expect(result).toEqual({ ok: true, version: '0.10' });
  });

  it('does not assume a newer peer speaks older versions implicitly', () => {
    // A peer advertising only 0.3 is taken at its word. Inferring that 0.3 implies
    // 0.1 would be a compatibility promise nobody wrote down, and it breaks
    // silently the first time a minor version removes something.
    const result = negotiateProtocolVersion(['0.3'], ['0.1']);
    expect(result.ok).toBe(false);
  });

  it('distinguishes a missing minor from an incompatible major', () => {
    const sameMajor = negotiateProtocolVersion(['0.2'], ['0.1']);
    expect(sameMajor.ok).toBe(false);
    if (sameMajor.ok) return;
    expect(sameMajor.message).toContain('minor');
    expect(sameMajor.message).toContain('partial install');

    const differentMajor = negotiateProtocolVersion(['2.0'], ['0.1']);
    expect(differentMajor.ok).toBe(false);
    if (differentMajor.ok) return;
    expect(differentMajor.message).toContain('major');
    expect(differentMajor.message).toContain('generation behind');
  });

  it('names both sides in the failure message', () => {
    // The message has to tell a user which component to update. A bare
    // "incompatible version" leaves them guessing between two packages.
    const result = negotiateProtocolVersion(['5.5'], ['0.1']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('5.5');
    expect(result.message).toContain('0.1');
    expect(result.clientVersions).toEqual(['5.5']);
    expect(result.engineVersions).toEqual(['0.1']);
  });

  it('rejects an empty client list with a specific message', () => {
    const result = negotiateProtocolVersion([], ['0.1']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('no protocol versions');
  });

  it('ignores malformed versions but still negotiates a good one alongside them', () => {
    const result = negotiateProtocolVersion(['garbage', '0.1'], ['0.1']);
    expect(result).toEqual({ ok: true, version: '0.1' });
  });

  it('reports malformed input clearly when nothing is usable', () => {
    const result = negotiateProtocolVersion(['garbage', 'v2'], ['0.1']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('well-formed');
    expect(result.message).toContain('MAJOR.MINOR');
  });

  it('defaults the engine side to this build', () => {
    expect(negotiateProtocolVersion([...SUPPORTED_PROTOCOL_VERSIONS])).toEqual({
      ok: true,
      version: PROTOCOL_VERSION,
    });
  });
});
