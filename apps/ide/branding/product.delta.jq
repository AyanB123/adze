# product.delta.jq — the Adze IDE branding delta.
#
#   jq -S -f apps/ide/branding/product.delta.jq <upstream>/product.json
#
# ─── Why this is a jq program and not a product.json ───────────────────────
#
# Upstream's product.json took 29 commits in the 5.8 months measured for
# ADR-0010. A fork that stores its own merged copy therefore hits a conflict on
# that file at nearly every one of the ~50 upstream releases per year, and the
# conflict is the worst possible kind: a large JSON document where the correct
# resolution is "keep every one of their changes and every one of ours", which is
# exactly what a textual three-way merge cannot express.
#
# Storing only the delta converts that recurring merge into a build step. The
# file is regenerated from whatever upstream currently ships, so upstream's new
# keys arrive automatically and our overrides are re-applied on top. The single
# largest source of merge pain in a Code-OSS fork stops existing.
#
# Rules for editing this file:
#
#   * Assign, do not reconstruct. `.key = value` preserves every upstream key we
#     have not spoken about. Rebuilding the document from scratch would silently
#     drop whatever upstream added last week.
#   * `del()` on an absent key is a no-op in jq, so removals stay safe as
#     upstream renames things.
#   * Keep the shapes. Several of these fields are indexed by type in the
#     workbench: `languageExtensionTips` is an array and
#     `configBasedExtensionTips` is an object, and swapping them throws at
#     startup rather than degrading.
#   * This program must stay self-contained. The merge bot invokes it with a bare
#     `jq -f`, so a `--arg` dependency would break automation.

# ─── Identity ──────────────────────────────────────────────────────────────
#
# `nameShort` and `nameLong` are user-visible. `applicationName` is the CLI
# binary and must not collide with `code` on a machine that also has VS Code.
# `dataFolderName` is the per-user directory under $HOME, and reusing upstream's
# would have two editors reading one extension store.
  .nameShort               = "Adze"
| .nameLong                = "Adze"
| .applicationName         = "adze"
| .dataFolderName          = ".adze"
| .serverApplicationName   = "adze-server"
| .serverDataFolderName    = ".adze-server"
| .tunnelApplicationName   = "adze-tunnel"
| .urlProtocol             = "adze"
| .quality                 = "stable"

# Reverse-DNS under a domain we actually control. The project has no registered
# domain, and github.io is the conventional answer for that case — Flathub
# requires exactly this form for projects without one. A bundle identifier
# pointing at a domain someone else can register is a signing and update-channel
# hazard, not a cosmetic detail.
| .darwinBundleIdentifier  = "io.github.ayanb123.adze"
| .linuxIconName           = "adze"

# ─── Windows installer identity ────────────────────────────────────────────
#
# READ THIS BEFORE TOUCHING THE GUIDS BELOW.
#
# Inno Setup treats AppId as the identity of an installed product. If a fork
# ships upstream's AppId, the fork's installer does not install alongside VS
# Code — it is recognised as an *upgrade of* VS Code, and it will replace the
# user's real installation, inherit its uninstall entry, and in the worst case
# remove it. Four GUIDs are needed because per-machine and per-user installs are
# distinct products, and x64 and arm64 are distinct products again.
#
# These four were generated fresh for Adze with crypto.randomUUID() and must
# never be regenerated once a build has shipped: changing an AppId orphans every
# existing installation, which then cannot be upgraded or uninstalled by the new
# installer.
#
# The doubled braces are required and are not a typo. Inno Setup expands `{...}`
# as a constant, so a literal brace is written `{{`. Upstream ships the same
# escaping; stripping it produces an installer that fails at compile time.
| .win32x64AppId          = "{{C76EC0FD-AFD1-400E-951C-048A10848E7F}}"
| .win32arm64AppId        = "{{0B42E3F0-A32E-4680-AA4F-23686A4EEEE5}}"
| .win32x64UserAppId      = "{{B149EAD6-EC50-4A86-8BD3-D4DEA0319C19}}"
| .win32arm64UserAppId    = "{{1FCC2728-09F7-4CA1-BB18-24D373264AA6}}"

# Same collision argument, different mechanisms. A shared mutex name lets our
# installer believe the user's VS Code is a running instance of itself (and the
# reverse); a shared registry value name has the two products overwrite each
# other's shell integration and file associations; a shared AppUserModelId
# merges the two into one taskbar button with one jump list.
#
# `win32SetupMutexName` is set explicitly rather than left to be derived from
# `win32MutexName` by upstream's Inno template. If the template derives it, this
# key is redundant and harmless; if the derivation changes, the installer still
# does not share a mutex with VS Code. Cheap insurance against a class of bug
# that is only reproducible on a machine that has both products installed.
| .win32MutexName         = "adze"
| .win32SetupMutexName    = "adzesetup"
| .win32TunnelMutex       = "adze-tunnel"
| .win32TunnelServiceMutex = "adze-tunnelservice"
| .win32RegValueName      = "Adze"
| .win32AppUserModelId    = "Adze.Adze"
| .win32DirName           = "Adze"
| .win32NameVersion       = "Adze"
| .win32ShellNameShort    = "A&dze"

# ─── Telemetry neutralised ─────────────────────────────────────────────────
#
# "Nothing leaves the machine without explicit opt-in" is a product promise, so
# the endpoints are removed rather than disabled by a setting a later upstream
# change could re-default. Deleting the key means there is no endpoint to send
# to even if a code path we have not audited tries.
#
# This covers only the keys. The code paths are handled separately by
# 50-neutralize-telemetry.sh, because upstream also hardcodes hostnames in
# source — see that script for why it is a sweep and not a patch.
#
# `tasConfig` is the Treatment Assignment Service endpoint — upstream's
# experimentation feed. It is telemetry in both directions and was caught by the
# fixture in apps/ide/fixtures/, which is the reason that fixture exists.
| del(
    .aiConfig,
    .appCenter,
    .msftInternalDomains,
    .experimentsUrl,
    .surveys,
    .telemetryOptOutUrl,
    .sendASmileUrl,
    .tasConfig
  )
| .enableTelemetry = false

# Crash reports are telemetry with a stack trace attached. Upstream's Electron
# crash reporter needs a submit URL; with none configured it stays inert.
| del(.crashReporter)

# ─── Extension gallery ─────────────────────────────────────────────────────
#
# Open VSX, per ADR-0009. The Microsoft Marketplace Terms of Use §2(b) and §3
# prohibit use by products outside Microsoft's own, and name forks explicitly, so
# there is no hybrid arrangement to consider and no manual-VSIX workaround that
# is any more permitted than the gallery is.
#
# Open VSX implements the VS Code gallery protocol, which is the only reason this
# is a configuration change rather than a patch.
#
# The host below is a placeholder: ADR-0009 requires a self-hosted instance
# (Postgres, Elasticsearch, Redis, object storage) that has not been deployed,
# and depending on open-vsx.org directly was rejected. 30-generate-product.sh
# refuses to emit a product.json that still contains it.
| .extensionsGallery = {
    "serviceUrl":  "https://gallery.adze.example/vscode/gallery",
    "itemUrl":     "https://gallery.adze.example/vscode/item",
    "resourceUrlTemplate":
      "https://gallery.adze.example/vscode/asset/{publisher}/{name}/{version}/Microsoft.VisualStudio.Code.WebResources/{path}",
    "publisherUrl": "https://gallery.adze.example/vscode/publisher",
    "controlUrl":  "",
    "nlsBaseUrl":  ""
  }

# ─── Recommendation maps pruned ────────────────────────────────────────────
#
# Every entry in these seven maps names a Microsoft Marketplace publisher.
# Pointed at a different registry, each becomes a recommendation for a namespace
# nobody has claimed there — and anyone who claims one can then ship an update to
# users whose editor told them to install it. That is the namespace-squatting
# vector used against four commercial VS Code forks in late 2025.
#
# Emptied wholesale rather than translated entry by entry, because the safe
# default for a security-relevant map is empty. Re-adding an entry requires
# claiming the namespace on our gallery first, and
# scripts/audit-gallery-recommendations.mjs fails the build if that has not
# happened. The one entry kept below is ours, listed in
# apps/ide/branding/gallery-namespaces.json, and it exists partly so the audit
# gate has something real to resolve rather than passing because the input was
# empty.
| .extensionRecommendations = {
    "adze.adze": {
      "onFileOpen": [ { "pathGlob": "**/AGENTS.md" } ]
    }
  }
| .configBasedExtensionTips = {}
| .exeBasedExtensionTips    = {}
| .remoteExtensionTips      = {}
| .virtualWorkspaceExtensionTips = {}
| .languageExtensionTips    = []
| .keymapExtensionTips      = []
| .webExtensionTips         = []

# Upstream fetches these from the Marketplace during the build. Under ADR-0009
# that is precisely the prohibited "import", so the list is emptied and the
# build stops reaching the Marketplace at all.
#
# The honest consequence: the JavaScript debugger and the JS profile viewers are
# not present in a build produced by this pipeline. Sourcing replacements from
# Open VSX or building them from their own repositories is an open decision
# recorded in apps/ide/README.md, not something this delta silently papers over.
| .builtInExtensions = []

# ─── Update feed ───────────────────────────────────────────────────────────
#
# Repointed at a static JSON feed: no update *service* to operate, just files
# behind a CDN, which is the correct amount of infrastructure for a project with
# one maintainer. The client change that makes upstream's update service
# protocol read from static JSON is patch 0005; this key only says where.
#
# Placeholder host — see the note on the gallery above.
| .updateUrl = "https://updates.adze.example"

# ─── Links ─────────────────────────────────────────────────────────────────
#
# Anything pointing at Microsoft's documentation, privacy statement, or support
# channels is either removed or repointed. Leaving them is a licensing and
# trademark problem and sends users somewhere that cannot help them.
| .licenseName          = "Apache-2.0"
| .licenseUrl           = "https://github.com/AyanB123/adze/blob/main/LICENSE"
| .licenseFileName      = "LICENSE"
| .serverLicenseUrl     = "https://github.com/AyanB123/adze/blob/main/LICENSE"
| .serverLicenseName    = "Apache-2.0"
| .reportIssueUrl       = "https://github.com/AyanB123/adze/issues/new"
| .requestFeatureUrl    = "https://github.com/AyanB123/adze/issues/new"
| .reportMarketplaceIssueUrl = "https://github.com/AyanB123/adze/issues/new"
| .documentationUrl     = "https://github.com/AyanB123/adze#readme"
| .releaseNotesUrl      = "https://github.com/AyanB123/adze/releases"
| .privacyStatementUrl  = "https://github.com/AyanB123/adze/blob/main/SECURITY.md"
| .introductoryVideosUrl = "https://github.com/AyanB123/adze#readme"
| .tipsAndTricksUrl     = "https://github.com/AyanB123/adze#readme"
| .keyboardShortcutsUrlMac   = "https://github.com/AyanB123/adze#readme"
| .keyboardShortcutsUrlLinux = "https://github.com/AyanB123/adze#readme"
| .keyboardShortcutsUrlWin   = "https://github.com/AyanB123/adze#readme"
| del(
    .twitterUrl,
    .supportUrl,
    .newsletterSignupUrl,
    .linkProtectionTrustedDomains,
    .gettingStartedUrl,
    .youTubeUrl,
    .aiGeneratedWorkspaceTrust
  )

# ─── Upstream AI features off ─────────────────────────────────────────────
#
# Adze's agent runs behind upstream's Agent Host Protocol (ADR-0010), so
# upstream's own bundled chat provider wiring is redundant surface: a second
# agent UI competing with ours for the same panels, plus network endpoints.
#
# These keys are the configuration half. The code half is patch 0003, which is
# the more interesting problem — `contrib/inlineChat/` took 67 commits in 5.8
# months and is the one area of upstream a fork must never patch line-by-line.
| del(
    .defaultChatAgent,
    .chatParticipantRegistry,
    .gitHubEntitlement,
    .chatEntitlementUrl,
    .editSessions,
    .editSessionsStoreUrl,
    .aiEvaluationUrl
  )

# ─── Adze-specific keys ────────────────────────────────────────────────────
#
# Namespaced under one object so that no future upstream key can collide with
# ours. The TypeScript declarations that make these readable through
# IProductService are patch 0007.
| .adze = {
    "agentHostProtocolVersion": "1",
    "engineChannel": "in-process",
    "updateFeedKind": "static-json"
  }
