# Adze for VS Code

The Adze engine, running in the extension host, rendered by a VS Code extension.

This is the project's first surface and its primary distribution channel. It reaches
VS Code, Cursor, and Windsurf users with no build pipeline of our own, and it is the
reason Adze is not a single-surface project — the shape that killed every casualty in
this category ([ADR-0001](../../docs/architecture/adr/0001-engine-first-architecture.md)).

**On the gallery question:** publishing an extension *to* the Microsoft Marketplace is
explicitly permitted. What the Marketplace Terms of Use prohibit is *consuming* the
Marketplace from a fork, which is a constraint on the Adze IDE and not on this package
([ADR-0009](../../docs/architecture/adr/0009-extension-gallery.md)). So this extension
targets **both** the Microsoft Marketplace and Open VSX.

## What is real, and what is not

`apps/vscode` is [M2](../../docs/roadmap.md) work. What this commit contains:

| Capability | State |
| --- | --- |
| Chat sidebar streaming engine events | Implemented |
| Inline highlight of applied edits, with accept and revert | Implemented; **review-after-write**, see below |
| Ghost text via `InlineCompletionItemProvider` | Implemented, **off by default** |
| Commands, keybindings, context menu | Implemented |
| Approval prompt as a modal, `never` refuses | Implemented |
| Status bar: model, token split, cost, cache hit rate | Implemented |
| Configuration for sandbox, approvals, model, budgets | Implemented |
| Attachments and images | Not implemented. The protocol carries them; this surface does not send them yet. |
| Widening `writableRoots` from settings | Not implemented. The workspace root is the only writable root. |
| MCP servers as tools | Not here. `@adze/mcp`, same milestone. |
| A packaged VSIX that installs cleanly | Not yet. See [Packaging](#packaging). |

The engine runs **in-process**. The extension host is already a Node process and
`@adze/core` is a set of typed methods, so there is no transport, no serialization,
and no sidecar to start. `src/engine/host.ts` is the only module that imports
`@adze/core` or `@adze/providers`; everything else speaks `@adze/protocol` types, so
pointing this extension at an out-of-process engine later means replacing one file.

## Why there is no `@types/vscode`

Nothing under `src/` imports the `vscode` module. `runtime/entry.cjs` requires it once
and passes the namespace *in* as an argument, typed by `src/host/api.ts` — a hand-written
declaration of exactly the API slice this extension uses.

That started as a constraint (`@types/vscode` is not installed in this workspace, and
adding it needs an install) and turned out to be the better design for three reasons.
It is the seam that makes the whole extension unit-testable against a fake host with no
VS Code process. It puts the API surface in one auditable file, so an accidental
dependency on a *proposed* API — which ADR-0010 rules out for this surface — would be a
visible edit rather than an invisible import. And it keeps the module-format problem in
one place: the extension host loads `main` with `require`, this repo is ESM-only, and the
shim bridges the two with a dynamic `import()`.

The cost is real and worth naming: **TypeScript cannot check `src/host/api.ts` against
the actual VS Code API**, because the runtime object crosses an untyped boundary in the
shim. A wrong declaration there is a runtime bug, not a compile error. The file says so
at the top. If `@types/vscode` is added later, that file becomes checkable against it.

## Trying it in a development host

There is no bundler and no VSIX yet, so run it from source.

```powershell
# From the repo root, once:
pnpm install

# From apps/vscode:
node ../../node_modules/typescript/bin/tsc -p tsconfig.build.json
```

Then, in VS Code:

1. `File > Open Folder` on this repository.
2. Open the Run and Debug view, choose **Run Extension**, press F5. If that
   configuration is not present (this package ships no `.vscode/launch.json` yet),
   create one with `"type": "extensionHost"`, `"args": ["--extensionDevelopmentPath=${workspaceFolder}/apps/vscode"]`.
   Alternatively, from a terminal:
   `code --extensionDevelopmentPath="<repo>/apps/vscode" "<some other folder>"`.
3. In the new window, **open a folder** — Adze needs a workspace root and says so
   rather than silently doing nothing.
4. Click the Adze icon in the activity bar. That is what activates the extension.
5. Set a credential in the environment the editor was launched from, for example
   `$env:ANTHROPIC_API_KEY = "sk-..."`. Without one, the first prompt reports the
   exact variable to set — that is intended behaviour, not a failure to handle.
6. Type a prompt and press Send.

Rebuild after a source change (`tsc -p tsconfig.build.json`) and use
`Developer: Reload Window` in the development host.

## Commands

| Command | Default key | Notes |
| --- | --- | --- |
| `Adze: Start Chat` | `Ctrl+Alt+A` | Focuses the sidebar |
| `Adze: Apply to Selection` | `Ctrl+Alt+K` | Needs a selection; also in the editor context menu |
| `Adze: Cancel Run` | `Ctrl+Alt+Backspace` | Only while a turn is in flight |
| `Adze: Accept Edits in This File` | `Ctrl+Alt+Enter` | Clears the highlight |
| `Adze: Revert Edits in This File` | `Ctrl+Alt+Delete` | Computes the inverse edit, or refuses |

Activation is lazy: `onView:adze.chatView` plus the implicit `onCommand:` events VS Code
derives from the command contributions. Nothing runs at startup.

**The consequence, stated plainly: ghost text is only available after the extension has
activated** — that is, after the Adze view has been opened or an Adze command has run in
that window. Activating on startup to avoid that would make every user pay for a feature
that is off by default.

## Configuration

All keys are under `adze.`. Two behaviours are worth knowing because they are
deliberate:

**An unrecognised value narrows, it does not fall back to the default.** A typo in
`adze.approvals.policy` resolves to `never`, which refuses, rather than to `on-request`,
which prompts and can be answered yes. `adze.sandbox.mode` narrows to `read-only`. A
typo must not grant more than you asked for.

**Any invalid setting blocks the run**, with a message naming every bad key. Narrowing
alone is not enough for a budget, because the fail-closed value for a ceiling is not
obvious and "unbounded" is plainly the wrong guess.

| Key | Default | Notes |
| --- | --- | --- |
| `adze.model` | `""` | `provider/model`. Empty means provider configuration decides. |
| `adze.sandbox.mode` | `workspace-write` | `read-only`, `workspace-write`, `full-access` |
| `adze.approvals.policy` | `on-request` | `untrusted`, `on-request`, `never` |
| `adze.budget.maxSteps` | `null` | `null` is unbounded. `0` is rejected, not read as unbounded. |
| `adze.budget.maxTokens` | `null` | |
| `adze.budget.maxWallClockMs` | `null` | |
| `adze.budget.maxSpendUsd` | `null` | `0` is legal here and means no spend permitted. |
| `adze.inlineCompletion.enabled` | `false` | See below. |
| `adze.inlineCompletion.debounceMs` | `500` | |
| `adze.inlineCompletion.maxPrefixBytes` | `4096` | |
| `adze.instructions` | `""` | Extra session instructions. |

Credentials are **not** read from settings. Settings sync to a cloud account and get
committed in workspace files; environment variables and `~/.adze/providers.json` are
where `@adze/providers` looks.

Changing `adze.model`, `adze.sandbox.*`, `adze.approvals.*`, or `adze.instructions`
tears the session down, so the next turn is created with the new values. The engine
reports what is actually in force; leaving a session alive after its settings changed
would make the status bar and the approval prompts describe settings you already
changed.

## Ghost text is off by default

`@adze/protocol` has no cheap-completion message. There is `turn.submit` and nothing
lighter, and no fill-in-the-middle shape, so a suggestion allocates a turn id, runs the
whole turn machine, and is billed like any other request. Enabling it means opting into
billed requests you did not deliberately submit, which is not a default worth shipping.
Completions run in a **separate session** so they never enter the conversation you are
having.

## Security posture

- **No telemetry. No network calls.** The only outbound traffic this extension can cause
  is the model request the engine makes to the provider you configured.
- The chat webview runs under `default-src 'none'` with **no `connect-src` at all**, so
  the panel cannot reach the network even if a future edit tries. Scripts load only with
  a per-render nonce; there is no inline script, no `unsafe-inline`, and no remote
  content. A malformed nonce makes the render throw rather than emit a policy a crafted
  value could truncate.
- Model output is written to the DOM with `textContent`, never `innerHTML`.
- **On Windows there is no OS-level sandbox.** The permission gate and approval policy
  still apply, but an approved action runs unconfined. The approval modal says so, once
  per session ([ADR-0007](../../docs/architecture/adr/0007-sandbox-and-permissions.md)).
- `never` refuses rather than escalating, and it is defended twice: the gate does not
  call the approval channel under that policy, and this surface answers `deny`
  unconditionally if it ever is called.
- A dismissed approval modal is a **denial**, not consent and not a re-prompt.

## Inline diff is review-after-write

The engine writes the file itself. `edit.proposed` and `edit.applied` are both emitted
*after* `writeFile` returns, so this surface cannot offer accept-or-reject before the
write, and cannot capture the pre-edit bytes. What it does instead:

- highlights the region each applied edit now occupies, with the tier, match strategy,
  and validator level from `ApplyTelemetry` on hover — reported as they arrived, never
  widened;
- **Accept** clears the highlight;
- **Revert** computes the inverse of a search/replace edit and **refuses rather than
  guessing** when the inverse is not derivable: an ambiguous replacement, a deletion, a
  whole-file rewrite, or overlapping spans. The refusal says why and points at Undo. A
  revert button that quietly does nothing is worse than one that explains itself.

Deep view-zone streaming diff is IDE-fork territory
([ADR-0010](../../docs/architecture/adr/0010-ide-fork-strategy.md)).

## Protocol gaps found while building this

Per ADR-0001 rule 2, a capability gap between surfaces is a *protocol* gap. These are
the ones this surface actually hit. None was worked around with a private back channel.

1. **No pre-write edit review.** The largest one. `edit.proposed` is emitted alongside
   `edit.applied` after the write, so no surface can implement accept-before-apply, and
   a byte-exact revert is not derivable. Closing it needs either an engine-to-surface
   request that awaits a decision before the write, or `originalContent` / original
   spans on `AppliedEdit`.
2. **`ApprovalRequest` cannot carry the edit it authorizes.** `kind: 'file-write'` gives
   `paths` and no `editId`, so an approval prompt cannot show a diff of what it is about
   to permit — the highest-value thing a diff review could be attached to.
3. **No cheap-completion or fill-in-the-middle message.** See the ghost text section.
   `TurnSubmitParams.prompt` is one non-empty string, so suffix context has to be
   described inside the prompt.
4. **`Cost` never appears on the wire.** `CostSchema` exists in `primitives.ts` but no
   event or result carries it, and there is no message exposing a price sheet. A surface
   that shows cost must import `computeCost` from `@adze/core` and `priceFor` from
   `@adze/providers`, which this one does, following the CLI's precedent.
5. **No message enumerates available models.** A model picker needs `@adze/providers`
   directly, so the extension has no protocol-only way to offer one.
6. **`edit.applied` does not repeat the edit blocks**, so a surface must retain every
   `edit.proposed` and pair it by `editId`. Workable, and worth noting because a surface
   that attaches late cannot review edits at all.

## Testing

125 unit tests, no VS Code download, no network, no API key, no spend. The `vscode`
module is never imported by anything under `src/` — it is injected as an argument by
`runtime/entry.cjs` — so the host is a hand-written fake in `test/fake-vscode.ts`.

**Unit-tested here:**

- event stream to view model, including a denial staying distinct from a failed tool, a
  refusal staying distinct from an error, and a gap in `seq` being counted rather than
  hidden;
- revert planning: ambiguity refused, deletions and whole-file rewrites refused,
  overlapping spans refused, operation ordering;
- approval logic: `never` denying unconditionally, dismissal as denial, the containment
  note appearing only when enforcement is `gate-only`;
- settings resolution: narrowing direction, zero rejected for step budgets and accepted
  for spend, every problem blocking the run;
- the CSP: `default-src 'none'`, no `connect-src`, no `unsafe-inline`, no remote origins,
  malformed nonce rejected;
- webview message parsing, which rejects anything unrecognised rather than forwarding it;
- status formatting: unpriced models reporting `unknown` and never `$0.00`, the token
  split and cache hit rate reported together;
- ghost text: no request while disabled or busy, no request after cancellation during
  the debounce, fence unwrapping, duplicate-line suppression, silence on failure;
- edit decoration and revert against the fake host, including that a refusal writes
  nothing;
- path resolution and case sensitivity per platform.

**Needs manual in-editor verification** — a fake that "passed" for these would be worse
than admitting they are manual:

- the webview actually loads `chat.js` under the real CSP, and the panel renders;
- decorations paint where expected, and the hover shows the telemetry;
- the approval modal renders four buttons and Escape produces a denial;
- keybindings and `when` clauses (`adze.running`, `adze.hasReviewableEdits`) resolve;
- the activity bar icon renders;
- lazy activation really does not fire at startup;
- the CommonJS shim loads the ESM build inside the real extension host;
- `Ctrl+Alt+K` on a selection produces a usable edit end to end against a live model.

## Packaging

```powershell
pnpm --filter adze-vscode package:vsix   # vsce package
```

Three prerequisites before that artifact is publishable, all stated rather than
discovered:

1. **A bundler.** The extension is authored as ESM and loaded through a CommonJS shim,
   with production dependencies resolved from `node_modules`. `vsce` and pnpm's symlinked
   store do not combine well, so the VSIX needs `esbuild` or `tsup` wired up first. No
   bundler is installed in this workspace, so none was added here.
2. **A 128×128 PNG icon.** `media/adze.svg` covers the activity bar; the marketplace
   listing needs a raster icon and a claimed `publisher`.
3. **A `.vscode/launch.json`** for one-key F5 debugging, which this package does not ship
   yet.

### `ovsx` is not a dependency, on purpose

`@vscode/vsce` is MIT and is a normal devDependency. **`ovsx` is EPL-2.0**, which this
repo's dependency policy forbids outright, so it is not in the catalog and not in any
`package.json`. `publish:openvsx` invokes it through `pnpm dlx` at a pinned version: the
tool is *used* to publish, never linked into our graph and never distributed inside our
artifact. Publishing to Open VSX still happens; the license just does not travel with us.

`publish:marketplace` and `publish:openvsx` scripts exist. **Neither has been run.**
