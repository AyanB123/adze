#!/usr/bin/env bash
# 40-audit-gallery.sh — fail the build if the generated product.json recommends an
# extension whose publisher namespace we have not claimed.
#
# This is a gate, not a report. From ADR-0009:
#
#   A Code-OSS fork inherits seven recommendation maps from upstream, every entry
#   naming a Microsoft Marketplace publisher. Pointed at a different registry —
#   which the Marketplace Terms of Use require, because §2(b) and §3 prohibit fork
#   access — each becomes a recommendation for a namespace nobody has claimed on
#   the new registry. Anyone can claim one and ship an update to users whose
#   editor told them to install it. That is the exact vector used against four
#   commercial VS Code forks in late 2025.
#
# The audit logic is owned by scripts/audit-gallery-recommendations.mjs, which is
# outside this directory and is wired to rather than duplicated. This script's
# only job is to run it against the right two files and to translate a non-zero
# exit into a build failure with the context a reader needs.
#
# Usage:
#   bash apps/ide/scripts/40-audit-gallery.sh [--json]
set -euo pipefail

_here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../config.sh
. "${_here}/../config.sh"
# shellcheck source=./lib.sh
. "${_here}/lib.sh"

require_bash
require_cmd node

json=0
while [ $# -gt 0 ]; do
  case "$1" in
    --json) json=1 ;;
    -h | --help)
      sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

product="${ADZE_IDE_BUILD_ROOT}/product.json"

[ -f "$ADZE_GALLERY_AUDIT" ] || die "missing $ADZE_GALLERY_AUDIT"
[ -f "$ADZE_GALLERY_NAMESPACES" ] ||
  die "missing $ADZE_GALLERY_NAMESPACES. Without the claimed-namespace manifest there is nothing to resolve against, and assuming every namespace is claimed is the vulnerability this gate exists to close."

if [ ! -f "$product" ]; then
  die "no generated product.json at $product. Run 30-generate-product.sh first — auditing upstream's unmodified file would test the wrong document."
fi

step "auditing gallery recommendations"
info "product    $product"
info "namespaces $ADZE_GALLERY_NAMESPACES"

args=(--product "$product" --namespaces "$ADZE_GALLERY_NAMESPACES")
[ "$json" -eq 1 ] && args+=(--json)

if node "$ADZE_GALLERY_AUDIT" "${args[@]}"; then
  step "gallery audit passed"
  exit 0
fi

log ""
err "gallery audit failed — the build stops here."
err ""
err "Two possible causes, and they need different fixes:"
err ""
err "  * A recommendation names an unclaimed namespace. Either claim it on our"
err "    gallery and add it to apps/ide/branding/gallery-namespaces.json, or prune"
err "    the recommendation from apps/ide/branding/product.delta.jq. Adding a"
err "    namespace to the manifest to turn the build green without claiming it"
err "    re-opens the vulnerability this gate closes."
err ""
err "  * The gallery points at marketplace.visualstudio.com. That is prohibited"
err "    outright for forks by the Marketplace Terms of Use §2(b) and §3, and"
err "    enforced in practice — Microsoft's C/C++ extension stopped working in"
err "    forks in April 2025. See docs/architecture/adr/0009-extension-gallery.md."
exit 1
