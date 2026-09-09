/**
 * Local plugin state in `.adze/plugins/`.
 *
 * Local-only by design (ADR-0008: no registry service in v1). The directory
 * holds two JSON documents and nothing else, so it is safe to gitignore in its
 * entirety — `.gitignore` already ignores `.adze/` except the config example.
 * Nothing here touches the network; a `git-url` source is recorded and cloned
 * with the user's explicit consent via the `git` binary, never fetched silently.
 *
 * - `installed.json` — every `adze plugin add` entry: the plugin id, the source
 *   the user named, and the absolute directory it resolves to.
 * - `dev.json` — the `adze plugin dev` override, when one is active. A single
 *   live directory that shadows the installed entry with the same id.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export interface InstalledPluginEntry {
  readonly id: string;
  /** Exactly what the user passed to `add`: a local path or a git URL. */
  readonly source: string;
  /** Absolute directory the plugin loads from. */
  readonly root: string;
  readonly addedAt: string;
}

interface InstalledFile {
  readonly version: 1;
  readonly plugins: readonly InstalledPluginEntry[];
}

export interface DevOverride {
  readonly root: string;
  readonly id: string;
  readonly startedAt: string;
}

export function pluginsDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.adze', 'plugins');
}

function installedPath(workspaceRoot: string): string {
  return join(pluginsDir(workspaceRoot), 'installed.json');
}

function devPath(workspaceRoot: string): string {
  return join(pluginsDir(workspaceRoot), 'dev.json');
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function isInstalledFile(value: unknown): value is InstalledFile {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { version?: unknown; plugins?: unknown };
  if (record.version !== 1) return false;
  if (!Array.isArray(record.plugins)) return false;
  return record.plugins.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { id?: unknown }).id === 'string' &&
      typeof (entry as { source?: unknown }).source === 'string' &&
      typeof (entry as { root?: unknown }).root === 'string',
  );
}

/** Every installed plugin, in the order added. Missing file means none. */
export async function readInstalled(
  workspaceRoot: string,
): Promise<readonly InstalledPluginEntry[]> {
  const raw = await readJsonFile(installedPath(workspaceRoot));
  if (raw === undefined) return [];
  if (!isInstalledFile(raw)) return [];
  return raw.plugins;
}

async function writeInstalled(
  workspaceRoot: string,
  plugins: readonly InstalledPluginEntry[],
): Promise<void> {
  await mkdir(pluginsDir(workspaceRoot), { recursive: true });
  const payload: InstalledFile = { version: 1, plugins: [...plugins] };
  await writeFile(installedPath(workspaceRoot), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/** The active dev override, if any. A corrupt file reads as none. */
export async function readDevOverride(workspaceRoot: string): Promise<DevOverride | undefined> {
  const raw = await readJsonFile(devPath(workspaceRoot));
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as { root?: unknown; id?: unknown; startedAt?: unknown };
  if (typeof record.root !== 'string' || typeof record.id !== 'string') return undefined;
  if (!isAbsolute(record.root)) return undefined;
  return {
    root: record.root,
    id: record.id,
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
  };
}

async function writeDevOverride(
  workspaceRoot: string,
  override: DevOverride | undefined,
): Promise<void> {
  await mkdir(pluginsDir(workspaceRoot), { recursive: true });
  if (override === undefined) {
    await rm(devPath(workspaceRoot), { force: true });
    return;
  }
  await writeFile(devPath(workspaceRoot), `${JSON.stringify(override, null, 2)}\n`, 'utf8');
}

export type AddEntryOutcome =
  | { readonly ok: true; readonly entry: InstalledPluginEntry }
  | { readonly ok: false; readonly message: string };

/**
 * Record a validated plugin id as installed.
 *
 * The caller validates the directory first (manifest parses, id extracted);
 * this function only enforces uniqueness of the id across the installed set.
 */
export async function addInstalledEntry(
  workspaceRoot: string,
  entry: Omit<InstalledPluginEntry, 'addedAt'> & { readonly addedAt?: string },
): Promise<AddEntryOutcome> {
  const installed = await readInstalled(workspaceRoot);
  if (installed.some((existing) => existing.id === entry.id)) {
    return {
      ok: false,
      message: `plugin '${entry.id}' is already installed. Remove it first to reinstall.`,
    };
  }
  const full: InstalledPluginEntry = {
    ...entry,
    addedAt: entry.addedAt ?? new Date().toISOString(),
  };
  await writeInstalled(workspaceRoot, [...installed, full]);
  return { ok: true, entry: full };
}

export type RemoveOutcome =
  | { readonly ok: true; readonly removed: InstalledPluginEntry; readonly clearedDev: boolean }
  | { readonly ok: false; readonly message: string };

/** Remove an installed id. Also clears a dev override shadowing that id. */
export async function removeInstalledEntry(
  workspaceRoot: string,
  id: string,
): Promise<RemoveOutcome> {
  const installed = await readInstalled(workspaceRoot);
  const removed = installed.find((entry) => entry.id === id);
  if (removed === undefined) {
    const known = installed.map((entry) => entry.id);
    return {
      ok: false,
      message:
        known.length === 0
          ? `plugin '${id}' is not installed: nothing is installed in this workspace.`
          : `plugin '${id}' is not installed. Installed: ${known.join(', ')}.`,
    };
  }
  await writeInstalled(
    workspaceRoot,
    installed.filter((entry) => entry.id !== id),
  );
  const dev = await readDevOverride(workspaceRoot);
  if (dev !== undefined && dev.id === id) {
    await writeDevOverride(workspaceRoot, undefined);
    return { ok: true, removed, clearedDev: true };
  }
  return { ok: true, removed, clearedDev: false };
}

/** Point the dev override at a live directory. Shadows the installed same id. */
export async function setDevOverride(
  workspaceRoot: string,
  root: string,
  id: string,
): Promise<DevOverride> {
  const absolute = isAbsolute(root) ? root : resolve(workspaceRoot, root);
  const override: DevOverride = { root: absolute, id, startedAt: new Date().toISOString() };
  await writeDevOverride(workspaceRoot, override);
  return override;
}

/** Clear the dev override. Succeeds when none was active. */
export async function clearDevOverride(workspaceRoot: string): Promise<boolean> {
  const existing = await readDevOverride(workspaceRoot);
  await writeDevOverride(workspaceRoot, undefined);
  return existing !== undefined;
}

/**
 * Plugin roots in load order, with the dev override applied.
 *
 * When the dev directory's id matches an installed entry, the installed entry is
 * replaced in place rather than appended: the override shadows the published id,
 * and every surface sees one entry for that id — the live one.
 */
export async function resolvePluginRoots(workspaceRoot: string): Promise<{
  readonly roots: readonly string[];
  readonly dev: DevOverride | undefined;
  readonly shadowed: string | undefined;
}> {
  const installed = await readInstalled(workspaceRoot);
  const dev = await readDevOverride(workspaceRoot);
  if (dev === undefined) {
    return { roots: installed.map((entry) => entry.root), dev, shadowed: undefined };
  }
  const shadowed = installed.find((entry) => entry.id === dev.id);
  if (shadowed === undefined) {
    return {
      roots: [...installed.map((entry) => entry.root), dev.root],
      dev,
      shadowed: undefined,
    };
  }
  return {
    roots: installed.map((entry) => (entry.id === dev.id ? dev.root : entry.root)),
    dev,
    shadowed: dev.id,
  };
}
