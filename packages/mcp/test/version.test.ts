/**
 * Revision negotiation, as the installed SDK actually implements it.
 *
 * These tests double as the record of what `@modelcontextprotocol/sdk@1.30.0` really
 * offers, because the specification this package was written against described a
 * different mechanism. If a future SDK moves negotiation into per-request `_meta` or
 * adds a `server/discover` RPC, the assertions below are what will fail and say so.
 */

import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import {
  ADZE_ACCEPTED_REVISIONS,
  ADZE_PREFERRED_REVISION,
  negotiateRevision,
} from '../src/version.js';

describe('what the SDK actually ships', () => {
  it('names 2025-11-25 as the newest revision, not 2026-07-28', () => {
    // Pinned deliberately. The brief this package was built from specified `2026-07-28`
    // as the target with `2025-11-25` as the fallback; `2026-07-28` does not exist in
    // this SDK, and `2025-11-25` is the newest revision it knows.
    expect(LATEST_PROTOCOL_VERSION).toBe('2025-11-25');
    expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain('2026-07-28');
  });

  it('exposes a fallback ladder of older revisions', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-06-18');
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-03-26');
  });

  it('derives Adze preference from the SDK rather than hard-coding it', () => {
    // A literal here would let the declared revision drift from the schemas used to
    // parse messages, and the failure would look like a bug in a compliant server.
    expect(ADZE_PREFERRED_REVISION).toBe(LATEST_PROTOCOL_VERSION);
    expect(ADZE_ACCEPTED_REVISIONS).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
  });
});

describe('negotiateRevision', () => {
  it('accepts the preferred revision as an exact match', () => {
    const outcome = negotiateRevision(ADZE_PREFERRED_REVISION);
    expect(outcome).toEqual({ ok: true, revision: ADZE_PREFERRED_REVISION, exact: true });
  });

  it('accepts an older revision as a fallback and says it was not exact', () => {
    const outcome = negotiateRevision('2025-03-26');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.revision).toBe('2025-03-26');
      expect(outcome.exact).toBe(false);
    }
  });

  it('accepts every revision on the ladder', () => {
    for (const revision of ADZE_ACCEPTED_REVISIONS) {
      expect(negotiateRevision(revision).ok).toBe(true);
    }
  });

  it('refuses an unknown older revision', () => {
    const outcome = negotiateRevision('2019-01-01');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.offered).toBe('2019-01-01');
      expect(outcome.message).toContain('cannot parse');
      // The message lists what we do accept, so an operator can act on it.
      expect(outcome.message).toContain(ADZE_PREFERRED_REVISION);
    }
  });

  it('refuses a newer revision rather than optimistically accepting it', () => {
    // Tempting to wave through, and wrong: it means parsing with schemas that predate
    // the revision while reporting a revision we cannot validate.
    const outcome = negotiateRevision('2026-07-28');
    expect(outcome.ok).toBe(false);
  });

  it('refuses a malformed value', () => {
    expect(negotiateRevision('').ok).toBe(false);
    expect(negotiateRevision('not-a-date').ok).toBe(false);
  });
});
