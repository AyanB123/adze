/**
 * Commit Conventions — the repository's own commit rules, enforced at the tool call.
 *
 * `CONTRIBUTING.md` requires a DCO sign-off on every commit and Conventional Commits for
 * the message, and `docs/architecture/adr/README.md` requires an `ADR-00NN` reference for
 * decisions. None of that is checkable by the engine, and all of it is checkable here.
 *
 * ## Why the missing sign-off is a denial and not a rewrite
 *
 * The tempting implementation rewrites `git commit -m "..."` into
 * `git commit -s -m "..."` and lets the agent carry on. `modify` exists, the rewrite is
 * one token, and the agent never loses a step.
 *
 * It is the wrong answer. `-s` appends `Signed-off-by: Name <email>`, which is an
 * assertion under the Developer Certificate of Origin that the committer has the right to
 * submit the code under the project's licence. That is a legal certification about the
 * author, and a plugin adding it on the author's behalf is a tool signing something for
 * a human who did not. So the sign-off rule denies and explains, and the human types
 * `-s`. The DCO's whole value is that a person asserted it.
 *
 * The rewrite path is used for something where nothing is being asserted: a `git log`
 * without `--no-pager` can block on a pager in a non-interactive shell, which presents to
 * the agent as a hung tool call and to the user as the agent freezing. Rewriting it to
 * `git --no-pager log` changes no meaning and removes a real failure mode. That is the
 * distinction between the two outcomes — `modify` for a mechanically safe correction,
 * `deny` for anything a human has to decide.
 *
 * ## Compound commands are split, and the split is quote-aware
 *
 * A model writes `git add plugins && git commit -m "..."` as one `bash` call, so a check
 * anchored at the start of the command string would miss the commit entirely. Every segment
 * is examined.
 *
 * The split has to respect quoting. A real commit message contains newlines — the subject,
 * a blank line, the body, the sign-off trailer — and a naive split on `\n` cuts it in half,
 * leaves the first piece holding an unterminated quote, and finds no sign-off in it. That
 * denies a correctly signed commit, which is the failure that gets a policy hook turned off.
 * The splitter tracks quote state; it is still not a shell parse, and the reasoning for
 * stopping short of one is at {@link segments}.
 *
 * `"runtime": "js"` means **unsandboxed**; the host must pass `allowUnsandboxedJs`.
 */

/** Conventional Commit types, from `CONTRIBUTING.md`. */
const TYPES = ['feat', 'fix', 'docs', 'perf', 'test', 'refactor', 'build', 'ci', 'chore', 'revert'];

/** `type(scope): summary`, with the scope optional and `!` for a breaking change. */
const CONVENTIONAL = /^([a-z]+)(?:\(([a-z0-9-]+)\))?(!)?:\s+(.+)$/s;

/**
 * Split a compound command into segments at `&&`, `||`, `;`, or a newline.
 *
 * Quote-aware, and it has to be. A model writes a real commit message as
 * `git commit -m "fix(core): ...\n\nSigned-off-by: ..."` — a single `bash` call whose
 * argument contains newlines. A naive split on `\n` cuts that message in half, leaves the
 * first segment holding an unterminated quote, and then finds no sign-off in it. The result
 * is a denial of a correctly signed commit, which is the failure that makes a policy hook
 * something people turn off.
 *
 * This is still not a shell parse — it does not handle backslash escapes inside quotes, or
 * subshells — and it is deliberately not. A policy hook containing a shell grammar has a
 * shell grammar's bugs. Its failure mode is that a pathological command is examined as one
 * segment instead of two, which yields a spurious `allow` rather than a wrong `deny`.
 */
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

/**
 * The segment with quoted text blanked out.
 *
 * Every flag and subcommand test below runs against this rather than the raw segment,
 * because `git commit -m "explain the -s flag"` contains the token `-s` inside its own
 * message. Testing the raw string would read that as a sign-off and wave the commit
 * through — a false *negative* on a policy check, which is the direction that matters.
 */
function unquoted(segment) {
  return segment.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/** Whether a segment invokes `git <subcommand>`, allowing for `-C <dir>` and friends. */
function isGitSubcommand(bare, subcommand) {
  if (!/^git\b/.test(bare)) return false;
  const rest = bare.slice(3);
  const found = new RegExp(`\\b${subcommand}\\b`).exec(rest);
  if (found === null) return false;
  // Nothing before the subcommand may be another subcommand-looking bare word, so
  // `git log --grep commit` is not read as a commit.
  const before = rest.slice(0, found.index).trim();
  return before
    .split(/\s+/)
    .every((token) => token.length === 0 || token.startsWith('-') || /^[./~]/.test(token));
}

/** Extract the value of `-m`/`--message`, handling either quote style. */
function messageOf(segment) {
  const quoted = /(?:^|\s)(?:-m|--message)[=\s]+(['"])([\s\S]*?)\1/.exec(segment);
  if (quoted !== null) return quoted[2];
  const bare = /(?:^|\s)(?:-m|--message)[=\s]+(\S+)/.exec(segment);
  return bare === null ? undefined : bare[1];
}

/** `-s`, `--signoff`, or `s` inside a combined short flag cluster such as `-sm`. */
function hasSignoffFlag(bare) {
  if (/(?:^|\s)--signoff(?:\s|$)/.test(bare)) return true;
  return /(?:^|\s)-[a-zA-Z]*s[a-zA-Z]*(?:\s|$)/.test(bare);
}

/**
 * Check the message body against Conventional Commits.
 *
 * Returns a reason string or `undefined`. Each failure names the rule and shows the
 * shape, because "invalid commit message" sends the model to guess and a model guessing
 * at a format produces a second invalid message.
 */
function messageProblem(message) {
  const subject = message.split('\n', 1)[0]?.trim() ?? '';
  if (subject.length === 0) return 'the commit message is empty.';

  const match = CONVENTIONAL.exec(subject);
  if (match === null) {
    return (
      `'${subject}' is not a Conventional Commit subject. Write ` +
      `'<type>(<scope>): <summary>', for example 'fix(apply): reject an ambiguous match ` +
      `instead of taking the first one'. Types: ${TYPES.join(', ')}.`
    );
  }

  const [, type, , , summary] = match;
  if (!TYPES.includes(type)) {
    return `'${type}' is not one of the accepted types: ${TYPES.join(', ')}.`;
  }
  if (summary.endsWith('.')) {
    return `the summary ends with a period. Conventional Commit subjects do not: '${summary}'.`;
  }
  if (/^[A-Z][a-z]/.test(summary)) {
    return (
      `the summary starts with a capital letter ('${summary}'). Write it lowercase and ` +
      `in the imperative, as if completing "this commit will ...".`
    );
  }
  return undefined;
}

/** Rules that are refusals regardless of the message. */
function historyProblem(bare) {
  if (/(?:^|\s)--amend(?:\s|$)/.test(bare)) {
    return (
      `'--amend' rewrites a commit that may already be pushed. This repository's rule is ` +
      `to push a follow-up commit instead, so a reviewer's view of a branch never changes ` +
      `underneath them (CONTRIBUTING.md).`
    );
  }
  if (/(?:^|\s)--no-verify(?:\s|$)/.test(bare)) {
    return (
      `'--no-verify' skips the hooks that check the sign-off and the message format, which ` +
      `is the only thing standing between a commit and a failed merge.`
    );
  }
  return undefined;
}

function pushProblem(bare) {
  if (!isGitSubcommand(bare, 'push')) return undefined;
  const forced = /(?:^|\s)(?:--force|-f|--force-with-lease(?:=\S*)?)(?:\s|$)/.exec(bare);
  if (forced === null) return undefined;
  return (
    `'${forced[0].trim()}' rewrites the remote branch. This repository never force-pushes a ` +
    `branch under review: a reviewer who has already read some of it would silently be ` +
    `reviewing something else (CONTRIBUTING.md). '--force-with-lease' is safer against a ` +
    `race and is still a rewrite. Push a follow-up commit.`
  );
}

/** The sign-off rule. `-F <file>` cannot be read from here, so `-s` is required. */
function signoffProblem(segment, bare) {
  if (hasSignoffFlag(bare)) return undefined;
  const message = messageOf(segment);
  if (message !== undefined && /^Signed-off-by:\s*\S+.*<[^>]+>/m.test(message)) return undefined;

  const readsFile = /(?:^|\s)(?:-F|--file)[=\s]+\S+/.test(bare);
  return (
    `this commit would not carry a Developer Certificate of Origin sign-off, and a commit ` +
    `without one does not merge (CONTRIBUTING.md). Add '-s'.` +
    (readsFile
      ? ` The message comes from a file, which this hook cannot read, so '-s' is the only ` +
        `way to establish the sign-off is there.`
      : '') +
    ` This is refused rather than corrected automatically on purpose: the sign-off is a ` +
    `legal assertion that you have the right to submit the code, and a tool that adds it ` +
    `for you has certified something on your behalf that you did not.`
  );
}

function toolPre(input) {
  if (input.name !== 'bash') return { kind: 'allow' };
  const args = input.arguments ?? {};
  const command = typeof args.command === 'string' ? args.command : '';
  if (command.length === 0) return { kind: 'allow' };

  for (const segment of segments(command)) {
    const bare = unquoted(segment);

    const push = pushProblem(bare);
    if (push !== undefined) return { kind: 'deny', reason: push };

    if (!isGitSubcommand(bare, 'commit')) continue;

    const history = historyProblem(bare);
    if (history !== undefined) return { kind: 'deny', reason: history };

    const message = messageOf(segment);
    if (message !== undefined) {
      const problem = messageProblem(message);
      if (problem !== undefined) return { kind: 'deny', reason: problem };
    }

    const signoff = signoffProblem(segment, bare);
    if (signoff !== undefined) return { kind: 'deny', reason: signoff };
  }

  return pagerRewrite(command, args);
}

/**
 * Add `--no-pager` to a read-only git command that could block on a pager.
 *
 * The only `modify` in this plugin, and the reason it is a `modify` is in the header: it
 * changes no meaning and removes a hang. Applied only when `--no-pager` is absent and no
 * `-c core.pager` is already set, so a rewrite is never applied twice.
 */
function pagerRewrite(command, args) {
  const pageable = /^git\s+(?:log|diff|show|blame|shortlog)\b/;
  if (!pageable.test(command.trim())) return { kind: 'allow' };
  if (/--no-pager|core\.pager/.test(command)) return { kind: 'allow' };
  return {
    kind: 'modify',
    arguments: { ...args, command: command.replace(/^git\s+/, 'git --no-pager ') },
  };
}

export function invoke(functionName, input) {
  // An unknown event is allowed, not denied: a hook that vetoes because it did not
  // understand the question breaks on every engine upgrade that adds an event.
  return functionName === 'tool.pre' ? toolPre(input) : { kind: 'allow' };
}
