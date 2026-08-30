#!/usr/bin/env bash
# Single source of truth for the Adze IDE build pipeline.
#
# Sourced by every script in this directory. Sets variables, resolves paths, and
# validates nothing — validation belongs in 00-preflight.sh, which can report a
# whole list of problems instead of dying on the first one.
#
# Read docs/architecture/adr/0010-ide-fork-strategy.md before changing anything
# here. The short version: upstream is cloned at a release tag and never
# vendored, a numbered patch series is applied on top, and product.json is
# generated from a jq delta rather than stored as a merged file.
#
# shellcheck shell=bash

# ─── Upstream pin ──────────────────────────────────────────────────────────
#
# The tag lives in exactly one place: apps/ide/UPSTREAM_TAG. It is a bare file
# rather than a variable here so that the merge bot can read it without sourcing
# shell (.github/workflows/upstream-merge.yml reads it directly), and so that
# bumping upstream is a one-line diff a reviewer cannot miss.
#
# Never `main`. A release tag is the only thing upstream actually tests, and a
# moving target makes a patch-series failure impossible to bisect.

ADZE_IDE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ADZE_REPO_ROOT="$(cd -- "${ADZE_IDE_DIR}/../.." && pwd)"

ADZE_UPSTREAM_REPO="${ADZE_UPSTREAM_REPO:-https://github.com/microsoft/vscode.git}"
ADZE_UPSTREAM_TAG="$(tr -d ' \t\r\n' <"${ADZE_IDE_DIR}/UPSTREAM_TAG" 2>/dev/null || true)"

# The commit the pinned tag resolved to when it was recorded, as reported by
# `git ls-remote --tags --refs https://github.com/microsoft/vscode.git`.
#
# A tag is a mutable ref. Recording the commit alongside it means a silently
# moved or re-pointed tag surfaces as a mismatch in 10-fetch-upstream.sh instead
# of as an unexplained patch failure three steps later. Update both together.
ADZE_UPSTREAM_TAG_COMMIT="08d4889f9ec4a1685d257b9b95de036c8e1ce1e5"

# ─── Paths ─────────────────────────────────────────────────────────────────
#
# BUILD_ROOT is the upstream checkout. It is gitignored (see the root
# .gitignore) because ADR-0010 rejects a vendored merged fork outright.
#
# Override it on Windows. The Code-OSS build creates paths well over 200
# characters under node_modules, and Windows APIs that have not opted into long
# paths still cap at MAX_PATH (260). A build root of `C:/a` buys ~40 characters
# and is the difference between a build that completes and an ENAMETOOLONG that
# looks like a corrupt dependency:
#
#     ADZE_IDE_BUILD_ROOT=/c/a ./apps/ide/scripts/build.sh
ADZE_IDE_BUILD_ROOT="${ADZE_IDE_BUILD_ROOT:-${ADZE_IDE_DIR}/vscode}"

ADZE_PATCH_DIR="${ADZE_IDE_DIR}/patches"
ADZE_BRANDING_DIR="${ADZE_IDE_DIR}/branding"
ADZE_PRODUCT_DELTA="${ADZE_BRANDING_DIR}/product.delta.jq"
ADZE_GALLERY_NAMESPACES="${ADZE_BRANDING_DIR}/gallery-namespaces.json"
ADZE_FIXTURE_DIR="${ADZE_IDE_DIR}/fixtures"

# Owned by a sibling area of the repo. Wired to, never edited from here.
ADZE_GALLERY_AUDIT="${ADZE_REPO_ROOT}/scripts/audit-gallery-recommendations.mjs"

# ─── Placeholder endpoints ─────────────────────────────────────────────────
#
# product.delta.jq ships with hostnames under RFC 2606 reserved TLDs, because no
# gallery, update feed, or documentation site has been deployed for this project
# yet. Shipping a build that points its auto-updater at a hostname nobody owns
# is worse than shipping no build, so 30-generate-product.sh refuses by default
# and a maintainer opts in explicitly for a local smoke build:
#
#     ADZE_ALLOW_PLACEHOLDER_ENDPOINTS=1 ./apps/ide/scripts/build.sh
#
# This is why "no binary has been produced" is a property of the pipeline rather
# than a promise in a README.
ADZE_PLACEHOLDER_TLD_PATTERN='\.(example|invalid|test|localhost)(/|"|$)'
ADZE_ALLOW_PLACEHOLDER_ENDPOINTS="${ADZE_ALLOW_PLACEHOLDER_ENDPOINTS:-0}"

# ─── Build knobs ───────────────────────────────────────────────────────────

# Upstream's build is node-heavy; leaving this unset lets npm/gulp decide.
ADZE_BUILD_JOBS="${ADZE_BUILD_JOBS:-}"

# Nothing in this pipeline may phone home. Honoured by npm, several build
# helpers, and upstream's own telemetry shims.
export DO_NOT_TRACK=1
export npm_config_fund=false
export npm_config_audit=false
