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
 * `edit.pre` is the semantically correct event and it is now sufficient for anything
 * that reaches a file. Its payload carries `content` — the bytes a whole-file write
 * would leave on disk — alongside `edits`, so one handler covers all three shapes an
 * edit arrives in: a search/replace block, a whole-file `write`, and an `edit` carrying
 * a whole-file `replacement`. That is where the credential check for file content now
 * lives, and it reads only tool-agnostic fields, so this plugin no longer has to know
 * which tool produced the edit.
 *
 * It did not used to carry `content`. The payload reported a whole-file write as
 * `{ path, edits: [], wholeFile: true }`, so a guard inspecting `edits[].replace` had
 * nothing to inspect and allowed the write — and this plugin worked around that by
 * checking `arguments.content` on `tool.pre` when the tool was named `write`. That
 * workaround had a hole of its own, which is worth recording because it is the exact
 * failure the coupling causes: it keyed on the name `write`, so a credential passed as
 * `edit`'s whole-file `replacement` was seen by neither handler and was written. Any
 * policy that has to enumerate tool names will eventually miss one.
 *
 * `tool.pre` is still registered, for one thing `edit.pre` cannot cover and one it can.
 *
 * Cannot: `bash`. `echo <key> > .env` and
 * `curl -H 'Authorization: Bearer <key>'` leak a credential into the shell history and
 * into the trajectory log without touching an edit tool at all, so no edit event fires.
 *
 * Can: whole-file writes, which are checked on both events deliberately. The `tool.pre`
 * check is redundant under the default edit-tool mapping and is kept as a backstop,
 * because a host can remap which tools derive `edit.pre` and for a credential guard a
 * redundant denial costs nothing while a missed one costs everything. It is a second
 * lock on the same door rather than the only key, which is what it used to be.
 *
 * The CI-review rule stays on `edit.pre` alone, because it needs `approvedByHuman` — a
 * field the `tool.pre` payload does not have.
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
 * `edit.pre`: file content in every shape it arrives in, and the CI-review rule.
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

  // Whole-file bytes, present when the call replaces the entire file — a `write`, or an
  // `edit` carrying a `replacement`. Checked through the payload rather than through
  // `arguments`, so this rule does not depend on what the tool is called.
  const wholeFile = findCredential(input.content);
  if (wholeFile !== undefined) {
    return { kind: 'deny', reason: credentialDenial(wholeFile, `'${path}'`) };
  }

  return { kind: 'allow' };
}

/**
 * `tool.pre`: shell commands, and a second look at whole-file writes.
 *
 * `bash` is the part no edit event covers, because a leaked credential in a shell
 * command never touches an edit tool. The `write` branch is a backstop for the check
 * `edit.pre` already performs: it is redundant under the default edit-tool mapping, and
 * it is kept because a host can remap which tools derive `edit.pre`, and a credential
 * guard should fail to allow rather than fail to deny. See the file header.
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
