/**
 * `adze plugin` — local-only plugin management (M3, no registry service).
 *
 * Every function here returns an {@link ExitCode} rather than calling
 * `process.exit`, so the commands are testable in-process like the rest of
 * `packages/cli`. No function touches the network except `add` with a git URL,
 * which shells out to the user's own `git` binary after showing what it found —
 * and tests only ever use local paths.
 *
 * No guest code is executed on any of these paths. `add` and `validate` parse
 * the manifest, the markdown front matter, and the glob filters without
 * importing a hook module: showing permissions before consent is only consent
 * when the code has not run yet.
 */

import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  namespaceOf,
  type PluginManifest,
  parseManifest,
  parseSlashCommand,
  parseSubagent,
} from '@adze/plugin-sdk';
import { EXIT, type ExitCode, field, type Io, styleFor, writeJson } from '../output.js';
import {
  addInstalledEntry,
  clearDevOverride,
  readDevOverride,
  readInstalled,
  removeInstalledEntry,
  resolvePluginRoots,
  setDevOverride,
} from '../plugins/store.js';
import {
  type InstalledDeclarations,
  resolvePluginPath,
  type ValidateReport,
  validatePlugin,
} from '../plugins/validate.js';
import { CLI_VERSION } from '../version.js';

const execFileAsync = promisify(execFile);

export interface PluginListOptions {
  readonly json?: boolean;
  readonly cwd?: string;
  readonly __testHooks?: { readonly cwd?: string };
}

export interface PluginDevOptions {
  readonly json?: boolean;
  readonly clear?: boolean;
  readonly cwd?: string;
  readonly __testHooks?: { readonly cwd?: string };
}

export interface PluginAddOptions {
  readonly json?: boolean;
  /** Skip the consent prompt. Required when stdin is not a TTY. */
  readonly yes?: boolean;
  readonly cwd?: string;
  readonly __testHooks?: { readonly cwd?: string; readonly confirm?: boolean };
}

export interface PluginRemoveOptions {
  readonly json?: boolean;
  readonly cwd?: string;
  readonly __testHooks?: { readonly cwd?: string };
}

export interface PluginValidateOptions {
  readonly json?: boolean;
  readonly cwd?: string;
  readonly __testHooks?: { readonly cwd?: string };
}

function workspaceOf(options: {
  readonly cwd?: string;
  readonly __testHooks?: { readonly cwd?: string };
}): string {
  return options.__testHooks?.cwd ?? options.cwd ?? process.cwd();
}

function isGitUrl(source: string): boolean {
  const lower = source.toLowerCase();
  return (
    lower.startsWith('https://') ||
    lower.startsWith('http://') ||
    lower.startsWith('git@') ||
    lower.startsWith('ssh://') ||
    lower.startsWith('github.com/') ||
    lower.endsWith('.git')
  );
}

function safeDirName(source: string): string {
  const base = basename(source.replace(/\/$/, '').replace(/\.git$/, ''));
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'plugin';
}

async function confirmInstall(
  options: PluginAddOptions,
  io: Io,
  question: string,
): Promise<boolean> {
  if (options.yes === true) return true;
  if (options.__testHooks?.confirm !== undefined) return options.__testHooks.confirm;
  if (process.stdin.isTTY !== true) {
    io.err(
      `${question}\nRefusing without consent: re-run with --yes after reviewing the permissions above.\n`,
    );
    return false;
  }
  io.err(`${question} [y/N] `);
  const answer = await readStdinLine();
  return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
}

function readStdinLine(): Promise<string> {
  return new Promise((resolveLine) => {
    let data = '';
    const onData = (chunk: Buffer | string): void => {
      data += chunk.toString();
      if (data.includes('\n')) {
        cleanup();
        resolveLine(data);
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolveLine(data);
    };
    const cleanup = (): void => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.pause();
    };
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.resume();
  });
}

/**
 * Command/agent names for every installed plugin, parsed without executing code.
 *
 * Unreadable entries are skipped rather than fatal: a missing directory means a
 * previous `add` points somewhere that no longer exists, which `list` reports
 * and `validate` must not turn into a false collision.
 */
async function loadInstalledDeclarations(
  workspaceRoot: string,
): Promise<readonly InstalledDeclarations[]> {
  const { roots } = await resolvePluginRoots(workspaceRoot);
  const out: InstalledDeclarations[] = [];
  for (const root of roots) {
    const declarations = await declarationsForRoot(root);
    if (declarations !== undefined) out.push(declarations);
  }
  return out;
}

/** One installed plugin's command/agent names, without executing its code. */
async function declarationsForRoot(root: string): Promise<InstalledDeclarations | undefined> {
  try {
    const raw = await readFile(resolve(root, 'adze.plugin.json'), 'utf8');
    const parsed = parseManifest(raw);
    if (!parsed.ok) return undefined;
    const id = parsed.manifest.id;
    return {
      id,
      commands: await refNames(root, id, parsed.manifest.contributes?.commands ?? [], 'command'),
      agents: await refNames(root, id, parsed.manifest.contributes?.agents ?? [], 'agent'),
    };
  } catch {
    return undefined;
  }
}

async function refNames(
  root: string,
  pluginId: string,
  refs: readonly { readonly path: string }[],
  kind: 'command' | 'agent',
): Promise<{ readonly name: string }[]> {
  const names: { readonly name: string }[] = [];
  for (const reference of refs) {
    const name = await refName(root, pluginId, reference.path, kind);
    if (name !== undefined) names.push({ name });
  }
  return names;
}

async function refName(
  root: string,
  pluginId: string,
  relative: string,
  kind: 'command' | 'agent',
): Promise<string | undefined> {
  try {
    const text = await readFile(resolve(root, relative), 'utf8');
    if (kind === 'command') {
      const command = parseSlashCommand(pluginId, relative, text);
      return command.ok ? command.command.name : undefined;
    }
    const agent = parseSubagent(pluginId, relative, text);
    return agent.ok ? agent.definition.name : undefined;
  } catch {
    return undefined;
  }
}

function renderPermissions(manifest: PluginManifest, io: Io): void {
  const s = styleFor(false);
  io.out(`${s.bold(manifest.displayName)} ${s.dim(`(${manifest.id} v${manifest.version})`)}\n`);
  io.out(`${field('license', manifest.license)}\n`);
  io.out(`${field('namespace', namespaceOf(manifest.id))}\n`);
  const permissions = manifest.permissions;
  io.out(`${field('filesystem', permissions?.filesystem ?? 'none')}\n`);
  io.out(
    `${field('network', permissions?.network !== undefined && permissions.network.length > 0 ? permissions.network.join(', ') : 'none')}\n`,
  );
  io.out(
    `${field('env', permissions?.env !== undefined && permissions.env.length > 0 ? permissions.env.join(', ') : 'none')}\n`,
  );
  const contributes = manifest.contributes;
  const counts = [
    `${contributes?.tools?.length ?? 0} tools`,
    `${contributes?.contextProviders?.length ?? 0} providers`,
    `${contributes?.commands?.length ?? 0} commands`,
    `${contributes?.hooks?.length ?? 0} hooks`,
    `${contributes?.agents?.length ?? 0} agents`,
  ].join(', ');
  io.out(`${field('contributes', counts)}\n`);
}

export async function runPluginList(options: PluginListOptions, io: Io): Promise<ExitCode> {
  const workspaceRoot = workspaceOf(options);
  const json = options.json === true;
  const installed = await readInstalled(workspaceRoot);
  const dev = await readDevOverride(workspaceRoot);
  const { shadowed } = await resolvePluginRoots(workspaceRoot);

  if (json) {
    writeJson(io, {
      ok: true,
      workspaceRoot,
      installed: installed.map((entry) => ({
        id: entry.id,
        source: entry.source,
        root: entry.root,
        addedAt: entry.addedAt,
        shadowedByDev: shadowed === entry.id,
      })),
      dev: dev ?? null,
    });
    return EXIT.Ok;
  }

  const s = styleFor(false);
  io.out(`${s.bold('adze plugins')}\n`);
  io.out(`${s.dim(`state in ${workspaceRoot}/.adze/plugins/ (local-only, gitignored)`)}\n\n`);
  if (installed.length === 0) {
    io.out(
      `  ${s.dim('nothing installed. `adze plugin add <local-path|git-url>` installs one.')}\n`,
    );
  }
  for (const entry of installed) {
    const marker = shadowed === entry.id ? ` ${s.warn('(shadowed by dev)')}` : '';
    io.out(`  ${s.good('installed')} ${entry.id}${marker}\n`);
    io.out(`             ${s.dim(`${entry.source} -> ${entry.root}`)}\n`);
  }
  if (dev !== undefined) {
    io.out(`\n  ${s.warn('dev override')} ${dev.id} from ${dev.root}\n`);
    io.out(
      `               ${s.dim('live reload: every load reads this directory. Shadows the installed same id.')}\n`,
    );
  }
  io.out('\n');
  return EXIT.Ok;
}

export async function runPluginDev(
  path: string | undefined,
  options: PluginDevOptions,
  io: Io,
): Promise<ExitCode> {
  const workspaceRoot = workspaceOf(options);
  const json = options.json === true;

  if (options.clear === true) {
    const had = await clearDevOverride(workspaceRoot);
    if (json) {
      writeJson(io, { ok: true, cleared: had });
      return EXIT.Ok;
    }
    const s = styleFor(false);
    io.out(
      had ? `${s.good('cleared')} dev override\n` : `${s.dim('no dev override was active')}\n`,
    );
    return EXIT.Ok;
  }

  if (path === undefined || path.trim().length === 0) {
    const message = 'needs a plugin directory: adze plugin dev <path> (or --clear)';
    if (json) writeJson(io, { ok: false, error: 'usage', message });
    else io.err(`adze plugin dev: ${message}\n`);
    return EXIT.Usage;
  }

  const { root, manifestPath } = resolvePluginPath(path, workspaceRoot);
  const candidate = await readDevCandidate(manifestPath, json, io);
  if (candidate === undefined) return EXIT.Failure;

  const absolute = isAbsolute(root) ? root : resolve(workspaceRoot, root);
  const override = await setDevOverride(workspaceRoot, absolute, candidate.id);
  if (json) {
    writeJson(io, { ok: true, dev: override, shadowed: candidate.id });
    return EXIT.Ok;
  }
  const s = styleFor(false);
  io.out(`${s.good('dev override')} ${candidate.id} from ${override.root}\n`);
  io.out(
    `${s.warn('live reload')} — every load reads this directory, shadowing the installed '${candidate.id}'. Shown in \`adze doctor\` and run trajectories.\n`,
  );
  return EXIT.Ok;
}

/** Read and parse the dev directory's manifest, reporting failures. */
async function readDevCandidate(
  manifestPath: string,
  json: boolean,
  io: Io,
): Promise<{ readonly id: string } | undefined> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (error) {
    const message = `could not read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`;
    if (json) writeJson(io, { ok: false, error: 'unreadable', message });
    else io.err(`adze plugin dev: ${message}\n`);
    return undefined;
  }
  const parsed = parseManifest(raw, manifestPath);
  if (!parsed.ok) {
    if (json) {
      writeJson(io, { ok: false, error: 'invalid-manifest', diagnostics: parsed.diagnostics });
    } else {
      const s = styleFor(false);
      io.err(`${s.bad('refused')} ${manifestPath}\n`);
      for (const diagnostic of parsed.diagnostics)
        io.err(`  [${diagnostic.code}] ${diagnostic.message}\n`);
    }
    return undefined;
  }
  return { id: parsed.manifest.id };
}

export async function runPluginAdd(
  source: string | undefined,
  options: PluginAddOptions,
  io: Io,
): Promise<ExitCode> {
  const workspaceRoot = workspaceOf(options);
  const json = options.json === true;

  if (source === undefined || source.trim().length === 0) {
    const message = 'needs a source: adze plugin add <local-path|git-url> [--yes]';
    if (json) writeJson(io, { ok: false, error: 'usage', message });
    else io.err(`adze plugin add: ${message}\n`);
    return EXIT.Usage;
  }

  const resolved = await resolveAddRoot(source, workspaceRoot, json, io);
  if (resolved === undefined) return EXIT.Failure;
  const { root, cloned } = resolved;

  const installed = await loadInstalledDeclarations(workspaceRoot);
  const report = await validatePlugin(root, {
    engineVersion: CLI_VERSION,
    cwd: workspaceRoot,
    installed,
  });

  if (!report.ok) {
    reportInvalidPlugin(report, root, json, io);
    return EXIT.Failure;
  }

  const id = report.id;
  if (id === undefined) {
    if (json) writeJson(io, { ok: false, error: 'invalid-plugin', message: 'no plugin id' });
    else io.err('adze plugin add: manifest has no id\n');
    return EXIT.Failure;
  }

  const manifest = await readDisplayManifest(report.manifestPath, json, io);
  if (manifest === undefined) return EXIT.Failure;

  if (!json) renderPermissions(manifest, io);

  return await confirmAndRecord(
    workspaceRoot,
    source,
    root,
    cloned,
    id,
    manifest,
    options,
    json,
    io,
  );
}

/**
 * Consent, then record. Split from `runPluginAdd` so the consent ordering —
 * display first, execute nothing before it — reads in one place.
 */
async function confirmAndRecord(
  workspaceRoot: string,
  source: string,
  root: string,
  cloned: boolean,
  id: string,
  manifest: PluginManifest,
  options: PluginAddOptions,
  json: boolean,
  io: Io,
): Promise<ExitCode> {
  const consent = await confirmInstall(
    options,
    io,
    `Install '${id}' v${manifest.version} (${manifest.license}, namespace '${namespaceOf(id)}')?`,
  );
  if (!consent) {
    if (cloned) {
      await rm(root, { recursive: true, force: true });
    }
    if (json) writeJson(io, { ok: false, error: 'declined', id });
    else io.err(`adze plugin add: declined. Nothing installed. Re-run with --yes after review.\n`);
    return EXIT.Failure;
  }

  const added = await addInstalledEntry(workspaceRoot, { id, source, root });
  if (!added.ok) {
    if (json) writeJson(io, { ok: false, error: 'duplicate', message: added.message });
    else io.err(`adze plugin add: ${added.message}\n`);
    return EXIT.Failure;
  }

  if (json) {
    writeJson(io, { ok: true, installed: added.entry });
    return EXIT.Ok;
  }
  const s = styleFor(false);
  io.out(`${s.good('installed')} ${id} from ${source}\n`);
  io.out(`${s.dim(`state in ${workspaceRoot}/.adze/plugins/ (local-only, gitignored)`)}\n`);
  return EXIT.Ok;
}

/** A local directory, or a fresh `git clone` for a URL. Reports clone failures. */
async function resolveAddRoot(
  source: string,
  workspaceRoot: string,
  json: boolean,
  io: Io,
): Promise<{ readonly root: string; readonly cloned: boolean } | undefined> {
  if (!isGitUrl(source)) {
    return { root: isAbsolute(source) ? source : resolve(workspaceRoot, source), cloned: false };
  }
  const dest = resolve(workspaceRoot, '.adze', 'plugins', safeDirName(source));
  try {
    await execFileAsync('git', ['clone', '--depth', '1', source, dest]);
    return { root: dest, cloned: true };
  } catch (error) {
    const message = `could not clone ${source}: ${error instanceof Error ? error.message : String(error)}`;
    if (json) writeJson(io, { ok: false, error: 'clone-failed', message });
    else io.err(`adze plugin add: ${message}\n`);
    return undefined;
  }
}

function reportInvalidPlugin(
  report: Pick<ValidateReport, 'gates' | 'diagnostics'>,
  root: string,
  json: boolean,
  io: Io,
): void {
  if (json) {
    writeJson(io, {
      ok: false,
      error: 'invalid-plugin',
      gates: report.gates,
      diagnostics: report.diagnostics,
    });
    return;
  }
  const s = styleFor(false);
  io.err(`${s.bad('refused')} ${root}\n`);
  for (const gate of report.gates.filter((gate) => !gate.ok)) {
    io.err(`  ${s.bad(gate.name)} ${gate.message}\n`);
  }
}

/** Re-read the validated manifest for the consent display. */
async function readDisplayManifest(
  manifestPath: string,
  json: boolean,
  io: Io,
): Promise<PluginManifest | undefined> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    if (json) writeJson(io, { ok: false, error: 'unreadable', message: manifestPath });
    else io.err(`adze plugin add: could not re-read ${manifestPath}\n`);
    return undefined;
  }
  const parsed = parseManifest(raw, manifestPath);
  if (!parsed.ok) {
    if (json)
      writeJson(io, { ok: false, error: 'invalid-manifest', diagnostics: parsed.diagnostics });
    else io.err('adze plugin add: manifest no longer parses\n');
    return undefined;
  }
  return parsed.manifest;
}

export async function runPluginRemove(
  id: string | undefined,
  options: PluginRemoveOptions,
  io: Io,
): Promise<ExitCode> {
  const workspaceRoot = workspaceOf(options);
  const json = options.json === true;

  if (id === undefined || id.trim().length === 0) {
    const message = 'needs a plugin id: adze plugin remove <id>';
    if (json) writeJson(io, { ok: false, error: 'usage', message });
    else io.err(`adze plugin remove: ${message}\n`);
    return EXIT.Usage;
  }

  const outcome = await removeInstalledEntry(workspaceRoot, id);
  if (!outcome.ok) {
    if (json) writeJson(io, { ok: false, error: 'not-installed', message: outcome.message });
    else io.err(`adze plugin remove: ${outcome.message}\n`);
    return EXIT.Failure;
  }

  if (json) {
    writeJson(io, { ok: true, removed: outcome.removed, clearedDev: outcome.clearedDev });
    return EXIT.Ok;
  }
  const s = styleFor(false);
  io.out(`${s.good('removed')} ${outcome.removed.id}\n`);
  if (outcome.clearedDev) {
    io.out(`${s.warn('cleared')} dev override shadowing '${outcome.removed.id}'\n`);
  }
  return EXIT.Ok;
}

export async function runPluginValidate(
  path: string | undefined,
  options: PluginValidateOptions,
  io: Io,
): Promise<ExitCode> {
  const workspaceRoot = workspaceOf(options);
  const json = options.json === true;

  if (path === undefined || path.trim().length === 0) {
    const message = 'needs a plugin path: adze plugin validate <path>';
    if (json) writeJson(io, { ok: false, error: 'usage', message });
    else io.err(`adze plugin validate: ${message}\n`);
    return EXIT.Usage;
  }

  const installed = await loadInstalledDeclarations(workspaceRoot);
  const report = await validatePlugin(path, {
    engineVersion: CLI_VERSION,
    cwd: workspaceRoot,
    installed,
  });

  if (json) {
    writeJson(io, {
      ok: report.ok,
      id: report.id ?? null,
      root: report.root,
      manifest: report.manifestPath,
      gates: report.gates,
      diagnostics: report.diagnostics,
      commands: report.commands,
      agents: report.agents,
    });
    return report.ok ? EXIT.Ok : EXIT.Failure;
  }

  const s = styleFor(false);
  if (report.ok) {
    io.out(`${s.good('valid')} ${report.id} (${report.root})\n`);
    for (const gate of report.gates) io.out(`  ${s.good(gate.name)} ${gate.message}\n`);
    return EXIT.Ok;
  }
  io.err(`${s.bad('invalid')} ${report.id ?? path}\n`);
  for (const gate of report.gates) {
    if (gate.ok) io.err(`  ${s.good(gate.name)} ${gate.message}\n`);
    else io.err(`  ${s.bad(gate.name)} ${gate.message}\n`);
  }
  return EXIT.Failure;
}
