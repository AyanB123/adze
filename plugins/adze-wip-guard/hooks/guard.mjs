/**
 * WIP Guard — temporary work stays out of the history.
 *
 * `adze.commit-conventions` owns the message *format* (Conventional Commits), the DCO
 * sign-off, and history rewrites (`--amend`, `--force`). This plugin owns the two
 * adjacent rules that are about *intent* rather than format, deliberately without
 * overlapping that plugin's denials so each refusal names exactly one policy:
 *
 * 1. **No temporary commit messages.** `WIP`, `fixup!`, `squash!`, `TMP`, `DO NOT
 *    COMMIT`, and `DO NOT MERGE` are markers for work that is not ready to review.
 *    A temporary message that lands in the history stays there, and the follow-up
 *    that was supposed to replace it is how a branch under review silently changes
 *    meaning (CONTRIBUTING.md: push a follow-up commit instead of rewriting).
 * 2. **No direct pushes to `main` or `master`.** Work lands through a branch and a
 *    review, never by pushing the protected branch itself.
 *
 * ## Message extraction, not substring search
 *
 * The check runs against the value of `-m`/`--message`, not the whole command string,
 * because `git commit -m "explain the WIP flag"` contains the token inside its own
 * explanation. Testing the raw string would deny a commit that only mentions the
 * marker, which is the failure that gets a policy hook turned off.
 *
 * `"runtime": "js"` means **unsandboxed**; the host must pass `allowUnsandboxedJs`.
 * A published build would compile this policy to `wasm32-wasip2` and need no flag.
 */

const TEMPORARY = [
  { label: "'WIP'", pattern: /(?:^|\s)WIP\b/i },
  { label: "'fixup!'", pattern: /\bfixup!/i },
  { label: "'squash!'", pattern: /\bsquash!/i },
  { label: "'TMP'", pattern: /(?:^|\s)TMP\b/ },
  { label: "'DO NOT COMMIT'", pattern: /DO NOT COMMIT/i },
  { label: "'DO NOT MERGE'", pattern: /DO NOT MERGE/i },
];

function segments(command) {
  const parts = [];
  let current = '';
  let quote;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === '&&' || pair === '||') {
      parts.push(current);
      current = '';
      index += 1;
      continue;
    }
    if (character === ';' || character === '\n') {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function messageOf(segment) {
  const quoted = /(?:^|\s)(?:-m|--message)[=\s]+(['"])([\s\S]*?)\1/.exec(segment);
  if (quoted !== null) return quoted[2];
  const bare = /(?:^|\s)(?:-m|--message)[=\s]+(\S+)/.exec(segment);
  return bare === null ? undefined : bare[1];
}

function isGitSubcommand(bare, subcommand) {
  if (!/^git\b/.test(bare)) return false;
  const rest = bare.slice(3);
  const found = new RegExp(`\\b${subcommand}\\b`).exec(rest);
  if (found === null) return false;
  const before = rest.slice(0, found.index).trim();
  return before
    .split(/\s+/)
    .every((token) => token.length === 0 || token.startsWith('-') || /^[./~]/.test(token));
}

function unquoted(segment) {
  return segment.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

function temporaryProblem(message) {
  for (const entry of TEMPORARY) {
    if (entry.pattern.test(message)) {
      return (
        `this commit message contains ${entry.label}, which marks work that is not ready ` +
        `to review. Finish the work or keep it uncommitted; a temporary marker that lands ` +
        `in the history stays there (policy: adze.wip-guard).`
      );
    }
  }
  return undefined;
}

function protectedPushProblem(bare) {
  if (!isGitSubcommand(bare, 'push')) return undefined;
  const target = /(?:^|\s)push\b((?:\s+(?:-[^\s]+(?:=\S+)?|\S+))*)\s*$/.exec(bare);
  if (target === null) return undefined;
  const tokens = target[1]
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !t.startsWith('-'));
  const branch = tokens.length > 0 ? tokens[tokens.length - 1] : '';
  const names = ['main', 'master', 'origin/main', 'origin/master'];
  const direct = tokens.some((t) => names.includes(t)) || names.includes(branch);
  const explicitRef = /refs\/heads\/(main|master)/.test(bare);
  if (!direct && !explicitRef) return undefined;
  return (
    `'${bare.trim()}' pushes straight to a protected branch. Work lands through a feature ` +
    `branch and a review, never by pushing 'main' or 'master' directly ` +
    `(policy: adze.wip-guard). Push the feature branch instead.`
  );
}

function toolPre(input) {
  if (input.name !== 'bash') return { kind: 'allow' };
  const args = input.arguments ?? {};
  const command = typeof args.command === 'string' ? args.command : '';
  if (command.length === 0) return { kind: 'allow' };
  for (const segment of segments(command)) {
    const bare = unquoted(segment);
    const push = protectedPushProblem(bare);
    if (push !== undefined) return { kind: 'deny', reason: push };
    if (!isGitSubcommand(bare, 'commit')) continue;
    const message = messageOf(segment);
    if (message === undefined) continue;
    const problem = temporaryProblem(message);
    if (problem !== undefined) return { kind: 'deny', reason: problem };
  }
  return { kind: 'allow' };
}

export function invoke(functionName, input) {
  return functionName === 'tool.pre' ? toolPre(input) : { kind: 'allow' };
}
