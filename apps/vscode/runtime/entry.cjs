// The CommonJS entry point, and the only file in this package that knows the
// `vscode` module exists.
//
// Two jobs, both of which have to happen outside TypeScript:
//
// 1. **Module format.** The VS Code extension host loads `main` with `require`,
//    so the entry must be CommonJS. The rest of this repo is ESM-only (Node 22+,
//    `moduleResolution: nodenext`), and no bundler is installed in this
//    workspace, so the compiled extension is real ESM reached through a dynamic
//    `import()`. `activate` is allowed to return a promise, which is what makes
//    that legal.
//
// 2. **Dependency injection.** The `vscode` namespace is `require`d here and
//    passed *into* the extension as an argument. Nothing under `src/` imports
//    `vscode`, which is what lets the whole extension be unit-tested against a
//    fake host with no VS Code process anywhere. The API surface actually used is
//    declared explicitly in `src/host/api.ts`; if a symbol is not in that file,
//    the extension does not touch it.
//
// Keep this file dependency-free and boring. It cannot be tested in isolation.

const { pathToFileURL } = require('node:url');
const vscode = require('vscode');

/** @type {undefined | { activate: Function, deactivate: Function }} */
let loaded;

async function load() {
  if (loaded === undefined) {
    // `require.resolve` first so the path is absolute before it becomes a URL.
    // A bare relative specifier would resolve against the process cwd on some
    // hosts, and on Windows a drive-letter path is not a valid URL.
    const entry = pathToFileURL(require.resolve('../dist/extension.js')).href;
    loaded = await import(entry);
  }
  return loaded;
}

exports.activate = async function activate(context) {
  const mod = await load();
  return mod.activate(vscode, context);
};

exports.deactivate = async function deactivate() {
  if (loaded === undefined) return;
  await loaded.deactivate();
};
