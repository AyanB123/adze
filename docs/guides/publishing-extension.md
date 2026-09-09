# Publishing the Adze extension

How the `adze-vscode` extension reaches users through the two galleries, what
the owner must supply before that can happen, and the exact commands to run
once the prerequisites exist.

This guide follows [ADR-0009](../architecture/adr/0009-extension-gallery.md)
and closes the unpublished half of the M2 exit criterion in
[the roadmap](../roadmap.md). No new decision is recorded here.

## The gallery position in one paragraph

Publishing this extension *to* the Microsoft Marketplace is permitted. What the
Marketplace Terms of Use prohibit is *consuming* the Marketplace from a fork,
which constrains the future Adze IDE and not this package. The extension
therefore targets both galleries: the Microsoft Marketplace (for VS Code users)
and Open VSX (for Cursor, Windsurf, VSCodium, and the future IDE, which by law
can only use Open VSX). The `apps/vscode` README states the same position.

## Readiness verdict: not ready (audit of 2026-09-09)

A local `vsce package` attempt on 2026-09-09 failed before producing a VSIX.
`vsce` shells out to `npm list --production`, which cannot resolve pnpm
workspace symlinks, so it reports `ELSPROBLEMS` for every `workspace:*`
dependency. The `apps/vscode` README predicts exactly this failure and names
the fix. Nothing below is a surprise; it is the ordered fix list.

### Blocking fixes, in dependency order

1. **Add a bundler.** Wire `esbuild` or `tsup` so the VSIX ships one bundled
   file instead of `dist/`, `runtime/`, and production `node_modules`.
   `tsup` is already in the workspace catalog as a dev dependency and is the
   path of least resistance. Until this lands, `.vscodeignore` describes an
   artifact that cannot be built.
2. **Remove `"private": true` from `apps/vscode/package.json`.** Galleries
   refuse private packages. This is a one-line change that must wait until
   the bundler fix lands, otherwise the package becomes publishable in name
   but uninstallable in practice.
3. **Add a 128x128 PNG icon and declare it.** Only `media/adze.svg` exists,
   which covers the activity bar. Both gallery listings need a raster icon
   referenced by the `icon` field in `package.json` (currently absent).
4. **Add `apps/vscode/CHANGELOG.md`.** Both `vsce publish` (`--changelog-path`
   defaults to `CHANGELOG.md`) and the gallery pages render it. There is no
   changelog file anywhere in the repo today.
5. **Claim the `adze` publisher and namespace on both galleries.** See the
   credential checklist below. Until the owner claims them, any publish
   attempt fails authorization, and an unclaimed `adze` namespace on Open VSX
   is open to squatting.
6. **Decide the first published version.** `package.json` says `0.0.1`. That
   is installable, but the first public version is a statement. `0.1.0` with
   a pre-release flag is the usual shape for a first gallery release.

### Already fine, no action needed

`name`, `displayName`, `description`, `license` (Apache-2.0, matching the root
`LICENSE` that ships in the VSIX by default), `repository`, `homepage`,
`engines.vscode` (`^1.95.0`), `categories`, `keywords`, and the README itself.
`ovsx` stays out of the dependency graph on purpose: it is EPL-2.0, which repo
policy forbids, so `publish:openvsx` invokes it through `pnpm dlx` at a pinned
version. That arrangement is correct and must be preserved.

### Non-blocking polish

- Ship `.vscode/launch.json` so F5 debugging works with one key.
- Add a publish workflow under `.github/workflows/` (none exists today) once
  the secrets below are in place. Trusted publishing via OIDC is preferable
  to long-lived tokens where the gallery supports it.

## Credential checklist (the human must supply these)

The agent cannot create accounts, accept terms of service, or mint tokens. The
repo owner does all of the following, once each. No secret is ever committed
to the repo, written to disk outside the owner's own credential store, or
pasted into chat.

### 1. Open VSX token

- **What:** a Personal Access Token for the `adze` namespace with publish
  rights.
- **Who creates it:** the repo owner, signed in to `open-vsx.org` with an
  Eclipse Foundation account.
- **Where:** the account settings on `open-vsx.org`: claim the `adze`
  namespace first (an unclaimed namespace cannot be published to, and an
  unclaimed name invites squatting), then issue a token scoped to publish
  under it.
- **How it is passed:** the `OVSX_PAT` environment variable locally, or a CI
  secret of the same name. The publish command reads `--pat`, which defaults
  to that variable. The value never appears in source, logs, or the VSIX.

### 2. Visual Studio Marketplace publisher and token

- **What:** a Marketplace publisher named `adze`, plus an Azure DevOps
  Personal Access Token with the Marketplace publish scope.
- **Who creates each:** the repo owner. The publisher is created at
  `marketplace.visualstudio.com/manage` (requires a Microsoft account, which
  becomes the publisher owner). The token is created at `dev.azure.com` under
  User Settings, with organization set to all accessible organizations and
  scope set to Marketplace `Manage`.
- **How the token is passed:** the `VSCE_PAT` environment variable locally,
  or a CI secret of the same name. `vsce publish -p` defaults to that
  variable. Newer `vsce` also supports Entra ID and OIDC trusted publishing,
  which the owner may prefer over a long-lived token. As with the Open VSX
  token, the value is never committed or written into the repo.

## Publish runbook (run only after the fix list lands)

All commands run from the repo root on a clean tree with secrets exported in
the shell environment, never on the command line where they persist in shell
history files. Prefer `VSCE_PAT` and `OVSX_PAT` in the environment and omit
the flags that would carry the values.

```powershell
# 1. Build the extension and the VSIX.
pnpm --filter adze-vscode build
pnpm --filter adze-vscode package:vsix

# 2. Publish to the Visual Studio Marketplace.
pnpm --filter adze-vscode publish:marketplace

# 3. Publish the same VSIX to Open VSX.
pnpm --filter adze-vscode publish:openvsx
```

`publish:marketplace` is `vsce publish`, which reads the token from `VSCE_PAT`.
`publish:openvsx` is `pnpm dlx ovsx@1.1.1 publish adze-vscode.vsix`, which
reads the token from `OVSX_PAT`.

### Verification, every release

1. Both gallery pages list the new version under the `adze` publisher with
   the icon, README, license, and changelog rendered.
2. In a clean VS Code install, install from the Marketplace and confirm the
   Adze view activates, the version matches, and no startup error appears.
3. In a clean VSCodium, Cursor, or Windsurf install, install from Open VSX
   and repeat the same check.
4. `vsce show adze.adze-vscode` reports the expected version.

## What the agent can do once credentials exist

With the fix list landed and the two secrets present as environment variables
or CI secrets, the agent can wire the bundler, remove the `private` flag, add
the icon and changelog, add the CI publish workflow, build the VSIX, and run
the publish and verification commands end to end.

## What only the human can do

Create either account, accept either terms of service, claim the publisher or
namespace, mint or rotate either token, and decide the first public version.
Those acts require a person who owns the accounts and the legal
responsibility. The agent must never ask for a token value and must never
store one.
