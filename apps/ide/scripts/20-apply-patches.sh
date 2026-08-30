#!/usr/bin/env bash
# 20-apply-patches.sh — apply apps/ide/patches/*.patch in numbered order.
#
# Convention, mechanism, and the reasoning for both: apps/ide/patches/README.md.
# The parts that matter here:
#
#   * Numbered lexical order, always. `sort` over `NNNN-name.patch` is the order.
#   * A `.patch.no` suffix disables a patch without deleting it, so the reason it
#     was disabled stays in the file rather than in a commit message nobody
#     reads.
#   * Each applied patch becomes one commit in the checkout, so `git log
#      adze/pristine..HEAD` reads as the fork's diff and a bisect is possible.
#   * An already-applied patch is skipped, not failed. Re-running the pipeline
#     over an existing checkout has to be safe or nobody will re-run it.
#
# Usage:
#   bash apps/ide/scripts/20-apply-patches.sh [--check]
#
#   --check   Report whether every enabled patch would apply, change nothing.
#             This is what the upstream merge bot runs against a new release tag,
#             and it is the actual early-warning signal for a patch-series fork:
#             it names which patch broke, before anything is built.
set -euo pipefail

_here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../config.sh
. "${_here}/../config.sh"
# shellcheck source=./lib.sh
. "${_here}/lib.sh"

require_bash
require_cmd git

check_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) check_only=1 ;;
    -h | --help)
      sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

[ -d "${ADZE_IDE_BUILD_ROOT}/.git" ] ||
  die "no upstream checkout at $ADZE_IDE_BUILD_ROOT. Run 10-fetch-upstream.sh first."
[ -d "$ADZE_PATCH_DIR" ] || die "no patch directory at $ADZE_PATCH_DIR"

step "applying patch series"
info "series $ADZE_PATCH_DIR"
info "target $ADZE_IDE_BUILD_ROOT"
[ "$check_only" -eq 1 ] && info "mode   --check (nothing will be modified)"

# ─── Enumerate ─────────────────────────────────────────────────────────────

enabled=()
disabled=()
while IFS= read -r p; do
  [ -n "$p" ] && enabled+=("$p")
done <<EOF
$(find "$ADZE_PATCH_DIR" -maxdepth 1 -type f -name '*.patch' 2>/dev/null | sort)
EOF
while IFS= read -r p; do
  [ -n "$p" ] && disabled+=("$p")
done <<EOF
$(find "$ADZE_PATCH_DIR" -maxdepth 1 -type f -name '*.patch.no' 2>/dev/null | sort)
EOF

# Reject a numbering collision before applying anything. Two patches sharing a
# prefix have an order determined by the rest of the filename, which is a silent
# dependency on a detail nobody intended to encode.
seen_prefixes=''
for p in ${enabled[@]+"${enabled[@]}"} ${disabled[@]+"${disabled[@]}"}; do
  prefix="$(basename -- "$p" | cut -c1-4)"
  case " $seen_prefixes " in
    *" $prefix "*) die "two patches share the number $prefix. Order would be decided by the rest of the filename, which is not an order anyone chose." ;;
  esac
  seen_prefixes="$seen_prefixes $prefix"
done

if [ "${#disabled[@]}" -gt 0 ]; then
  log ""
  info "${#disabled[@]} patch(es) disabled via the .patch.no suffix:"
  for p in "${disabled[@]}"; do
    dim "$(basename -- "$p")"
  done
fi

if [ "${#enabled[@]}" -eq 0 ]; then
  log ""
  warn "no enabled patches. The checkout is pristine upstream apart from"
  warn "product.json, which 30-generate-product.sh writes."
  warn ""
  warn "This is the expected state today: every patch in the series is a"
  warn "documented placeholder with a .patch.no suffix, because writing diff"
  warn "hunks against source nobody has read produces patches that fail to"
  warn "apply. apps/ide/patches/README.md says which are which."
  exit 0
fi

# ─── Apply ─────────────────────────────────────────────────────────────────

applied=0
skipped=0
failed=()

for patch in "${enabled[@]}"; do
  name="$(basename -- "$patch")"

  if LC_ALL=C grep -qU $'\r' "$patch" 2>/dev/null; then
    err "$name contains CRLF and cannot apply."
    err "  .gitattributes marks *.patch as -text to prevent exactly this. A"
    err "  checkout made before that attribute existed keeps normalised copies:"
    err "      git rm --cached -r apps/ide/patches && git checkout -- apps/ide/patches"
    failed+=("$name (CRLF)")
    continue
  fi

  # Already applied? `git apply --reverse --check` succeeding means the tree
  # already contains the change.
  if git -C "$ADZE_IDE_BUILD_ROOT" apply --reverse --check --whitespace=nowarn "$patch" 2>/dev/null; then
    dim "$name — already applied, skipping"
    skipped=$((skipped + 1))
    continue
  fi

  if git -C "$ADZE_IDE_BUILD_ROOT" apply --check --whitespace=nowarn "$patch" 2>/dev/null; then
    if [ "$check_only" -eq 1 ]; then
      info "$name — would apply"
      applied=$((applied + 1))
      continue
    fi
    git -C "$ADZE_IDE_BUILD_ROOT" apply --whitespace=nowarn "$patch"
    git -C "$ADZE_IDE_BUILD_ROOT" add -A
    git -C "$ADZE_IDE_BUILD_ROOT" commit -q -m "adze: $name"
    info "$name — applied"
    applied=$((applied + 1))
    continue
  fi

  # Exact application failed. --3way can still succeed when the patch carries
  # index lines and the pre-image blobs exist in the clone, which is the normal
  # case for a patch generated against upstream that has since moved nearby.
  if [ "$check_only" -eq 0 ] &&
    git -C "$ADZE_IDE_BUILD_ROOT" apply --3way --whitespace=nowarn "$patch" 2>/dev/null; then
    if [ -n "$(git -C "$ADZE_IDE_BUILD_ROOT" diff --name-only --diff-filter=U)" ]; then
      err "$name — 3-way merge left conflict markers."
      git -C "$ADZE_IDE_BUILD_ROOT" diff --name-only --diff-filter=U | while IFS= read -r f; do
        err "    $f"
      done
      failed+=("$name (3-way conflict)")
      continue
    fi
    git -C "$ADZE_IDE_BUILD_ROOT" add -A
    git -C "$ADZE_IDE_BUILD_ROOT" commit -q -m "adze: $name (3-way)"
    warn "$name — applied via 3-way merge. Refresh it against $ADZE_UPSTREAM_TAG so the next release does not depend on the merge succeeding again."
    applied=$((applied + 1))
    continue
  fi

  err "$name — does not apply."
  if [ "$check_only" -eq 0 ]; then
    # --reject leaves .rej hunks for a human. That is the whole recovery path, so
    # it needs to leave evidence rather than a clean tree and an error code.
    git -C "$ADZE_IDE_BUILD_ROOT" apply --reject --whitespace=nowarn "$patch" >/dev/null 2>&1 || true
    rejects="$(cd "$ADZE_IDE_BUILD_ROOT" && find . -name '*.rej' -newer "$patch" 2>/dev/null | sed 's|^\./||' | sort || true)"
    if [ -n "$rejects" ]; then
      err "  rejected hunks written:"
      printf '%s\n' "$rejects" | while IFS= read -r r; do err "    $r"; done
      err "  Resolve them in the checkout, then regenerate the patch:"
      err "      git -C $ADZE_IDE_BUILD_ROOT diff adze/pristine -- <files> > $patch"
    fi
  fi
  failed+=("$name")
done

# ─── Report ────────────────────────────────────────────────────────────────

log ""
if [ "${#failed[@]}" -gt 0 ]; then
  err "${#failed[@]} patch(es) failed:"
  for f in "${failed[@]}"; do err "    $f"; done
  err ""
  err "A patch that stops applying is the expected cost of a weekly upstream"
  err "cadence, not a bug. Refresh it against $ADZE_UPSTREAM_TAG, or disable it"
  err "by renaming to .patch.no with a note saying why."
  exit 1
fi

step "patch series clean"
info "$applied applied, $skipped already present, ${#disabled[@]} disabled"
