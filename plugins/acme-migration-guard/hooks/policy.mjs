/**
 * Migration Guard — a deny-capable policy hook.
 *
 * This is the shape ADR-0008 argues for: a team encodes its own rule, and nobody has
 * to ship a policy feature or maintain a fork. The whole policy is the two functions
 * below.
 *
 * The guest contract is one export: `invoke(functionName, input)`, where
 * `functionName` is the event name and the return value is
 * `{ kind: "allow" | "deny" | "modify", ... }`. That is the same convention a
 * `wasm32-wasip2` module implements across the component boundary, with JSON in and
 * JSON out; this module is JavaScript because Adze does not ship a WASM runtime yet,
 * and its manifest says `"runtime": "js"` rather than pretending otherwise.
 *
 * `"runtime": "js"` means **unsandboxed**: this file runs in the Adze process with
 * full privileges, so a host has to pass `allowUnsandboxedJs` to load it. A published
 * version of this plugin would compile to WebAssembly and need no such flag.
 */

const MIGRATION_PATH = /(^|\/)migrations?(\/|$)/i;

/**
 * Block a write to a migration directory unless a human has already approved it.
 *
 * The denial names the policy id. A blocked action whose reason is "denied by policy"
 * sends the developer to ask in chat; one that says `acme-eng-014` sends them to the
 * document, and the model can quote it back when it explains why it stopped.
 */
function editPre(input) {
  const path = typeof input.path === 'string' ? input.path : '';
  if (!MIGRATION_PATH.test(path)) return { kind: 'allow' };
  if (input.approvedByHuman === true) return { kind: 'allow' };

  return {
    kind: 'deny',
    reason:
      `'${path}' is a database migration, and migrations require human review before ` +
      `they are written (policy: acme-eng-014). Describe the schema change and the ` +
      `rollback plan instead, and a reviewer will apply it.`,
  };
}

/**
 * Rewrite `npm`/`yarn` commands to `pnpm`, and refuse `npm install`.
 *
 * Two behaviours in one hook on purpose, because they demonstrate the two useful
 * answers. A wrong package manager is a *fixable* mistake, so it is a `modify` — the
 * agent never sees an error and does not spend a step recovering. Writing a second
 * lockfile is not fixable by rewriting, so it is a `deny` with an explanation the
 * model can act on.
 */
function toolPre(input) {
  if (input.name !== 'bash') return { kind: 'allow' };
  const args = input.arguments ?? {};
  const command = typeof args.command === 'string' ? args.command : '';
  if (command.length === 0) return { kind: 'allow' };

  if (/^\s*(npm|yarn)\s+(install|i|add)\b/.test(command)) {
    return {
      kind: 'deny',
      reason:
        `this repository uses pnpm with a committed lockfile, and '${command.trim()}' would ` +
        `write a second one. Use 'pnpm add <pkg>', and put the version in the catalog: ` +
        `block of pnpm-workspace.yaml.`,
    };
  }

  const rewritten = command.replace(/^\s*(?:npm run|yarn)\s+/, 'pnpm ');
  if (rewritten === command) return { kind: 'allow' };

  return { kind: 'modify', arguments: { ...args, command: rewritten } };
}

export function invoke(functionName, input) {
  switch (functionName) {
    case 'edit.pre':
      return editPre(input);
    case 'tool.pre':
      return toolPre(input);
    default:
      // An unknown event is allowed rather than denied. This module has no opinion
      // about events it did not register for, and a hook that vetoes on the basis of
      // not understanding the question is a hook that breaks on every engine upgrade
      // that adds an event.
      return { kind: 'allow' };
  }
}
