---
'@adze/plugin-sdk': minor
---

Put the whole-file bytes on the `edit.pre` payload, closing a policy bypass.

`edit.pre` is presented as *the* event for vetoing an edit, and its payload carried
`edits: [{ search, replace }]` — everything for a search/replace edit and **nothing for
a whole-file write**. `readCoreWriteArgs` reported core's `write` tool as
`{ path, edits: [], wholeFile: true }`, so a guard inspecting `edits[].replace`, the only
content the declared payload had, refused a credential added by `edit` and allowed the
identical credential written by `write`. That is the worse direction, because `write`
replaces the whole file.

The bytes were reachable only through the raw tool arguments, so the only guard that
worked was one that knew which tool had produced the edit — exactly the coupling
`edit.pre` exists to remove. `EditPrePayload` now carries `content` whenever `wholeFile`
is true, and a content policy can be written against the payload alone.

The same hole existed a second time and had not been reported: `edit` accepts a
whole-file `replacement` for the applier's second tier, and `readCoreEditArgs` set
`wholeFile: true` while dropping those bytes exactly as the `write` reader did. Both
readers now supply `content`, and the tests assert that identical bytes reaching disk get
an identical verdict whether they arrive through `write`, through `edit` with a
`replacement`, or through a search/replace block.

`arguments` is now declared on `EditPrePayload`. It was already being serialized onto the
wire while absent from the interface, which is the worse of the two states: a guest could
read `arguments.content`, nothing promised it, and a later change making the serializer
match the interface would have silently broken every policy that relied on it. Declaring
it makes the promise real, and its documentation says it is the lower-level escape hatch
rather than the field to reach for — reading tool-specific argument names reintroduces the
coupling this change removes.

`content` is omitted rather than sent as `null` for a search/replace edit, so a guest that
checks `content === undefined` does not also have to handle null.
