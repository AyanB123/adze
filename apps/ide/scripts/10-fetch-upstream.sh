#!/usr/bin/env bash
# 10-fetch-upstream.sh — put a pristine microsoft/vscode checkout at the pinned
# release tag into $ADZE_IDE_BUILD_ROOT.
#
# Three properties this has to hold, all from ADR-0010:
#
#   1. A release tag, never a branch. Upstream only tests tags, and a moving
#      target turns "the patch series broke" into an unbisectable report.
#   2. The checkout is never vendored into this repository. It is gitignored, and
#      re-fetching it must always be possible from the pin alone.
#   3. The tag's commit is verified against the value recorded in config.sh. A tag
#      is a mutable ref; without this check a re-pointed tag looks like a patch
#      failure rather than like the supply-chain event it is.
#
# Usage:
#   bash apps/ide/scripts/10-fetch-upstream.sh [--force]
#
#   --force   Remove an existing checkout instead of refusing. Destructive: any
#             local edits under the build root are lost, which is fine because
#             every intentional change lives in apps/ide/patches/.
set -euo pipefail

_here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../config.sh
. "${_here}/../config.sh"
# shellcheck source=./lib.sh
. "${_here}/lib.sh"

require_bash
require_cmd git

force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) force=1 ;;
    -h | --help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

[ -n "$ADZE_UPSTREAM_TAG" ] || die "apps/ide/UPSTREAM_TAG is empty. Run 00-preflight.sh."

step "fetching upstream $ADZE_UPSTREAM_TAG"
info "repo   $ADZE_UPSTREAM_REPO"
info "target $ADZE_IDE_BUILD_ROOT"

# ─── Verify the pin before transferring 2 GB ───────────────────────────────
#
# ls-remote is a refs-only round trip. Doing it first means a moved tag or a
# typo costs a second rather than a full clone.
remote_sha="$(git ls-remote --tags --refs "$ADZE_UPSTREAM_REPO" "refs/tags/${ADZE_UPSTREAM_TAG}" | awk '{print $1}')"

if [ -z "$remote_sha" ]; then
  err "tag '$ADZE_UPSTREAM_TAG' does not exist in $ADZE_UPSTREAM_REPO."
  err "Release tags are plain X.Y.Z. List them with:"
  err "    git ls-remote --tags --refs $ADZE_UPSTREAM_REPO | grep -E 'refs/tags/[0-9]+\\.[0-9]+\\.[0-9]+\$'"
  exit 1
fi

if [ -n "$ADZE_UPSTREAM_TAG_COMMIT" ] && [ "$remote_sha" != "$ADZE_UPSTREAM_TAG_COMMIT" ]; then
  err "tag '$ADZE_UPSTREAM_TAG' no longer points at the recorded commit."
  err "  recorded: $ADZE_UPSTREAM_TAG_COMMIT"
  err "  remote:   $remote_sha"
  err ""
  err "A release tag that moved is either an upstream re-tag or something worse."
  err "Confirm the change deliberately, then update ADZE_UPSTREAM_TAG_COMMIT in"
  err "apps/ide/config.sh in the same commit that explains why."
  exit 1
fi
dim "tag resolves to $remote_sha (matches the recorded pin)"

# ─── Prepare the destination ───────────────────────────────────────────────

if [ -e "$ADZE_IDE_BUILD_ROOT" ]; then
  if [ "$force" -eq 1 ]; then
    warn "removing existing checkout at $ADZE_IDE_BUILD_ROOT"
    rm -rf -- "$ADZE_IDE_BUILD_ROOT"
  else
    existing_tag=''
    if [ -d "${ADZE_IDE_BUILD_ROOT}/.git" ]; then
      existing_tag="$(git -C "$ADZE_IDE_BUILD_ROOT" describe --tags --exact-match 2>/dev/null || echo '')"
    fi
    if [ "$existing_tag" = "$ADZE_UPSTREAM_TAG" ]; then
      step "already at $ADZE_UPSTREAM_TAG"
      info "Reusing the existing checkout. Pass --force to re-fetch from scratch."
      info "Note that patches from a previous run are still applied; 20-apply-patches.sh"
      info "detects an already-applied patch and skips it rather than failing."
      exit 0
    fi
    die "$ADZE_IDE_BUILD_ROOT exists${existing_tag:+ at $existing_tag}, which is not $ADZE_UPSTREAM_TAG. Pass --force to replace it."
  fi
fi

mkdir -p -- "$(dirname -- "$ADZE_IDE_BUILD_ROOT")"

# ─── Clone ─────────────────────────────────────────────────────────────────
#
# --depth 1 against the tag. The full history is ~4 GB and nothing in this
# pipeline reads it: the patch series is applied with `git apply`, not rebased,
# so no merge base is ever computed here.
#
# The merge bot in .github/workflows/upstream-merge.yml is the one consumer that
# does need history, and it clones separately for that reason.
step "cloning (shallow, tag only)"
info "This is the long step: roughly 2 GB and several minutes on a fast link."

git clone \
  --depth 1 \
  --branch "$ADZE_UPSTREAM_TAG" \
  --single-branch \
  --no-tags \
  --config advice.detachedHead=false \
  -- "$ADZE_UPSTREAM_REPO" "$ADZE_IDE_BUILD_ROOT"

cloned_sha="$(git -C "$ADZE_IDE_BUILD_ROOT" rev-parse HEAD)"
if [ "$cloned_sha" != "$remote_sha" ]; then
  die "clone landed on $cloned_sha but the tag resolved to $remote_sha. Refusing to continue."
fi

# Local commits on top of the pristine tag are how 20-apply-patches.sh records
# what it applied, which makes `git log` in the checkout a readable account of
# our diff and `git diff $ADZE_UPSTREAM_TAG` the whole of it.
git -C "$ADZE_IDE_BUILD_ROOT" config user.name 'adze-build'
git -C "$ADZE_IDE_BUILD_ROOT" config user.email 'build@localhost'
git -C "$ADZE_IDE_BUILD_ROOT" config commit.gpgsign false
if is_windows_bash; then
  git -C "$ADZE_IDE_BUILD_ROOT" config core.longpaths true
  # A checkout normalised to CRLF breaks the patch series and several of
  # upstream's own build scripts.
  git -C "$ADZE_IDE_BUILD_ROOT" config core.autocrlf false
fi

git -C "$ADZE_IDE_BUILD_ROOT" tag -f 'adze/pristine' >/dev/null

step "fetched $ADZE_UPSTREAM_TAG at $cloned_sha"
info "Tagged 'adze/pristine' in the checkout. \`git diff adze/pristine\` is our entire diff."
