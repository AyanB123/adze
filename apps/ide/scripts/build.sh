#!/usr/bin/env bash
# build.sh — run the Adze IDE pipeline end to end.
#
# The numbered scripts in this directory are the pipeline. This is the ordering
# and nothing else, so that the order is a single readable list rather than
# something reconstructed from six file names.
#
#   00  preflight              host and configuration checks
#   10  fetch upstream         shallow clone at the pinned release tag
#   20  apply patches          numbered series, .patch.no skipped
#   30  generate product.json  from the jq delta, never a stored file
#   40  audit gallery          build failure on an unclaimed namespace
#   50  neutralize telemetry   ripgrep-and-rewrite over the checkout
#   60  build                  npm ci, compile once, package one target
#
# Two ordering constraints that are not obvious:
#
#   * 20 before 50. Both modify `src/`. Patches are pinned to line numbers; the
#     sweep is not, so the sweep tolerates having run after a patch and a patch
#     does not tolerate having run after the sweep.
#   * 40 after 30. The audit has to read the generated file. Auditing upstream's
#     unmodified product.json would pass on a document we do not ship.
#
# Usage:
#   bash apps/ide/scripts/build.sh [--target <target>] [--force-fetch]
#                                  [--skip-build] [--allow-placeholders]
#
# NOTE: --skip-build stops after step 50. That is the deepest this pipeline has
# ever been taken. Step 60 has never been run — see apps/ide/README.md.
set -euo pipefail

_here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../config.sh
. "${_here}/../config.sh"
# shellcheck source=./lib.sh
. "${_here}/lib.sh"

require_bash

target=''
force_fetch=0
skip_build=0
allow_placeholders=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      shift
      target="${1:-}"
      ;;
    --force-fetch) force_fetch=1 ;;
    --skip-build) skip_build=1 ;;
    --allow-placeholders) allow_placeholders=1 ;;
    -h | --help)
      sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

if [ "$skip_build" -eq 0 ] && [ -z "$target" ]; then
  die "--target is required unless --skip-build is passed. One of: win32-x64 win32-arm64 darwin-x64 darwin-arm64 linux-x64 linux-arm64"
fi

started="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

log ""
log "Adze IDE build"
log "  upstream   ${ADZE_UPSTREAM_TAG:-<unset>}"
log "  build root ${ADZE_IDE_BUILD_ROOT}"
log "  target     ${target:-<none, --skip-build>}"
log "  started    ${started}"

bash "${_here}/00-preflight.sh"

fetch_args=()
[ "$force_fetch" -eq 1 ] && fetch_args+=(--force)
bash "${_here}/10-fetch-upstream.sh" ${fetch_args+"${fetch_args[@]}"}

bash "${_here}/20-apply-patches.sh"

product_args=()
[ "$allow_placeholders" -eq 1 ] && product_args+=(--allow-placeholders)
bash "${_here}/30-generate-product.sh" ${product_args+"${product_args[@]}"}

bash "${_here}/40-audit-gallery.sh"

# The sweep needs ripgrep. Missing it is a warning at preflight rather than a
# failure, because every other step is still worth running — so the skip is
# reported loudly here instead of failing the whole pipeline.
if have rg; then
  bash "${_here}/50-neutralize-telemetry.sh"
else
  warn "skipping the telemetry sweep: ripgrep is not installed."
  warn "The product.json keys are still removed by the delta, but hardcoded"
  warn "endpoints in upstream source are NOT. Do not distribute this build."
fi

if [ "$skip_build" -eq 1 ]; then
  log ""
  step "stopped before the build (--skip-build)"
  info "The checkout at $ADZE_IDE_BUILD_ROOT is patched, branded, and swept."
  info "Inspect our entire diff with:"
  info "    git -C $ADZE_IDE_BUILD_ROOT diff adze/pristine"
  exit 0
fi

bash "${_here}/60-build.sh" --target "$target"

log ""
step "pipeline complete"
info "started  $started"
info "finished $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
info "The artifact is unsigned. Signing and notarization are not wired up."
