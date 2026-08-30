/**
 * Secrets Guard — the plugin that proves a team can encode policy without forking.
 *
 * Two rules, both denials, both enforced before anything reaches the filesystem:
 *
 * 1. **Nothing that looks like a credential may be written.** Not into a source
 *    file, not into a whole-file replacement, not as an argument to a shell command.
 * 2. **CI workflow files require human review.** A workflow file is the one place in
 *    a repository where a change grants privileges rather than using them, so an
 *    agent editing one unattended is a privilege-escalation path regardless of
 *    intent.
 *
 * ## Why this needs two events rather than one
 *
 * `edit.pre` is the semantically correct event and it is not sufficient. Its payload
 * carries `edits: [{ search, replace }]`, which is everything for the `edit` tool and
 * **nothing for the `write` tool**: `@adze/plugin-sdk`'s `readCoreWriteArgs` reports a
 * whole-file write as `{ path, edits: [], wholeFile: true }`, so the content being
 * written is not in the declared payload at all. A guard that only registered
 * `edit.pre` would refuse a credential added by `edit` and wave through the same
 * credential written by `write` — which is the worse of the two, because `write`
 * replaces the whole file.
 *
 * So the credential check for whole-file writes runs on `tool.pre`, where
 * `arguments` is a declared field and `arguments.content` is the actual bytes. The
 * same handler covers `bash`, because `echo <key> > .env` and
 * `curl -H 'Authorization: Bearer <key>'` leak a credential into the shell history
 * and into the trajectory log without touching an edit tool at all.
 *
 * The `edit.pre` handler keeps the two things only it can do: the search/replace
 * blocks, and the CI-review rule, which needs `approvedByHuman` — a field the
 * `tool.pre` payload does not have.
 *
 * ## The patterns are prefix-anchored and length-checked on purpose
 *
 * Every pattern below requires a known issuer prefix *and* a plausible secret length.
 * Matching `sk-` alone would fire on the word "sk-" in prose and on `--sk-flag`; a
 * guard that cries wolf gets uninstalled, and an uninstalled guard denies nothing.
 * The cost of that precision is stated rather than hidden: this catches
 * **recognisable** credentials, not high-entropy strings in general. It is a
 * structural check, not entropy analysis, and a bespoke internal token format will
 * pass it.
 *
 * ## The escape hatch, and why it is a marker rather than a path allowlist
 *
 * A repository with credential-shaped test fixtures needs a way to say so, or the
 * guard becomes unusable in exactly the codebases most likely to install it. The
 * exemption is the marker `adze:allow-secret` **on the same line**, not a directory
 * allowlist: a per-line marker appears in the diff a reviewer reads, whereas
 * `test/**` as an allowlist is invisible at review and quietly grows.
 *
 * `"runtime": "js"` means **unsandboxed** — this file runs in the Adze process with
 * full privileges, so the host must pass `allowUnsandboxedJs`. A published build
 * would compile to `wasm32-wasip2` and need no flag.
 */

/** The marker that exempts one line. See the header. */
const ALLOW_MARKER = 'adze:allow-secret';

/**
 * Recognisable credential shapes.
 *
 * Each entry is a prefix a specific issuer controls plus the length that issuer
 * emits. None of these regexes contains a credential; they contain a prefix and a
 * character-class quantifier, which is why this file is safe to commit.
 */
const CREDENTIAL_PATTERNS = [
  { label: 'an OpenAI-style API key', pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/ },
  { label: 'a GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { label: 'an AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'a PEM private key', pattern: /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/ },
  { label: 'a Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'a Google API key', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/ },
  { label: 'a live Stripe key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { label: 'an npm access token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
];

/**
 * Paths whose change grants privileges rather than using them.
 *
 * Anchored so `docs/github-workflows.md` is not caught. GitLab, CircleCI, and
 * Jenkins are included because a policy that only knows about GitHub Actions is a
 * policy that stops working the moment a team migrates.
 */
const CI_PATHS = [
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)\.github\/actions\//i,
  /(^|\/)\.gitlab-ci\.yml$/i,
  /(^|\/)\.circleci\/config\.yml$/i,
  /(^|\/)Jenkinsfile$/i,
  /(^|\/)azure-pipelines\.yml$/i,
];

/** Find the first credential in `text`, skipping lines that carry the marker. */
function findCredential(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  for (const line of text.split('\n')) {
    if (line.includes(ALLOW_MARKER)) continue;
    for (const entry of CREDENTIAL_PATTERNS) {
      if (entry.pattern.test(line)) return entry.label;
    }
  }
  return undefined;
}

/**
 * The denial text.
 *
 * Written for a model to act on rather than for a log. It names what was found, why
 * it is refused, and the two concrete next actions — because a denial the model
 * cannot adapt to costs a full retry loop and usually ends in the model trying the
 * same write through a different tool.
 */
function credentialDenial(label, where) {
  return (
    `this would write ${label} into ${where}. A credential committed to a repository ` +
    `is compromised the moment it is pushed, and rewriting history does not un-leak ` +
    `it (policy: adze.secrets-guard). Read the value from an environment variable at ` +
    `runtime and document the variable name instead. If this is a deliberate test ` +
    `fixture, put the marker '${ALLOW_MARKER}' on that line so the exemption is ` +
    `visible in the diff.`
  );
}

function isCiPath(path) {
  return CI_PATHS.some((pattern) => pattern.test(path));
}

/**
 * `edit.pre`: the search/replace blocks, and the CI-review rule.
 *
 * The CI check runs before the credential check. Both are denials, so the order
 * cannot change the outcome, but it does change which reason the model is told — and
 * "this file needs review" is the more actionable of the two when both are true,
 * because it does not send the model off to restructure a secret it also cannot
 * write.
 */
function editPre(input) {
  const path = typeof input.path === 'string' ? input.path : '';

  if (isCiPath(path) && input.approvedByHuman !== true) {
    return {
      kind: 'deny',
      reason:
        `'${path}' is a CI workflow definition, and a change there grants privileges ` +
        `rather than using them — a workflow can be given secrets access, write ` +
        `permission on the repository, or a new trigger. It requires human review ` +
        `before it is written (policy: adze.secrets-guard). Describe the change you ` +
        `want and a reviewer will apply it.`,
    };
  }

  const edits = Array.isArray(input.edits) ? input.edits : [];
  for (const edit of edits) {
    const label = findCredential(edit?.replace);
    if (label !== undefined) return { kind: 'deny', reason: credentialDenial(label, `'${path}'`) };
  }

  return { kind: 'allow' };
}

/**
 * `tool.pre`: whole-file writes and shell commands.
 *
 * This is the half `edit.pre` structurally cannot cover. See the file header.
 */
function toolPre(input) {
  const args = input.arguments ?? {};

  if (input.name === 'write') {
    const path = typeof args.path === 'string' ? args.path : '(unknown path)';
    const label = findCredential(args.content);
    if (label !== undefined) return { kind: 'deny', reason: credentialDenial(label, `'${path}'`) };
    return { kind: 'allow' };
  }

  if (input.name === 'bash') {
    const label = findCredential(args.command);
    if (label !== undefined) {
      return {
        kind: 'deny',
        // A shell command is a different leak from a file write and the reason says
        // so: the value never reaches a file, and it is still recorded.
        reason: credentialDenial(label, 'a shell command'),
      };
    }
  }

  return { kind: 'allow' };
}

export function invoke(functionName, input) {
  switch (functionName) {
    case 'edit.pre':
      return editPre(input);
    case 'tool.pre':
      return toolPre(input);
    default:
      // An unknown event is allowed, not denied. This module has no opinion about
      // events it did not register for, and a hook that vetoes because it did not
      // understand the question breaks on every engine upgrade that adds an event.
      return { kind: 'allow' };
  }
}
