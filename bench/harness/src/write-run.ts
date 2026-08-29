/**
 * Writing a run to disk.
 *
 * The layout is the one `docs/benchmarks/strategy.md` specifies:
 *
 *   report.md       human-readable, limitations first
 *   result.json     machine-readable, schema in src/report-schema.ts
 *   config.json     harness version, invocation, environment
 *   trajectories/   every trial, pass and fail
 *
 * The default destination is `bench/.runs/`, which `.gitignore` excludes: a run on
 * every pull request is an artifact, not a commit. A report that is meant to be
 * published goes to `bench/reports/<date>-<suite>/` with `--out`, where it is
 * committed and reviewable.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderReportMarkdown } from './report.js';
import type { RunOutcome } from './runner.js';

/** `2026-08-29T02-31-07` — sorts correctly and is a legal filename on Windows. */
export function runStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/\..+$/, '').replaceAll(':', '-');
}

/** Filesystem-safe form of a case id, so a trajectory filename is predictable. */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

export interface WrittenRun {
  readonly dir: string;
  readonly reportPath: string;
  readonly resultPath: string;
  readonly trajectoryCount: number;
}

export async function writeRun(outcome: RunOutcome, dir: string): Promise<WrittenRun> {
  const trajectoriesDir = join(dir, 'trajectories');
  await mkdir(trajectoriesDir, { recursive: true });

  const reportPath = join(dir, 'report.md');
  const resultPath = join(dir, 'result.json');

  await writeFile(reportPath, renderReportMarkdown(outcome.report), 'utf8');
  await writeFile(resultPath, `${JSON.stringify(outcome.report, null, 2)}\n`, 'utf8');

  await writeFile(
    join(dir, 'config.json'),
    `${JSON.stringify(
      {
        suite: outcome.report.suite,
        harnessVersion: outcome.report.harnessVersion,
        reportSchemaVersion: outcome.report.schemaVersion,
        invocation: outcome.report.invocation,
        environment: outcome.report.environment,
        inputSource: outcome.report.inputSource,
        models: outcome.report.models,
        attempts: outcome.report.attempts,
        deterministic: outcome.report.deterministic,
        // Stated rather than omitted. A reader comparing this to a Tier-2 report
        // needs to know these were not pinned, not to guess that they were.
        containerDigest: null,
        resourceBand: null,
        seeds: null,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  for (const t of outcome.trajectories) {
    await writeFile(
      join(trajectoriesDir, `${safeId(t.result.id)}.json`),
      `${JSON.stringify(
        {
          id: t.case.id,
          description: t.case.description,
          sourceFile: t.case.file,
          ...(t.case.source === undefined ? {} : { origin: t.case.source }),
          path: t.case.path,
          input: {
            original: t.case.original,
            edits: t.case.edits,
            ...(t.case.replacement === undefined ? {} : { replacement: t.case.replacement }),
            ...(t.case.options === undefined ? {} : { options: t.case.options }),
          },
          expected: t.case.expect,
          result: t.result,
          ...(t.output === undefined ? {} : { output: t.output }),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  return {
    dir,
    reportPath,
    resultPath,
    trajectoryCount: outcome.trajectories.length,
  };
}
