/**
 * The approval surface.
 *
 * ADR-0007's rule, at this surface: **`never` refuses rather than escalating.** The
 * gate already enforces that — under `never` it does not call the approval channel
 * at all — and this module's job is to not undo it. So {@link policyDecision}
 * answers `deny` unconditionally when the policy forbids prompting, which means
 * even a future gate bug cannot produce a grant here. A policy that silently
 * granted more than it advertised would make the whole permission model
 * untrustworthy, and it is the one behaviour worth defending twice.
 *
 * ### A dismissed prompt is a denial
 *
 * Pressing Escape, clicking away, or reloading the window all produce `undefined`
 * from the quick pick. That is **deny**, not consent and not a retry loop. Failing
 * open would make ignoring the prompt the most permissive way to use the
 * extension, which is backwards; re-prompting until an accepted answer arrives is
 * how a prompt gets answered by muscle memory, which ADR-0007 names as worse than
 * not prompting at all.
 *
 * ### The prompt says what is actually protecting you
 *
 * On Windows there is no OS-level containment, so an approved action runs
 * unconfined. The prompt says so, once per session: "allow this command?" in front
 * of a user who believes a sandbox exists is a question answered with the wrong
 * information. Repeating it on every prompt is how it stops being read.
 */

import type {
  ApprovalDecision,
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalResponse,
  SandboxEnforcement,
} from '@adze/protocol';
import { refusesRatherThanPrompts } from '@adze/protocol';

/**
 * The note attached to a denial issued because the policy forbids asking.
 *
 * Surfaced back to the model, so it can choose another route rather than retrying
 * the same blocked action.
 */
export const NEVER_POLICY_NOTE =
  "approval policy is 'never', so this was refused rather than escalated to the user";

export const DISMISSED_NOTE = 'the approval prompt was dismissed, so no consent was given';

/**
 * The decision the policy makes without asking anyone.
 *
 * `undefined` means the user must be asked. Any other return is final.
 */
export function policyDecision(
  policy: ApprovalPolicy,
  request: ApprovalRequest,
): ApprovalResponse | undefined {
  if (!refusesRatherThanPrompts(policy)) return undefined;
  return { requestId: request.requestId, decision: 'deny', note: NEVER_POLICY_NOTE };
}

export interface ApprovalChoice {
  readonly label: string;
  readonly description: string;
  readonly decision: ApprovalDecision;
}

/**
 * The four decisions, in the order they are offered.
 *
 * `deny` and `abort` are separate because they are different answers: denying lets
 * the agent adapt and try something else, aborting ends the turn. Collapsing them
 * would remove the user's ability to say "stop" as distinct from "not that way".
 */
export const APPROVAL_CHOICES: readonly ApprovalChoice[] = [
  { label: 'Allow once', description: 'Permit this action only', decision: 'allow-once' },
  {
    label: 'Allow for this session',
    description: 'Permit this and anything equivalent until the session ends',
    decision: 'allow-session',
  },
  { label: 'Deny', description: 'Refuse; the agent may try another route', decision: 'deny' },
  { label: 'Deny and stop', description: 'Refuse and end the turn', decision: 'abort' },
];

/**
 * Map a picked label back to a decision.
 *
 * An unrecognised or absent label is a **denial**, not a re-prompt. See the file
 * comment.
 */
export function decisionForLabel(label: string | undefined): ApprovalDecision {
  const choice = APPROVAL_CHOICES.find((candidate) => candidate.label === label);
  return choice?.decision ?? 'deny';
}

export interface ApprovalPresentation {
  readonly title: string;
  /** One line, written for someone deciding in under two seconds. */
  readonly summary: string;
  /** Supporting detail: why the gate stopped, the command, the paths. */
  readonly detail: string;
  /** The button labels, in order. */
  readonly items: readonly string[];
}

const KIND_TITLES: Record<ApprovalRequest['kind'], string> = {
  'tool-call': 'Adze wants to run a tool',
  command: 'Adze wants to run a command',
  'file-write': 'Adze wants to write a file',
  network: 'Adze wants network access',
  'escalate-sandbox': 'Adze wants to widen the sandbox',
};

/**
 * Turn a request into what the quick pick shows.
 *
 * `containmentNote` is included in the detail only when enforcement is
 * `gate-only`, and the caller is responsible for showing it once rather than every
 * time.
 */
export function presentApproval(
  request: ApprovalRequest,
  enforcement: SandboxEnforcement,
  includeContainmentNote: boolean,
): ApprovalPresentation {
  const detail: string[] = [`Why: ${request.reason}`];
  if (request.command !== undefined && request.command.length > 0) {
    detail.push(`Command: ${request.command.join(' ')}`);
  }
  if (request.paths !== undefined && request.paths.length > 0) {
    detail.push(`Paths: ${request.paths.join(', ')}`);
  }
  if (request.toolCall !== undefined) {
    detail.push(`Tool: ${request.toolCall.name}`);
  }
  if (enforcement === 'gate-only' && includeContainmentNote) {
    detail.push(
      'Note: there is no OS-level sandbox on this platform, so an approved action runs unconfined.',
    );
  }
  return {
    title: KIND_TITLES[request.kind],
    summary: request.summary,
    detail: detail.join('\n'),
    items: APPROVAL_CHOICES.map((choice) => choice.label),
  };
}

/** Build the response for a decision the user made. */
export function responseFor(request: ApprovalRequest, label: string | undefined): ApprovalResponse {
  const decision = decisionForLabel(label);
  if (label === undefined) {
    return { requestId: request.requestId, decision, note: DISMISSED_NOTE };
  }
  return { requestId: request.requestId, decision };
}
