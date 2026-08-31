/**
 * Leakage assertions: the checks ADR-0011 requires to be build failures.
 *
 * > Enforced by assertion tests in CI: test-patch absence, gold-patch-field absence,
 * > future-history absence, and network isolation are build failures, not warnings.
 *
 * These are Tier-1 work by that ADR's own table — deterministic, free, no model call,
 * no network, no container — which is why they can run on every pull request inside a
 * ten-minute budget.
 *
 * ## What this file is not
 *
 * It is not a harness, and it does not prepare anything. ADR-0011 rejects building a
 * harness outright: Harbor owns the containers, and a private harness is
 * indistinguishable from a tuned one. So the two-container design stays Harbor's
 * structural guarantee, and what lives here are the *assertions* over the artifacts our
 * adapter is responsible for — the payload we hand an agent, and the repository state we
 * claim to have handed it.
 *
 * Consequently two of the four assertions in that quote are **not** in this file.
 * Network egress blocking and diff-only grading in a fresh verifier are properties of a
 * container, not of a value we can inspect, and writing a function that returns `ok`
 * without having tested a container would be the appearance of enforcement rather than
 * enforcement. They are named in `docs/benchmarks/strategy.md` as unimplemented.
 *
 * ## Nothing calls these yet, and what each one is waiting for
 *
 * `runner.ts` does not import this file. That is a decision, not an oversight at the
 * wiring seam, and it is recorded here because a reader auditing whether the leakage
 * policy is enforced will arrive at this file first.
 *
 * Both functions assert over inputs the only committed suite does not have.
 * `checkPromptLeakage` needs a dataset record and the payload assembled from it;
 * `checkHistoryIsolation` needs a prepared repository and the base commit it is supposed
 * to sit at. `apply-bench` has none of the four: hand-written edits applied to strings in
 * memory, with no task record, no prompt and no checkout.
 *
 * Calling them anyway would evaluate absent data. An empty payload trips no field guard,
 * and a record with no `patch` field leaks no patch lines, so the result would be `ok` on
 * every run — the appearance of enforcement without the substance. That is the mistake
 * this package has already had to correct twice: once for source comments citing callers
 * that were never written, and once in `report-policy.ts`, which declines to call
 * `compareToBaseline` on absent data and says so at the same length.
 *
 * So these are asserted rather than invoked. `test/leakage.test.ts` exercises both
 * against fixtures — a SWE-bench-shaped record, and real git repositories built per case,
 * both leaking and correctly prepared — and a regression fails the build. What that buys
 * is confidence that the assertions work on the day an adapter first has data for them.
 * It buys no claim at all about a run, and no report may state otherwise; each generated
 * `audit.md` records the same thing per run, so the gap is visible in the artifact rather
 * than only in a document.
 *
 * The wiring belongs in the first adapter that prepares a task from a dataset, at the
 * moment the payload is built and before it is handed over — not in `runSuite`, which
 * will never be the code that assembles a prompt. See M5 in `docs/roadmap.md`.
 *
 * ## Why the field guard is an allowlist
 *
 * The obvious construction is a denylist: refuse `patch`, refuse `test_patch`, refuse
 * `FAIL_TO_PASS`. That fails the moment a dataset adds a field. SWE-bench-style records
 * are upstream data we do not control, and a new hint-bearing column would flow to the
 * agent silently while the denylist kept reporting clean.
 *
 * So the field guard is **default-deny**, the same construction `checkCitation` uses for
 * citation hosts and for the same reason: the failure it blocks involves names we cannot
 * enumerate in advance. Only an explicitly allowed field may reach an agent, and an
 * unrecognised field is a violation rather than a pass.
 *
 * ## Why there is also a content check, and what it is worth
 *
 * The allowlist permits `problem_statement`, and a problem statement can quote the fix —
 * this is the pre-solved-localization vector ADR-0011 prices at 10 to 20 points. So the
 * content check looks for verbatim lines of the gold or test patch inside the text the
 * model actually sees.
 *
 * Read the two checks differently. The field guard is structural and has no false
 * positives. The content check is a **detector**: it names fields it knows to carry
 * solutions, so it inherits the denylist weakness the field guard was built to avoid,
 * and it can only find verbatim overlap. A leak paraphrased by hand would pass it. It is
 * worth having because the vector it catches is the expensive one, and it is documented
 * this way so that a clean result is not read as proof of no leakage.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * One record from a benchmark dataset, as loaded.
 *
 * Deliberately opaque. We do not own this schema — the dataset does — and declaring an
 * interface for it here would invite the guard to be written against our idea of the
 * columns rather than against whatever is actually present.
 */
export type TaskRecord = Readonly<Record<string, unknown>>;

/**
 * The only fields that may reach an agent.
 *
 * Minimal on purpose: which repository, which commit, and what the problem is. Anything
 * an agent does not need in order to start work is a field that can only help it guess
 * the answer. Notably absent is `hints_text`, which in SWE-bench-style data carries
 * maintainer discussion that frequently describes the fix.
 */
export const PROMPT_ALLOWED_FIELDS: readonly string[] = [
  'instance_id',
  'repo',
  'base_commit',
  'problem_statement',
];

/**
 * Fields known to carry a solution, for the content detector.
 *
 * A denylist, with that weakness accepted: it exists only to supply the text the content
 * check searches for. The allowlist above is what actually keeps these out of a prompt.
 */
export const SOLUTION_BEARING_FIELDS: readonly string[] = ['patch', 'test_patch', 'hints_text'];

/**
 * Shortest patch line worth treating as evidence of a leak.
 *
 * A diff contains lines like `}` and `import os` that appear in any repository, and
 * flagging those would make the check fire on every task and be switched off within a
 * week. Twenty-four characters is long enough that a verbatim match is a quotation rather
 * than a coincidence.
 */
export const MIN_LEAKED_LINE_LENGTH = 24;

export type LeakageViolationCode =
  /** A field outside the allowlist reached the agent payload. */
  | 'undeclared-field-in-prompt'
  /** Verbatim gold-patch lines appear in the text the model sees. */
  | 'gold-patch-content-in-prompt'
  /** Verbatim test-patch lines appear in the text the model sees. */
  | 'test-patch-content-in-prompt'
  /** A commit outside the base commit's history is reachable in the agent repository. */
  | 'future-history-reachable'
  /** The agent repository is not checked out at the base commit. */
  | 'head-not-at-base-commit'
  /** The base commit is not present in the repository at all. */
  | 'base-commit-missing';

export interface LeakageViolation {
  readonly code: LeakageViolationCode;
  readonly message: string;
}

export type LeakageCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly LeakageViolation[] };

/** A check could not be performed. Never reported as a pass. */
export class LeakageError extends Error {}

/** What we intend to hand an agent for one task. */
export interface AgentPrompt {
  /** Structured fields, e.g. serialized into a task file inside the container. */
  readonly fields: TaskRecord;
  /** The assembled text the model actually reads. */
  readonly text: string;
}

function stringField(record: TaskRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The allowlisted subset of a record.
 *
 * Provided so that building a compliant payload is easier than building a leaking one.
 * A caller that starts from this cannot trip the field guard.
 */
export function redactTaskRecord(record: TaskRecord): TaskRecord {
  const redacted: Record<string, unknown> = {};
  for (const key of PROMPT_ALLOWED_FIELDS) {
    if (Object.hasOwn(record, key)) redacted[key] = record[key];
  }
  return redacted;
}

/**
 * Content lines of a unified diff, long enough to be distinctive.
 *
 * File headers are dropped: `+++ b/src/thing.py` names a path that legitimately appears
 * in a problem statement, and treating a filename as leaked solution content would flag
 * every well-written bug report.
 */
function significantPatchLines(patch: string): readonly string[] {
  const lines: string[] = [];
  for (const raw of patch.split(/\r?\n/)) {
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (!raw.startsWith('+') && !raw.startsWith('-')) continue;
    const content = raw.slice(1).trim();
    if (content.length >= MIN_LEAKED_LINE_LENGTH) lines.push(content);
  }
  return lines;
}

function describeLeakedLines(leaked: readonly string[]): string {
  const shown = leaked.slice(0, 3).map((line) => `"${line.slice(0, 60)}"`);
  const rest = leaked.length > shown.length ? `, and ${leaked.length - shown.length} more` : '';
  return `${shown.join(', ')}${rest}`;
}

/**
 * Whether a payload may be handed to an agent.
 *
 * Runs the structural field guard and the content detector, and collects everything
 * rather than returning at the first problem, because a caller fixing a payload should
 * see the whole list in one pass.
 */
export function checkPromptLeakage(record: TaskRecord, prompt: AgentPrompt): LeakageCheck {
  const violations: LeakageViolation[] = [];

  const allowed = new Set(PROMPT_ALLOWED_FIELDS);
  const undeclared = Object.keys(prompt.fields).filter((key) => !allowed.has(key));
  if (undeclared.length > 0) {
    violations.push({
      code: 'undeclared-field-in-prompt',
      message:
        `the agent payload carries ${undeclared.map((k) => `'${k}'`).join(', ')}, which is not ` +
        `on the allowlist (${PROMPT_ALLOWED_FIELDS.join(', ')}). This guard is default-deny: a ` +
        'field is refused until somebody establishes that an agent needs it to start work, ' +
        'because a dataset can add a solution-bearing column at any time.',
    });
  }

  const goldLeaks = leakedLinesFrom(record, 'patch', prompt.text);
  if (goldLeaks.length > 0) {
    violations.push({
      code: 'gold-patch-content-in-prompt',
      message:
        `${goldLeaks.length} line(s) of the gold patch appear verbatim in the prompt text: ` +
        `${describeLeakedLines(goldLeaks)}. Pre-solved localization is worth 10 to 20 points, ` +
        'so a task in this state measures nothing.',
    });
  }

  const testLeaks = leakedLinesFrom(record, 'test_patch', prompt.text);
  if (testLeaks.length > 0) {
    violations.push({
      code: 'test-patch-content-in-prompt',
      message:
        `${testLeaks.length} line(s) of the test patch appear verbatim in the prompt text: ` +
        `${describeLeakedLines(testLeaks)}. An agent that can read the tests it must pass is ` +
        'being graded on transcription.',
    });
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

function leakedLinesFrom(record: TaskRecord, key: string, text: string): readonly string[] {
  const patch = stringField(record, key);
  if (patch === undefined) return [];
  return significantPatchLines(patch).filter((line) => text.includes(line));
}

/** Where the agent's repository is, and the commit it is supposed to start from. */
export interface RepositoryState {
  readonly repoDir: string;
  /** Full or abbreviated commit id. */
  readonly baseCommit: string;
}

async function git(repoDir: string, args: readonly string[]): Promise<string> {
  try {
    // argv array, never a shell string: a commit id is untrusted input and this file
    // runs in CI.
    const { stdout } = await run('git', ['-C', repoDir, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (cause) {
    throw new LeakageError(
      `git ${args.join(' ')} failed in ${repoDir}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * Whether an agent repository leaks the future.
 *
 * Two assertions. `HEAD` is at the base commit, and **nothing reachable from any ref
 * lies outside the base commit's history** — which is `git rev-list --all ^base` being
 * empty. Stating it as reachability rather than as "later commits" is deliberate: a
 * sibling branch or a tag carrying the upstream fix is exactly as much of a leak as a
 * descendant, and a check written against commit dates would miss both.
 *
 * ## What a pass proves, and what it does not
 *
 * It proves no commit containing the fix can be found by walking refs, which is the
 * documented `git log` vector. It does **not** prove the object database is free of
 * unreachable future objects: a dangling commit left by a careless preparation step is
 * still retrievable by hash, and detecting that reliably means `git fsck` on every task,
 * which does not fit a Tier-1 budget. The distinction is recorded because a leakage check
 * that overstates its own coverage is worse than one that does not run.
 *
 * Throws rather than returning `ok` when git cannot answer. A leakage assertion that
 * reports clean because it failed to execute is the worst available outcome.
 */
export async function checkHistoryIsolation(state: RepositoryState): Promise<LeakageCheck> {
  const violations: LeakageViolation[] = [];

  // Established before anything else, so that "not a git repository" cannot be reported
  // as the narrower and much more reassuring "that one commit is missing".
  await git(state.repoDir, ['rev-parse', '--git-dir']);

  let resolvedBase: string;
  try {
    resolvedBase = await git(state.repoDir, [
      'rev-parse',
      '--verify',
      `${state.baseCommit}^{commit}`,
    ]);
  } catch {
    return {
      ok: false,
      violations: [
        {
          code: 'base-commit-missing',
          message:
            `commit '${state.baseCommit}' is not present in ${state.repoDir}, so the agent is ` +
            'not starting where the task says it starts and no isolation claim can be made ' +
            'about this repository.',
        },
      ],
    };
  }

  const head = await git(state.repoDir, ['rev-parse', 'HEAD']);
  if (head !== resolvedBase) {
    violations.push({
      code: 'head-not-at-base-commit',
      message:
        `HEAD is ${head.slice(0, 12)} but the task's base commit is ${resolvedBase.slice(0, 12)}. ` +
        'The agent would begin from a tree the task did not specify.',
    });
  }

  // Reachable from any ref, excluded from the base commit's history. Anything here is a
  // commit the agent could reach that the task never intended it to see.
  const outside = await git(state.repoDir, ['rev-list', '--all', `^${resolvedBase}`]);
  if (outside.length > 0) {
    const commits = outside.split('\n').filter((line) => line.length > 0);
    violations.push({
      code: 'future-history-reachable',
      message:
        `${commits.length} commit(s) outside the base commit's history are reachable from a ref ` +
        `in ${state.repoDir}, beginning with ${commits
          .slice(0, 3)
          .map((c) => c.slice(0, 12))
          .join(', ')}. ` +
        'An agent can walk to the upstream fix with git log, which is a documented way these ' +
        'benchmarks get gamed by accident.',
    });
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
