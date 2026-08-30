# Branding

Everything that makes a Code-OSS build identify itself as Adze rather than as
Microsoft's product.

| File | What it is |
| --- | --- |
| [`product.delta.jq`](product.delta.jq) | The `product.json` delta. Applied to upstream's file at build time by [`../scripts/30-generate-product.sh`](../scripts/30-generate-product.sh). |
| [`gallery-namespaces.json`](gallery-namespaces.json) | Publisher namespaces claimed on our gallery. The authority list for the ADR-0009 audit gate. |

Binary assets — icons, installer imagery, Linux packaging templates — are
[patch 0001](../patches/0001-branding-icons-and-installer-resources.patch.no) and
do not exist yet.

---

## Why the delta is a program

`product.json` took **29 upstream commits in 5.8 months**. A fork that stores its
own merged copy therefore conflicts on it at nearly every one of upstream's ~50
releases a year, and the conflict is the worst kind available: a large JSON document
where the correct resolution is always "every one of their changes plus every one of
ours", which is precisely what a textual three-way merge cannot express.

Storing only the delta makes that a build step. Upstream's new keys arrive on their
own; our overrides are re-applied on top. ADR-0010 calls this the highest-value
single decision in the fork strategy, and the measurable effect is that the largest
recurring conflict source stops existing.

Verify a change without cloning upstream:

```bash
bash apps/ide/scripts/verify-product-delta.sh
```

42 checks against [`../fixtures/product.upstream.json`](../fixtures/product.upstream.json),
including idempotence and the real ADR-0009 audit gate.

---

## The four win32 AppId GUIDs

```
win32x64AppId          {{C76EC0FD-AFD1-400E-951C-048A10848E7F}}
win32arm64AppId        {{0B42E3F0-A32E-4680-AA4F-23686A4EEEE5}}
win32x64UserAppId      {{B149EAD6-EC50-4A86-8BD3-D4DEA0319C19}}
win32arm64UserAppId    {{1FCC2728-09F7-4CA1-BB18-24D373264AA6}}
```

Generated fresh for Adze with `crypto.randomUUID()`. Four, because per-machine and
per-user installs are distinct products to Inno Setup, and x64 and arm64 are
distinct again.

**Reusing upstream's GUIDs would make our installer an upgrade of the user's real
VS Code.** Inno Setup treats AppId as product identity: an installer carrying VS
Code's AppId is not installed alongside it, it replaces it — inheriting its
uninstall entry and, on uninstall, removing it. That is the most destructive
branding mistake available to a fork, and it is silent until it happens on someone
else's machine.

The doubled braces are required. Inno Setup expands `{...}` as a constant, so a
literal brace is written `{{`. Upstream ships the same escaping.

**Never regenerate these once a build has shipped.** Changing an AppId orphans every
existing installation: the new installer does not recognise the old one, so it
cannot upgrade or uninstall it, and the user is left with two entries and no way to
remove the first.

`win32MutexName`, `win32SetupMutexName`, `win32RegValueName`, and
`win32AppUserModelId` are distinct from upstream's for the same reason in three
different mechanisms — a shared mutex makes each product believe the other is a
running instance of itself, a shared registry value name has them overwrite each
other's file associations, and a shared AppUserModelId merges them into one taskbar
button.

`30-generate-product.sh` asserts on every one of these, including an explicit
comparison against upstream's published Code-OSS AppIds, so copying them back in is
a build failure rather than something discovered after an installer ships.

---

## Placeholder endpoints

The delta ships hostnames under RFC 2606 reserved TLDs (`.example`):

```
extensionsGallery.serviceUrl   https://gallery.adze.example/vscode/gallery
updateUrl                      https://updates.adze.example
```

No gallery and no update feed have been deployed. ADR-0009 requires a self-hosted
Open VSX instance — Postgres, Elasticsearch, Redis, object storage — and rejected
depending on `open-vsx.org` directly.

`30-generate-product.sh` **refuses** to write a `product.json` containing any of
them. Override for local inspection only:

```bash
ADZE_ALLOW_PLACEHOLDER_ENDPOINTS=1 bash apps/ide/scripts/30-generate-product.sh
```

This is deliberate: it makes "no distributable binary exists" a property the
pipeline enforces rather than a claim in a README that drifts.

---

## Editing the delta

Read the header comment in [`product.delta.jq`](product.delta.jq) first. The three
rules that matter:

1. **Assign, do not reconstruct.** `.key = value` preserves every upstream key we
   have not spoken about. Rebuilding the document drops whatever upstream added
   last week — silently, which is the failure mode this whole approach exists to
   avoid.
2. **Keep the shapes.** `languageExtensionTips` is an array,
   `configBasedExtensionTips` is an object. The workbench indexes them by type and
   throws at startup on a mismatch.
3. **Stay self-contained.** The merge bot invokes `jq -f` with no `--arg`, so a
   variable dependency breaks automation.

Then run `verify-product-delta.sh`. It caught `tasConfig` — upstream's experiment
assignment endpoint — surviving an earlier revision of the telemetry deletions,
which is the entire argument for having a fixture.
