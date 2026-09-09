/**
 * Static validation for `adze plugin validate`.
 *
 * Runs every gate that can be checked without executing plugin code. No guest
 * module is imported here: `add` shows permissions before consent, and
 * `validate` must be safe to run on an untrusted directory. Loading hooks would
 * execute their modules, which is exactly what consent gates.
 *
 * Gates, in order:
 *
 * 1. Manifest parses (unicode scan + schema, via `parseManifest`).
 * 2. License is allowlisted for an Apache-2.0 product.
 * 3. `engines.adze` satisfies the running engine.
 * 4. Every environment variable a tool reads is declared in `permissions.env`.
 * 5. Hook `tools`/`paths` filters and provider patterns compile as globs.
 * 6. Referenced files exist and carry no hidden characters; commands and agents
 *    parse.
 * 7. Command/agent names do not collide with the installed set.
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  checkEngineCompatibility,
  compileGlobSet,
  errorDiagnostic,
  type PluginDiagnostic,
  type PluginManifest,
  parseManifest,
  parseSlashCommand,
  parseSubagent,
  scanForHiddenCharacters,
} from '@adze/plugin-sdk';

const ALLOWED_LICENSES = new Set([
  'APACHE-2.0',
  'MIT',
  'MIT-0',
  'BSD-2-CLAUSE',
  'BSD-3-CLAUSE',
  'ISC',
  'UNLICENSE',
  'CC0-1.0',
  'BLUEOAK-1.0.0',
  'PYTHON-2.0',
  '0BSD',
]);

const DENIED_SUBSTRINGS = [
  'AGPL',
  'LGPL',
  'GPL',
  'EPL',
  'MPL-1',
  'SSPL',
  'BUSL',
  'FSL',
  'COMMONS CLAUSE',
  'COMMONS-CLAUSE',
  'ELASTIC-2',
  'UNLICENSED',
];

export interface ValidateGate {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
}

export interface ValidateReport {
  readonly ok: boolean;
  readonly id: string | undefined;
  readonly root: string;
  readonly manifestPath: string;
  readonly gates: readonly ValidateGate[];
  readonly diagnostics: readonly PluginDiagnostic[];
  readonly commands: readonly string[];
  readonly agents: readonly string[];
}

export interface ValidateDeps {
  readonly engineVersion: string;
  readonly readFile?: (path: string) => Promise<string>;
  readonly exists?: (path: string) => Promise<boolean>;
}

/** Minimal installed declarations for collision checks (no code executed). */
export interface InstalledDeclarations {
  readonly id: string;
  readonly commands: readonly { readonly name: string }[];
  readonly agents: readonly { readonly name: string }[];
}

const ENV_REFERENCE = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

function licenseGate(license: string): { ok: boolean; message: string } {
  const text = license.trim().replace(/^\(|\)$/g, '');
  const orLeaves =
    /\s+OR\s+/i.test(text) && !/^\S+$/.test(text)
      ? text.split(/\s+OR\s+/i).map((leaf) => leaf.trim().replace(/^\(|\)$/g, ''))
      : [text];
  // An OR is satisfied by one acceptable operand (dual licence); an AND needs all.
  const isOr = orLeaves.length > 1 || /\s+OR\s+/i.test(text);
  const leaves = isOr
    ? orLeaves
    : /\s+AND\s+/i.test(text)
      ? text.split(/\s+AND\s+/i).map((leaf) => leaf.trim())
      : [text];

  const denied = leaves.find((leaf) =>
    DENIED_SUBSTRINGS.some((deniedSubstring) => leaf.toUpperCase().includes(deniedSubstring)),
  );
  if (isOr) {
    const allowed = leaves.find((leaf) => ALLOWED_LICENSES.has(leaf.toUpperCase()));
    if (allowed !== undefined && denied === undefined) {
      return { ok: true, message: `license '${license}' is allowlisted (via '${allowed}').` };
    }
    if (denied !== undefined && allowed === undefined) {
      return {
        ok: false,
        message:
          `license '${license}' is denied for an Apache-2.0 product (${denied} is ` +
          `copyleft or source-available). Use Apache-2.0, MIT, BSD, ISC, Unlicense, or CC0.`,
      };
    }
    return {
      ok: false,
      message:
        `license '${license}' is not on the allowlist (Apache-2.0, MIT, BSD, ISC, ` +
        `Unlicense, CC0, BlueOak-1.0.0, Python-2.0, 0BSD).`,
    };
  }

  if (denied !== undefined) {
    return {
      ok: false,
      message:
        `license '${license}' is denied for an Apache-2.0 product (${denied} is ` +
        `copyleft or source-available). Use Apache-2.0, MIT, BSD, ISC, Unlicense, or CC0.`,
    };
  }
  if (leaves.every((leaf) => ALLOWED_LICENSES.has(leaf.toUpperCase()))) {
    return { ok: true, message: `license '${license}' is allowlisted.` };
  }
  return {
    ok: false,
    message:
      `license '${license}' is not on the allowlist (Apache-2.0, MIT, BSD, ISC, ` +
      `Unlicense, CC0, BlueOak-1.0.0, Python-2.0, 0BSD).`,
  };
}

async function defaultRead(path: string): Promise<string> {
  return await readFile(path, 'utf8');
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Resolve `<path>` to a plugin root and manifest path. */
export function resolvePluginPath(
  input: string,
  cwd: string,
): {
  readonly root: string;
  readonly manifestPath: string;
} {
  const absolute = isAbsolute(input) ? input : resolve(cwd, input);
  if (absolute.toLowerCase().endsWith('.json')) {
    return { root: dirname(absolute), manifestPath: absolute };
  }
  return { root: absolute, manifestPath: join(absolute, 'adze.plugin.json') };
}

interface FileAccess {
  readonly read: (path: string) => Promise<string>;
  readonly exists: (path: string) => Promise<boolean>;
}

interface Accumulator {
  readonly root: string;
  readonly files: FileAccess;
  readonly gates: ValidateGate[];
  readonly diagnostics: PluginDiagnostic[];
  readonly commands: string[];
  readonly agents: string[];
}

function fail(
  acc: Accumulator,
  code: PluginDiagnostic['code'],
  message: string,
  field?: string,
): void {
  acc.diagnostics.push(
    field === undefined ? errorDiagnostic(code, message) : errorDiagnostic(code, message, field),
  );
}

/**
 * Validate one plugin directory without executing its code.
 *
 * `installed` carries the already-installed command/agent names to check
 * collisions against. Pass the workspace's installed set (with the dev override
 * applied) so `validate` reports the collision `add` would create.
 *
 * One gate per helper below, so each reads alone and this function stays an
 * orchestration: read the manifest, then run the gates in order.
 */
export async function validatePlugin(
  inputPath: string,
  deps: ValidateDeps & {
    readonly cwd: string;
    readonly installed?: readonly InstalledDeclarations[];
  },
): Promise<ValidateReport> {
  const acc: Accumulator = {
    root: resolvePluginPath(inputPath, deps.cwd).root,
    files: { read: deps.readFile ?? defaultRead, exists: deps.exists ?? defaultExists },
    gates: [],
    diagnostics: [],
    commands: [],
    agents: [],
  };
  const { manifestPath } = resolvePluginPath(inputPath, deps.cwd);

  const manifest = await readManifestGate(acc, manifestPath);
  if (manifest === undefined) return finishReport(acc, undefined, manifestPath);

  checkLicenseGate(acc, manifest);
  checkEnginesGate(acc, manifest, deps.engineVersion);
  checkEnvGate(acc, manifest);
  checkGlobsGate(acc, manifest);
  await checkFilesGate(acc, manifest);
  checkCollisionsGate(acc, manifest.id, deps.installed ?? []);

  return finishReport(acc, manifest.id, manifestPath);
}

function finishReport(
  acc: Accumulator,
  id: string | undefined,
  manifestPath: string,
): ValidateReport {
  return {
    ok: acc.gates.every((gate) => gate.ok),
    id,
    root: acc.root,
    manifestPath,
    gates: acc.gates,
    diagnostics: acc.diagnostics,
    commands: acc.commands,
    agents: acc.agents,
  };
}

/** Gate 1: the manifest reads, scans clean, and parses. */
async function readManifestGate(
  acc: Accumulator,
  manifestPath: string,
): Promise<PluginManifest | undefined> {
  let raw: string;
  try {
    raw = await acc.files.read(manifestPath);
  } catch (error) {
    acc.gates.push({
      name: 'manifest',
      ok: false,
      message: `could not read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return undefined;
  }

  const parsed = parseManifest(raw, manifestPath);
  if (!parsed.ok) {
    acc.diagnostics.push(...parsed.diagnostics);
    acc.gates.push({
      name: 'manifest',
      ok: false,
      message: parsed.diagnostics[0]?.message ?? 'manifest is invalid',
    });
    return undefined;
  }
  acc.gates.push({
    name: 'manifest',
    ok: true,
    message: 'manifest parses (unicode scan + schema).',
  });
  return parsed.manifest;
}

/** Gate 2: the license is allowlisted for an Apache-2.0 product. */
function checkLicenseGate(acc: Accumulator, manifest: PluginManifest): void {
  const license = licenseGate(manifest.license);
  acc.gates.push({ name: 'license', ok: license.ok, message: license.message });
  if (!license.ok) fail(acc, 'manifest-schema', license.message, 'license');
}

/** Gate 3: `engines.adze` satisfies the running engine. */
function checkEnginesGate(acc: Accumulator, manifest: PluginManifest, engineVersion: string): void {
  const compatibility = checkEngineCompatibility(manifest, engineVersion);
  if (compatibility.ok) {
    acc.gates.push({
      name: 'engines',
      ok: true,
      message: `engines.adze '${manifest.engines.adze}' satisfies ${engineVersion}.`,
    });
    return;
  }
  acc.gates.push({ name: 'engines', ok: false, message: compatibility.diagnostic.message });
  acc.diagnostics.push(compatibility.diagnostic);
}

/** Gate 4: every environment variable a tool reads is declared. */
function checkEnvGate(acc: Accumulator, manifest: PluginManifest): void {
  const declared = new Set(manifest.permissions?.env ?? []);
  const problems: string[] = [];
  for (const [index, tool] of (manifest.contributes?.tools ?? []).entries()) {
    problems.push(...undeclaredReads(tool, index, declared));
  }
  if (problems.length === 0) {
    acc.gates.push({ name: 'env', ok: true, message: 'every environment read is declared.' });
    return;
  }
  acc.gates.push({ name: 'env', ok: false, message: problems.join('; ') });
  for (const problem of problems) fail(acc, 'transport-fields', problem, 'permissions.env');
}

function undeclaredReads(
  tool: { readonly env?: Readonly<Record<string, string>> | undefined },
  index: number,
  declared: ReadonlySet<string>,
): readonly string[] {
  const problems: string[] = [];
  const entries: Readonly<Record<string, string>> = tool.env ?? {};
  for (const [key, value] of Object.entries(entries)) {
    const match = ENV_REFERENCE.exec(value);
    if (match === null) continue;
    const variable = match[1];
    if (variable !== undefined && !declared.has(variable)) {
      problems.push(
        `contributes.tools[${index}] reads '\${env:${variable}}' for '${key}' but does not list it in permissions.env`,
      );
    }
  }
  return problems;
}

/** Gate 5: hook filters and provider patterns compile as globs. */
function checkGlobsGate(acc: Accumulator, manifest: PluginManifest): void {
  const problems: string[] = [];
  for (const [index, hook] of (manifest.contributes?.hooks ?? []).entries()) {
    for (const [kind, patterns] of [
      ['tools', hook.tools],
      ['paths', hook.paths],
    ] as const) {
      if (patterns === undefined) continue;
      const compiled = compileGlobSet(patterns);
      if (!compiled.ok) {
        problems.push(`contributes.hooks[${index}].${kind}: ${compiled.messages.join('; ')}`);
      }
    }
  }
  for (const [index, provider] of (manifest.contributes?.contextProviders ?? []).entries()) {
    if (provider.type !== 'glob') continue;
    const compiled = compileGlobSet(provider.patterns);
    if (!compiled.ok) {
      problems.push(`contributes.contextProviders[${index}]: ${compiled.messages.join('; ')}`);
    }
  }
  if (problems.length === 0) {
    acc.gates.push({
      name: 'globs',
      ok: true,
      message: 'tools/paths filters and patterns compile.',
    });
    return;
  }
  acc.gates.push({ name: 'globs', ok: false, message: problems.join('; ') });
  for (const problem of problems) fail(acc, 'manifest-schema', problem);
}

/** Gate 6: referenced files exist, scan clean, and parse. */
async function checkFilesGate(acc: Accumulator, manifest: PluginManifest): Promise<void> {
  const problems: string[] = [];
  problems.push(...(await checkHookModules(acc, manifest)));
  problems.push(...(await checkCommandFiles(acc, manifest)));
  problems.push(...(await checkAgentFiles(acc, manifest)));
  problems.push(...(await checkProviderModules(acc, manifest)));
  problems.push(...checkSelfDuplicates(acc));

  if (problems.length === 0) {
    acc.gates.push({ name: 'files', ok: true, message: 'referenced files exist and parse.' });
  } else {
    acc.gates.push({ name: 'files', ok: false, message: problems.join('; ') });
  }
}

async function readReferenced(
  acc: Accumulator,
  relative: string,
  field: string,
): Promise<string | undefined> {
  const absolute = resolve(acc.root, relative);
  if (!(await acc.files.exists(absolute))) {
    fail(acc, 'file-missing', `'${relative}' (${field}) does not exist.`, field);
    return undefined;
  }
  try {
    return await acc.files.read(absolute);
  } catch (error) {
    fail(
      acc,
      'file-missing',
      `'${relative}' (${field}) could not be read: ${error instanceof Error ? error.message : String(error)}`,
      field,
    );
    return undefined;
  }
}

function isJavaScriptModule(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.js') || lower.endsWith('.mjs');
}

async function checkHookModules(acc: Accumulator, manifest: PluginManifest): Promise<string[]> {
  const problems: string[] = [];
  for (const [index, contribution] of (manifest.contributes?.hooks ?? []).entries()) {
    const field = `contributes.hooks[${index}]`;
    const absolute = resolve(acc.root, contribution.module);
    if (!(await acc.files.exists(absolute))) {
      const message = `module '${contribution.module}' (${field}) does not exist.`;
      problems.push(message);
      fail(acc, 'file-missing', message, field);
      continue;
    }
    if (isJavaScriptModule(contribution.module)) {
      problems.push(...(await scanModuleFile(acc, absolute, contribution.module, field)));
    }
  }
  return problems;
}

async function scanModuleFile(
  acc: Accumulator,
  absolute: string,
  label: string,
  field: string,
): Promise<string[]> {
  try {
    const source = await acc.files.read(absolute);
    if (scanForHiddenCharacters(source).ok) return [];
    const message = `module '${label}' contains hidden characters.`;
    fail(acc, 'hidden-characters', message, field);
    return [message];
  } catch (error) {
    const message =
      `module '${label}' could not be read: ` +
      `${error instanceof Error ? error.message : String(error)}`;
    fail(acc, 'file-missing', message, field);
    return [message];
  }
}

async function checkCommandFiles(acc: Accumulator, manifest: PluginManifest): Promise<string[]> {
  const problems: string[] = [];
  for (const [index, reference] of (manifest.contributes?.commands ?? []).entries()) {
    const field = `contributes.commands[${index}]`;
    const text = await readReferenced(acc, reference.path, field);
    if (text === undefined) {
      problems.push(`'${reference.path}' is missing.`);
      continue;
    }
    const name = parseCommandText(acc, manifest.id, reference.path, text, field);
    if (name === undefined) problems.push(`'${reference.path}' does not parse.`);
    else acc.commands.push(name);
  }
  return problems;
}

function parseCommandText(
  acc: Accumulator,
  pluginId: string,
  relative: string,
  text: string,
  field: string,
): string | undefined {
  if (!scanForHiddenCharacters(text).ok) {
    fail(acc, 'hidden-characters', `'${relative}' contains hidden characters.`, field);
    return undefined;
  }
  const parsed = parseSlashCommand(pluginId, relative, text);
  if (!parsed.ok) {
    acc.diagnostics.push(...parsed.diagnostics);
    return undefined;
  }
  return parsed.command.name;
}

async function checkAgentFiles(acc: Accumulator, manifest: PluginManifest): Promise<string[]> {
  const problems: string[] = [];
  for (const [index, reference] of (manifest.contributes?.agents ?? []).entries()) {
    const field = `contributes.agents[${index}]`;
    const text = await readReferenced(acc, reference.path, field);
    if (text === undefined) {
      problems.push(`'${reference.path}' is missing.`);
      continue;
    }
    const name = parseAgentText(acc, manifest.id, reference.path, text, field);
    if (name === undefined) problems.push(`'${reference.path}' does not parse.`);
    else acc.agents.push(name);
  }
  return problems;
}

function parseAgentText(
  acc: Accumulator,
  pluginId: string,
  relative: string,
  text: string,
  field: string,
): string | undefined {
  if (!scanForHiddenCharacters(text).ok) {
    fail(acc, 'hidden-characters', `'${relative}' contains hidden characters.`, field);
    return undefined;
  }
  const parsed = parseSubagent(pluginId, relative, text);
  if (!parsed.ok) {
    acc.diagnostics.push(...parsed.diagnostics);
    return undefined;
  }
  return parsed.definition.name;
}

async function checkProviderModules(acc: Accumulator, manifest: PluginManifest): Promise<string[]> {
  const problems: string[] = [];
  for (const [index, provider] of (manifest.contributes?.contextProviders ?? []).entries()) {
    if (provider.type === 'glob') continue;
    const field = `contributes.contextProviders[${index}]`;
    if (await acc.files.exists(resolve(acc.root, provider.module))) continue;
    const message = `module '${provider.module}' (${field}) does not exist.`;
    problems.push(message);
    fail(acc, 'file-missing', message, field);
  }
  return problems;
}

function checkSelfDuplicates(acc: Accumulator): string[] {
  const repeated = [...duplicates(acc.commands), ...duplicates(acc.agents)];
  for (const problem of repeated) fail(acc, 'duplicate-name', problem);
  return repeated;
}

/** Gate 7: command/agent names do not collide with the installed set. */
function checkCollisionsGate(
  acc: Accumulator,
  pluginId: string,
  installed: readonly InstalledDeclarations[],
): void {
  const takenCommands = new Map<string, string>();
  const takenAgents = new Map<string, string>();
  for (const plugin of installed) {
    if (plugin.id === pluginId) continue;
    for (const command of plugin.commands) takenCommands.set(command.name, plugin.id);
    for (const agent of plugin.agents) takenAgents.set(agent.name, plugin.id);
  }
  const collisions: string[] = [];
  for (const name of acc.commands) {
    const owner = takenCommands.get(name);
    if (owner === undefined) continue;
    collisions.push(`command '/${name}' is already contributed by '${owner}'`);
    fail(
      acc,
      'duplicate-name',
      `command '/${name}' collides with '${owner}'. The first loaded entry wins; rename one.`,
      'contributes.commands',
    );
  }
  for (const name of acc.agents) {
    const owner = takenAgents.get(name);
    if (owner === undefined) continue;
    collisions.push(`subagent '${name}' is already contributed by '${owner}'`);
    fail(
      acc,
      'duplicate-name',
      `subagent '${name}' collides with '${owner}'. The first loaded entry wins; rename one.`,
      'contributes.agents',
    );
  }
  if (collisions.length === 0) {
    acc.gates.push({
      name: 'collisions',
      ok: true,
      message: 'no command/agent collision with the installed set.',
    });
  } else {
    acc.gates.push({ name: 'collisions', ok: false, message: collisions.join('; ') });
  }
}

function duplicates(names: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) repeated.add(name);
    seen.add(name);
  }
  return [...repeated].map((name) => `declares '${name}' more than once in this plugin`);
}
