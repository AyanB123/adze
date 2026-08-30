#!/usr/bin/env bash
# 60-build.sh — install upstream's dependencies and package one target.
#
# ─── This has never been run ───────────────────────────────────────────────
#
# No binary has been produced by this pipeline. The commands below are the
# documented Code-OSS build invocation, arranged compile-once-package-many, and
# they are reviewable as configuration. They are not a verified recipe, and the
# first maintainer to run them should expect to fix something — most likely a
# native module against the local toolchain. apps/ide/README.md has the ordered
# zero-to-binary checklist and the failure modes worth knowing in advance.
#
# ─── Compile once, package many ────────────────────────────────────────────
#
# `compile-build` is architecture-independent and is the expensive half. The
# per-target `vscode-<platform>-<arch>-min-ci` tasks consume its output. Running
# the full `vscode-<platform>-<arch>-min` task per target instead recompiles
# TypeScript six times for one release, which is most of a CI budget spent on an
# identical result.
#
# Usage:
#   bash apps/ide/scripts/60-build.sh --target <target> [--skip-install] [--compile-only]
#
#   --target        win32-x64 | win32-arm64 | darwin-x64 | darwin-arm64
#                   | linux-x64 | linux-arm64
#   --skip-install  Reuse an existing node_modules. Saves 10-20 minutes when
#                   iterating on a patch; wrong after an upstream bump.
#   --compile-only  Stop after the architecture-independent compile. This is the
#                   shared step in CI, uploaded once and consumed by six
#                   packaging jobs.
set -euo pipefail

_here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../config.sh
. "${_here}/../config.sh"
# shellcheck source=./lib.sh
. "${_here}/lib.sh"

require_bash

target=''
skip_install=0
compile_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      shift
      target="${1:-}"
      ;;
    --skip-install) skip_install=1 ;;
    --compile-only) compile_only=1 ;;
    -h | --help)
      sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

case "$target" in
  win32-x64 | win32-arm64 | darwin-x64 | darwin-arm64 | linux-x64 | linux-arm64) ;;
  '')
    [ "$compile_only" -eq 1 ] || die "--target is required. One of: win32-x64 win32-arm64 darwin-x64 darwin-arm64 linux-x64 linux-arm64"
    ;;
  *) die "unknown target '$target'" ;;
esac

[ -f "${ADZE_IDE_BUILD_ROOT}/package.json" ] ||
  die "no upstream checkout at $ADZE_IDE_BUILD_ROOT. Run 10-fetch-upstream.sh first."

# Building upstream's unmodified product.json would produce a binary branded as
# Microsoft's, with upstream's AppIds and upstream's gallery. Refusing is cheaper
# than discovering it after an installer has replaced someone's VS Code.
if ! jq -e '.nameShort == "Adze"' "${ADZE_IDE_BUILD_ROOT}/product.json" >/dev/null 2>&1; then
  die "product.json in the checkout is not branded. Run 30-generate-product.sh first — building upstream's file produces an installer carrying upstream's AppIds, which upgrades over the user's real VS Code."
fi

cd "$ADZE_IDE_BUILD_ROOT"

# ─── Dependencies ──────────────────────────────────────────────────────────

if [ "$skip_install" -eq 0 ]; then
  step "installing upstream dependencies"
  info "10-20 minutes, and the step most likely to fail on a fresh machine."
  info "Native modules compile here: node-gyp, a C++ toolchain, and Python 3."
  if is_windows_bash; then
    info "On Windows this needs the MSVC Spectre-mitigated libraries, which are a"
    info "separate Visual Studio Installer component. Without them the failure is a"
    info "linker error inside a transitive dependency and does not name the cause."
  fi
  npm ci --no-audit --no-fund
else
  warn "reusing existing node_modules (--skip-install)"
fi

# ─── Compile ───────────────────────────────────────────────────────────────

step "compiling (architecture-independent)"
info "20-40 minutes on first run."
npx --no-install gulp compile-build-without-mangle
npx --no-install gulp compile-extension-media
npx --no-install gulp extensions-ci

if [ "$compile_only" -eq 1 ]; then
  step "compile complete"
  info "Package a target with: bash ${BASH_SOURCE[0]#"${ADZE_REPO_ROOT}/"} --target <target> --skip-install"
  exit 0
fi

# ─── Package ───────────────────────────────────────────────────────────────

platform="${target%%-*}"
arch="${target##*-}"
gulp_task="vscode-${platform}-${arch}-min-ci"

step "packaging $target"
info "gulp task: $gulp_task"
info "Output lands beside the checkout as VSCode-${platform}-${arch}/."

if [ -n "$ADZE_BUILD_JOBS" ]; then
  export npm_config_jobs="$ADZE_BUILD_JOBS"
fi

npx --no-install gulp "$gulp_task"

step "packaged $target"
info "Unsigned and unnotarized. A distributable build additionally needs:"
info "  * Windows: Authenticode signing, then the Inno Setup installer task"
info "  * macOS: codesign with hardened runtime, then notarytool submission"
info "  * Linux: the deb/rpm tasks, and a signed repository if one is published"
info "None of that is wired up. See apps/ide/README.md."
