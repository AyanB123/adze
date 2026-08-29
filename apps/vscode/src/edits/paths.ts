/**
 * Path handling for edits reported by the engine.
 *
 * `ProposedEdit.path` is whatever the model passed to the `edit` tool, which the
 * protocol documents as workspace-relative but which the tool also accepts as
 * absolute. So a surface has to handle both rather than assume, and comparing the
 * result against an editor's `fsPath` has to be case-insensitive on Windows or the
 * decoration silently never appears for `C:\Foo` versus `c:\foo`.
 *
 * Pure, and `platform` is a parameter so both comparison branches are testable on
 * one machine.
 */

import { isAbsolute, resolve } from 'node:path';

/** Absolute filesystem path for an edit the engine reported. */
export function resolveEditPath(workspaceRoot: string, editPath: string): string {
  return isAbsolute(editPath) ? resolve(editPath) : resolve(workspaceRoot, editPath);
}

/** Whether two absolute paths name the same file on the given platform. */
export function samePath(left: string, right: string, platform: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  if (platform === 'win32' || platform === 'darwin') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}
