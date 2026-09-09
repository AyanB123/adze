/**
 * Destructive Guard — irreversible shell commands, refused before they run.
 *
 * This plugin polices `bash` only. It never sees file content, so it registers
 * `tool.pre` with a host-side `tools: ["bash"]` filter and nothing else. The host
 * never enters the guest for `read`, `edit`, or `write`, which is the point of the
 * filter: a policy hook that runs on every call costs a round-trip per call per
 * installed plugin (plugins/FINDINGS.md finding 2).
 *
 * ## What is denied, and what is not
 *
 * Denied: commands that are hard to undo — recursive deletes aimed at broad roots,
 * database drops and unscoped deletes, `kubectl delete` against a whole namespace,
 * `git reset --hard` and `git clean -fdx`, disk writes to device nodes, and fork
 * bombs. Each denial names the pattern and the safe alternative, because a denial
 * the model cannot adapt to costs a retry loop that usually ends in the same
 * command through a different spelling.
 *
 * Not denied: anything reversible, anything scoped to one file, and anything the
 * hook is unsure about. Where the check is unsure it allows, and a human review
 * decides. A hook that wrongly denies blocks legitimate work and gets uninstalled;
 * a hook that wrongly allows costs a second look. Those are not symmetric costs.
 *
 * ## Quoting
 *
 * Every test below runs against the segment with quoted text blanked out, because
 * `echo "rm -rf /"` contains the token but deletes nothing. Testing the raw string
 * would deny a command that only prints one, which is the failure that gets a
 * policy hook turned off.
 *
 * `"runtime": "js"` means **unsandboxed**; the host must pass `allowUnsandboxedJs`.
 * A published build would compile this policy to `wasm32-wasip2` and need no flag.
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

function unquoted(segment) {
  return segment.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

function rmProblem(bare) {
  if (!/\brm\b/.test(bare)) return undefined;
  if (!/(?:^|\s)-[a-zA-Z]*r[a-zA-Z]*/.test(bare) && !/(?:^|\s)--recursive(?:\s|$)/.test(bare)) {
    return undefined;
  }
  // Targets are the tokens after `rm` and its flags: `./packages/thing/dist` is scoped
  // and allowed, while `/`, `~`, `.`, and top-level system directories are not. Checking
  // whole tokens (rather than a substring for `.`) is what keeps `./path` allowed while
  // bare `.` is denied.
  const tokens = bare.trim().split(/\s+/);
  const targets = tokens.filter(
    (token) =>
      token.length > 0 &&
      token !== 'rm' &&
      !token.startsWith('-') &&
      token !== "''" &&
      token !== '""',
  );
  const BROAD = new Set(['/', '~', '$HOME', '.', './', '*', '/*']);
  for (const target of targets) {
    const clean = target.replace(/^['"]|['"]$/g, '');
    // Any `$VAR` root is a home-or-worse expansion the hook cannot resolve, so it is
    // treated as broad rather than enumerated (`$HOME`, `${HOME}`, `$USERPROFILE`).
    // Written as a prefix check so the source never contains a `${...}` literal.
    if (clean.startsWith('$') || BROAD.has(clean)) {
      return (
        `this would run a recursive delete aimed at a broad root ('${bare.trim()}'). A recursive ` +
        `remove aimed at '/', '~', '.', or a top-level directory is how a whole checkout or a home ` +
        `directory disappears in one call (policy: adze.destructive-guard). Name the exact ` +
        `directory or file to remove, have a human confirm it, and then run the narrow command.`
      );
    }
    if (/^\/(tmp|home|Users|var|etc)(\/)?$/.test(clean)) {
      return (
        `this would run a recursive delete aimed at a broad root ('${bare.trim()}'). A recursive ` +
        `remove aimed at '/', '~', '.', or a top-level directory is how a whole checkout or a home ` +
        `directory disappears in one call (policy: adze.destructive-guard). Name the exact ` +
        `directory or file to remove, have a human confirm it, and then run the narrow command.`
      );
    }
  }
  return undefined;
}

function gitDestructiveProblem(bare) {
  if (/\bgit\b.*\breset\b.*--hard\b/.test(bare)) {
    return (
      `'git reset --hard' discards uncommitted work with no way to get it back. Stash or commit ` +
      `first, have a human confirm the discard is intended, and then run it by hand ` +
      `(policy: adze.destructive-guard).`
    );
  }
  // Combined short flags (`-fdx`) carry both letters in one token, so each flag is
  // matched as a letter inside a `-xyz` cluster rather than as `-f` followed by a
  // boundary. A pattern requiring the boundary reads `-fdx` as `-f` only and misses `-d`.
  const hasClean = /\bgit\b.*\bclean\b/.test(bare);
  const hasForce = /(?:^|\s)-[a-zA-Z]*f/.test(bare);
  const hasDirs = /(?:^|\s)-[a-zA-Z]*d/.test(bare);
  if (hasClean && hasForce && hasDirs) {
    return (
      `'git clean -fd' deletes untracked files and directories the repository has never seen, ` +
      `including work that has no commit to recover from. List what would go with ` +
      `'git clean -nd' first and have a human confirm (policy: adze.destructive-guard).`
    );
  }
  if (/\bgit\b.*\bcheckout\b.*--\s+\.\s*$/.test(bare)) {
    return (
      `'git checkout -- .' discards every uncommitted change in the working tree at once. ` +
      `Narrow it to the paths you mean to revert, or stash first ` +
      `(policy: adze.destructive-guard).`
    );
  }
  return undefined;
}

function databaseProblem(segment) {
  // SQL usually arrives inside quotes (`psql -c "DROP DATABASE prod"`), which the
  // `unquoted` blanking removes — so this check runs against the raw segment, not the
  // blanked one. The cost is stated: `echo "DROP DATABASE"` (which only prints) is
  // denied too, because telling "prints SQL" from "runs SQL" is a shell parse and a
  // policy hook containing a shell grammar has a shell grammar's bugs. For a
  // destructive-database guard the safe direction is to deny the string.
  const upper = segment.toUpperCase();
  if (/\bDROP\s+(?:DATABASE|SCHEMA)\b/.test(upper)) {
    return (
      `this would drop a whole database or schema, which deletes every table in it at once. ` +
      `Confirm the target with a human, take a backup you have tested restoring, and run it ` +
      `by hand (policy: adze.destructive-guard).`
    );
  }
  if (/\bDROP\s+TABLE\b/.test(upper)) {
    return (
      `this would drop a table. Confirm the table name with a human and check that a migration, ` +
      `not a shell command, is the right way to do it (policy: adze.destructive-guard).`
    );
  }
  if (/\bTRUNCATE\s+TABLE\b/.test(upper)) {
    return (
      `this would truncate a table, deleting every row without a WHERE clause to narrow it. ` +
      `Confirm with a human first (policy: adze.destructive-guard).`
    );
  }
  const deleteFrom = /\bDELETE\s+FROM\s+\S+/.exec(upper);
  if (deleteFrom !== null && !/\bWHERE\b/.test(upper)) {
    return (
      `this would run '${deleteFrom[0]}' with no WHERE clause, deleting every row in the ` +
      `table. Add the predicate you mean, or confirm with a human that all rows should go ` +
      `(policy: adze.destructive-guard).`
    );
  }
  return undefined;
}

function clusterProblem(bare) {
  if (/\bkubectl\b.*\bdelete\b.*--all\b/.test(bare)) {
    return (
      `this would delete every resource of a kind, possibly across namespaces. Name the ` +
      `resource and confirm with a human first (policy: adze.destructive-guard).`
    );
  }
  if (/\bkubectl\b.*\bdelete\b.*\bnamespace\b/.test(bare)) {
    return (
      `this would delete a whole namespace, which deletes everything in it. Confirm with a ` +
      `human and run it by hand (policy: adze.destructive-guard).`
    );
  }
  if (/\bdocker\b.*\bsystem\b.*\bprune\b/.test(bare) && /(?:^|\s)-a(?:\s|$)/.test(bare)) {
    return (
      `'docker system prune -a' removes every unused image on the machine, which the next ` +
      `build pays back in full download time. Drop '-a' or confirm with a human ` +
      `(policy: adze.destructive-guard).`
    );
  }
  return undefined;
}

function deviceProblem(bare) {
  if (/\bdd\b.*\bof=\/dev\//.test(bare)) {
    return (
      `this would write raw bytes to a device node ('${bare.trim()}'). A wrong 'of=' target ` +
      `destroys the disk it names with no recovery. Have a human run it by hand ` +
      `(policy: adze.destructive-guard).`
    );
  }
  if (/\bmkfs(?:\.\w+)?\b/.test(bare)) {
    return (
      `this would make a filesystem, destroying whatever is on the target device. Have a ` +
      `human run it by hand (policy: adze.destructive-guard).`
    );
  }
  // The classic `:(){ :|:& };:` is split by `segments()` at its `;`, so requiring a
  // trailing `;` in the pattern means neither half matches. Match the shape instead:
  // a function definition with a pipe-to-background body.
  if (/\(\)\s*\{/.test(bare) && bare.includes(':|:') && bare.includes('&')) {
    return (
      `this looks like a fork bomb, which makes the machine unusable until it is rebooted. ` +
      `It is refused unconditionally (policy: adze.destructive-guard).`
    );
  }
  return undefined;
}

function toolPre(input) {
  if (input.name !== 'bash') return { kind: 'allow' };
  const args = input.arguments ?? {};
  const command = typeof args.command === 'string' ? args.command : '';
  if (command.length === 0) return { kind: 'allow' };
  for (const segment of segments(command)) {
    const bare = unquoted(segment);
    const problem =
      rmProblem(bare) ??
      gitDestructiveProblem(bare) ??
      databaseProblem(segment) ??
      clusterProblem(bare) ??
      deviceProblem(bare);
    if (problem !== undefined) return { kind: 'deny', reason: problem };
  }
  return { kind: 'allow' };
}

export function invoke(functionName, input) {
  return functionName === 'tool.pre' ? toolPre(input) : { kind: 'allow' };
}
