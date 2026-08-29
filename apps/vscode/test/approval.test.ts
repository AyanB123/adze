import type { ApprovalPolicy, ApprovalRequest } from '@adze/protocol';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_CHOICES,
  DISMISSED_NOTE,
  decisionForLabel,
  NEVER_POLICY_NOTE,
  policyDecision,
  presentApproval,
  responseFor,
} from '../src/approval.js';

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: 'appr_1',
    kind: 'command',
    summary: 'run npm test',
    reason: 'the sandbox mode is read-only',
    ...overrides,
  };
}

describe('policyDecision', () => {
  it('denies unconditionally under the never policy', () => {
    // The gate already refuses without calling this channel. This is the second
    // mechanism, so even a gate bug cannot produce a grant at this surface.
    const decided = policyDecision('never', request());
    expect(decided).toEqual({
      requestId: 'appr_1',
      decision: 'deny',
      note: NEVER_POLICY_NOTE,
    });
  });

  it('asks the user under every policy that permits prompting', () => {
    for (const policy of ['untrusted', 'on-request'] satisfies ApprovalPolicy[]) {
      expect(policyDecision(policy, request())).toBeUndefined();
    }
  });
});

describe('decisionForLabel', () => {
  it('maps every offered label to a decision', () => {
    for (const choice of APPROVAL_CHOICES) {
      expect(decisionForLabel(choice.label)).toBe(choice.decision);
    }
  });

  it('offers deny and abort as separate answers', () => {
    const decisions = APPROVAL_CHOICES.map((choice) => choice.decision);
    expect(decisions).toContain('deny');
    // Deny lets the agent adapt; abort ends the turn. Collapsing them would remove
    // the user's ability to say "stop" as distinct from "not that way".
    expect(decisions).toContain('abort');
    expect(new Set(decisions).size).toBe(APPROVAL_CHOICES.length);
  });

  it('treats a dismissed prompt as a denial, never as consent', () => {
    expect(decisionForLabel(undefined)).toBe('deny');
  });

  it('treats an unrecognised label as a denial rather than re-prompting', () => {
    expect(decisionForLabel('Sure, why not')).toBe('deny');
  });
});

describe('responseFor', () => {
  it('records why a dismissal was denied', () => {
    expect(responseFor(request(), undefined)).toEqual({
      requestId: 'appr_1',
      decision: 'deny',
      note: DISMISSED_NOTE,
    });
  });

  it('returns the chosen decision with no note', () => {
    expect(responseFor(request(), 'Allow for this session')).toEqual({
      requestId: 'appr_1',
      decision: 'allow-session',
    });
  });
});

describe('presentApproval', () => {
  it('includes the reason, the command, and the paths', () => {
    const presentation = presentApproval(
      request({ command: ['npm', 'test'], paths: ['/w/a.ts', '/w/b.ts'] }),
      'os-level',
      false,
    );
    expect(presentation.title).toBe('Adze wants to run a command');
    expect(presentation.summary).toBe('run npm test');
    expect(presentation.detail).toContain('Why: the sandbox mode is read-only');
    expect(presentation.detail).toContain('Command: npm test');
    expect(presentation.detail).toContain('Paths: /w/a.ts, /w/b.ts');
  });

  it('says there is no OS-level containment when there is none', () => {
    const presentation = presentApproval(request(), 'gate-only', true);
    expect(presentation.detail).toContain('no OS-level sandbox');
  });

  it('omits the containment note when the caller has already shown it', () => {
    const presentation = presentApproval(request(), 'gate-only', false);
    expect(presentation.detail).not.toContain('no OS-level sandbox');
  });

  it('never claims a missing sandbox when containment is real', () => {
    const presentation = presentApproval(request(), 'os-level', true);
    expect(presentation.detail).not.toContain('no OS-level sandbox');
  });

  it('titles every approval kind', () => {
    const kinds = [
      'tool-call',
      'command',
      'file-write',
      'network',
      'escalate-sandbox',
    ] satisfies ApprovalRequest['kind'][];
    for (const kind of kinds) {
      const presentation = presentApproval(request({ kind }), 'os-level', false);
      expect(presentation.title.length).toBeGreaterThan(0);
      expect(presentation.items).toHaveLength(APPROVAL_CHOICES.length);
    }
  });
});
