# Additive contribution plan

Everything Adze adds to the editor lives in one directory upstream does not own:

```
src/vs/workbench/contrib/adze/
├── browser/          renderer-process code: widgets, view zones, editor contributions
└── common/           platform-independent types and services
```

Upstream has no opinion on that path. It never appears in an upstream diff, is
never renamed by an upstream refactor, and is not a file anyone else edits — so
**no amount of code here can produce a merge conflict.** That is the structural
claim ADR-0010 rests on, and it is what makes the maintenance cost proportional to
our diff rather than to the tree.

The entire cost of the arrangement is one appended import line in
`workbench.common.main.ts`, carried by
[patch 0002](../patches/0002-workbench-register-adze-contrib.patch.no).

> **Nothing in this document has been written.** No file exists under
> `src/vs/workbench/contrib/adze/`, because that path only exists inside a fetched
> upstream checkout and no checkout has been fetched. This is the design and the
> reasoning for it, at the level of detail needed to start.

---

## Why in-tree at all

Most of Adze does not need to be. The engine is `@adze/core`, the agent runs behind
upstream's Agent Host Protocol, and the extension in `apps/vscode` already reaches
VS Code, Cursor, and Windsurf users without any of this.

Three features cannot be built on the extension API. They are why the IDE exists,
and if they were achievable as an extension the IDE would not be worth its
maintenance clock.

| Feature | Extension API limit |
| --- | --- |
| Streaming inline diff | `TextEditorDecorationType` renders text *within* a line. It cannot insert vertical space, so a proposed replacement has to overwrite the original or appear in a separate diff editor. Showing old and new simultaneously, in place, requires a view zone. |
| Agent-turn undo grouping | The extension host applies edits through `WorkspaceEdit`, which produces one undo entry per edit. An agent turn is 50–200 edits, so `Ctrl+Z` walks backwards through them individually. Grouping needs `IUndoRedoService`, which is not exposed to extensions. |
| Inline edit overlay | The Cmd-K-equivalent widget needs a focusable, positioned surface anchored to a selection with its own keybinding scope. Extensions get a webview panel or a quick input, neither of which is anchored to a line. |

Everything else — chat, sessions, persistence, multi-window, the Agents window,
remote sessions — comes from AHP. ADR-0010 chose that specifically so we are not
maintaining a chat UI against `contrib/inlineChat/`, which took **67 commits in
5.8 months**.

---

## The extension points, and why they are safe

Measured over the same 5.8 months and ~24 upstream releases:

| Extension point | Upstream commits | Used for |
| --- | --- | --- |
| `src/vs/editor/browser/editorExtensions.ts` | **0** | `registerEditorContribution`, `registerEditorAction` |
| `src/vs/editor/browser/services/codeEditorService.ts` | **0** | decoration type registration, editor enumeration |
| `src/vs/editor/browser/editorBrowser.ts` | **0** | `IViewZone`, `IContentWidget`, `IOverlayWidget` |
| `src/vs/platform/product/common/productService.ts` | **0** | reading the `adze` key from `product.json` |

Zero commits each. This is the most actionable result in ADR-0010: **the interfaces
we build on are frozen, and the files upstream is actively developing are exactly
the AI features we are not reimplementing.**

The rule that follows: consume these interfaces, never modify them. A registration
call is a stable dependency. An edit to the file that defines the registration is a
recurring conflict.

---

## Layout

```
src/vs/workbench/contrib/adze/
├── browser/
│   ├── adze.contribution.ts          the single entry point named by patch 0002
│   ├── inlineDiff/
│   │   ├── inlineDiffZone.ts         one view zone per changed region
│   │   └── inlineDiffService.ts      streaming state machine, editor lifecycle
│   ├── undo/
│   │   └── agentTurnUndo.ts          UndoRedoGroup per turn, across files
│   ├── overlay/
│   │   └── inlineEditWidget.ts       the Cmd-K-equivalent content widget
│   └── ahp/
│       ├── agentHostClient.ts        AHP transport and session model
│       └── adzeHarness.ts            translates @adze/core events into AHP
└── common/
    ├── adzeProduct.ts                typed access to product.json's `adze` key
    └── agentTurn.ts                  turn identity shared by undo and diff
```

`adze.contribution.ts` is the only file patch 0002 names. Everything else is
imported from it, so the number of lines the fork adds to an upstream file stays at
one no matter how large this directory becomes.

---

## 1. View-zone-based streaming inline diff

**What it is.** While the agent writes, each changed region shows the original
lines and the proposed lines together, in the editor, with the proposal growing as
tokens arrive. No diff editor, no tab switch, no waiting for the edit to finish.

**Mechanism.** A view zone is a block of vertical space the editor reserves between
two lines, with a caller-owned DOM node inside it. `IViewZone` and
`changeViewZones` are declared in `editorBrowser.ts` — zero upstream commits.

```
editor.changeViewZones(accessor => {
  zoneId = accessor.addZone({
    afterLineNumber,
    heightInLines,
    domNode,
  });
});
```

**The hard parts, in the order they will be hit.**

*Streaming means the height changes on every chunk.* A zone's height is fixed at
creation; changing it is `accessor.layoutZone(id)` inside another
`changeViewZones` call. Doing that per token relayouts the viewport per token,
which is visibly bad on a large file. The fix is to coalesce: buffer chunks and
relayout on a frame boundary, and only when the line count actually changed.

*The user keeps typing.* Zone anchors are line numbers, not positions that move
with the model. An edit above the zone silently misplaces it. Anchor on a decoration
instead — decorations track model changes — and read the decoration's current range
when relayouting.

*Accept and reject need to survive the zone.* The buttons live in the zone's DOM,
but the edit they apply belongs to the model and must join the turn's undo group
(section 2). Keep the zone as a view over turn state held elsewhere, not as the
owner of it.

**Reference.** Void's view-zone diff service is the best available prior art and is
Apache-2.0. ADR-0010 is explicit that we read its source and take its CI workflows,
and do not take its tree.

---

## 2. Custom undo grouping

**What it is.** One `Ctrl+Z` reverts one agent turn. Not one of the 200 micro-edits
the turn produced.

This is the feature users notice within a minute of using an agent, and the one
whose absence makes an agent feel unsafe: if undo is unpredictable, the only safe
way to reject a change is `git checkout`, and a tool you cannot back out of does
not get used on real work.

**Mechanism.** `IUndoRedoService` with an explicit `UndoRedoGroup` per turn.

- One `UndoRedoGroup` is created when the turn starts and passed to every edit the
  turn makes, in every file.
- `model.pushStackElement()` at the turn boundary, and *not* between edits inside
  it, so the edits coalesce into one stack element per model.
- Edits that span files register an `IWorkspaceUndoRedoElement` so undo is atomic
  across them. This is the part extensions cannot reach at all.

**The hard parts.**

*A user edit inside the turn window must break the group.* If someone types into a
file the agent is editing, silently reverting their keystroke along with the agent's
work is data loss. The correct behaviour is to close the group at the user's edit
and start a new one, so undo reverts the user's change first and the agent's turn
second — which is what they will expect.

*Undo has to work after the file is closed and reopened.* `IUndoRedoService` state
is per-session and per-model. A turn that touched a file the user has since closed
cannot be undone through the editor stack, and the honest answer is to say so in
the UI rather than to partially revert.

*Redo must reconstruct the same group.* A group whose redo re-applies edits
individually is worse than no grouping, because the undo/redo pair is then
asymmetric and the user cannot reason about either.

**Testable without a build.** The grouping rules are a state machine over turn
events and model events. That logic belongs in `common/agentTurn.ts` with unit
tests, so that the only untested part is the service wiring.

---

## 3. Inline edit overlay widget

**What it is.** Select code, invoke, describe a change, watch it stream in with
accept and reject in place. The Cmd-K equivalent.

**Mechanism.** `IContentWidget` positioned via `ContentWidgetPositionPreference`,
added with `editor.addContentWidget`. Content widgets scroll with the content and
are anchored to a position, which an overlay widget is not — an overlay is anchored
to the viewport, which is wrong here.

Keybinding scope is a `contextKeyService` scoped child bound to the widget's DOM,
so that `Escape` dismisses the widget instead of clearing the selection, and only
while the widget has focus.

**The hard parts.**

*A content widget does not clip to the viewport.* Near the bottom edge it renders
partially offscreen. `ContentWidgetPositionPreference.ABOVE` with a fallback list
handles the common case; a widget taller than the viewport does not have a good
answer and should scroll internally.

*Focus is the whole feature.* The widget is a text input inside an editor that also
wants keystrokes. Getting focus, keeping it while streaming, and returning it to the
exact prior selection on dismiss is most of the work, and it is the part that feels
broken when it is wrong.

*It shares the diff and the undo group.* The result renders through section 1's
zones and joins section 2's group. Three features, one turn.

---

## What this plan does not include

Stated because a reader would otherwise assume it.

- **No chat UI.** AHP provides it. Building one means competing with a weekly
  upstream release, permanently, for no user-visible gain.
- **No session persistence, no multi-window, no remote sessions.** All AHP.
- **No ghost text.** `InlineCompletionItemProvider` is stable public extension API,
  so it belongs in `apps/vscode` where it reaches other editors too.
- **No settings UI, no new activity bar container beyond what AHP registers.**

Each of those is a feature the IDE could have and a reason the IDE would cost more
than it returns. ADR-0010's stated cost is one engineer's continuous attention on
upstream tracking; the way that budget gets exceeded is by adding in-tree features
that did not need to be in-tree.
