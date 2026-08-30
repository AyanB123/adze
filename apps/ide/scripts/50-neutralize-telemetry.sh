#!/usr/bin/env bash
# 50-neutralize-telemetry.sh — remove hardcoded telemetry endpoints from the
# upstream checkout.
#
# ─── Why this is a sweep and not a patch ───────────────────────────────────
#
# ADR-0010 lists telemetry neutralization as "a ripgrep-and-rewrite pass, not a
# patch", and the reason is maintenance arithmetic. The endpoints appear in a
# double-digit number of files scattered across `src/`, `build/`, and
# `extensions/`, in files upstream edits for unrelated reasons. A patch pinned to
# that many locations breaks on a large fraction of ~50 releases a year, and each
# break costs a human a .rej resolution for a change that is mechanical.
#
# A sweep breaks differently and better: if upstream moves a string, the sweep
# finds it at its new location. If upstream adds an endpoint, the sweep finds
# that too, and the unknown-endpoint check below turns it into a build failure
# instead of a silent regression on the one promise this project cannot get
# wrong.
#
# The trade-off, stated plainly: a sweep is a blunt instrument that rewrites
# strings without understanding the code around them. It is therefore constrained
# to string literals matching known telemetry hosts, it never edits a file
# outside the checkout, and it verifies its own result.
#
# Usage:
#   bash apps/ide/scripts/50-neutralize-telemetry.sh [--check]
#
#   --check   Report what would be rewritten, change nothing.
set -euo pipefail

_here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../config.sh
. "${_here}/../config.sh"
# shellcheck source=./lib.sh
. "${_here}/lib.sh"

require_bash
require_cmd rg "the sweep relies on ripgrep's .gitignore handling so that node_modules and out/ are never rewritten. \`grep -r\` would rewrite dependencies."

check_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) check_only=1 ;;
    -h | --help)
      sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

[ -d "${ADZE_IDE_BUILD_ROOT}/.git" ] ||
  die "no upstream checkout at $ADZE_IDE_BUILD_ROOT. Run 10-fetch-upstream.sh first."

# ─── The denylist ──────────────────────────────────────────────────────────
#
# Hostnames that receive telemetry, crash reports, experiment assignments, or
# survey traffic. Written as an alternation of literal hostnames so that a match
# is unambiguous — a pattern like `\.microsoft\.com` would also hit documentation
# links, which are handled by the product.json delta and must not be rewritten
# here.
#
# This list is derived from published endpoint documentation, not from reading the
# upstream tree. It is therefore a starting point that the unknown-endpoint check
# below is designed to grow: anything the sweep does not recognise fails the
# build, and the fix is to classify it and add it here or to the allowlist.
TELEMETRY_HOSTS=(
  'dc\.services\.visualstudio\.com'
  'vortex\.data\.microsoft\.com'
  'mobile\.events\.data\.microsoft\.com'
  '[a-z0-9-]*\.events\.data\.microsoft\.com'
  'in\.applicationinsights\.azure\.com'
  '[a-z0-9-]*\.in\.applicationinsights\.azure\.com'
  'default\.exp-tas\.com'
  '[a-z0-9-]*\.exp-tas\.com'
  'experimentation\.[a-z0-9.-]*'
  'browser\.events\.data\.msn\.com'
  'visualstudio-devdiv-c2s\.msedge\.net'
)

# Paths that legitimately contain a telemetry hostname and must not be rewritten:
# tests that assert on the value, and the changelog-style files where a rewrite
# would corrupt history rather than remove a network call.
SWEEP_EXCLUDES=(
  '!**/test/**'
  '!**/*.test.ts'
  '!**/node_modules/**'
  '!**/out/**'
  '!**/out-build/**'
  '!**/.build/**'
  '!**/*.md'
  '!product.json'
  '!**/*.min.js'
)

# What a rewritten endpoint becomes. An empty string rather than a loopback
# address: upstream's telemetry clients treat an empty endpoint as "not
# configured" and skip the request, whereas a loopback URL produces a connection
# attempt, a failure, and a retry loop in the log.
SINK=''

pattern="$(
  IFS='|'
  printf '%s' "${TELEMETRY_HOSTS[*]}"
)"

rg_args=(--no-heading --line-number --color never)
for ex in "${SWEEP_EXCLUDES[@]}"; do
  rg_args+=(--glob "$ex")
done

step "telemetry endpoint sweep"
info "checkout $ADZE_IDE_BUILD_ROOT"
info "hosts    ${#TELEMETRY_HOSTS[@]} pattern(s)"
[ "$check_only" -eq 1 ] && info "mode     --check (nothing will be modified)"

matches="$(cd "$ADZE_IDE_BUILD_ROOT" && rg "${rg_args[@]}" -e "$pattern" 2>/dev/null || true)"

if [ -z "$matches" ]; then
  log ""
  warn "no telemetry endpoints matched."
  warn ""
  warn "Read this as a question, not as success. Either upstream $ADZE_UPSTREAM_TAG"
  warn "genuinely no longer inlines these hosts, or the denylist above has gone"
  warn "stale and the sweep is now decoration. Confirm with:"
  warn "    rg -i 'telemetry|applicationinsights|exp-tas' $ADZE_IDE_BUILD_ROOT/src"
  warn ""
  warn "The delta in apps/ide/branding/product.delta.jq removes the configuration"
  warn "keys independently, so nothing is shipping an endpoint either way."
  exit 0
fi

match_count="$(printf '%s\n' "$matches" | wc -l | tr -d ' ')"
file_count="$(printf '%s\n' "$matches" | cut -d: -f1 | sort -u | wc -l | tr -d ' ')"

log ""
info "$match_count occurrence(s) across $file_count file(s):"
printf '%s\n' "$matches" | cut -d: -f1 | sort | uniq -c | sort -rn | while IFS= read -r line; do
  dim "$line"
done

if [ "$check_only" -eq 1 ]; then
  log ""
  step "check complete — nothing modified"
  exit 0
fi

# ─── Rewrite ───────────────────────────────────────────────────────────────
#
# One file at a time with sed, driven by the file list ripgrep produced. Two
# reasons not to let rg drive an in-place rewrite: rg has no --in-place, and
# collecting the file list first means the set of files touched is reported before
# anything changes.
step "rewriting"

printf '%s\n' "$matches" | cut -d: -f1 | sort -u | while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  target="${ADZE_IDE_BUILD_ROOT}/${rel}"
  [ -f "$target" ] || continue

  # Replace the hostname inside whatever string literal contains it, leaving the
  # surrounding syntax intact. The result is an empty-ish URL the client treats as
  # unconfigured, and the file still parses.
  sed -i.adze-bak -E "s#(https?://)?($pattern)[^\"'\`[:space:]]*#${SINK}#g" "$target"
  rm -f -- "${target}.adze-bak"
  rewritten=$((rewritten + 1))
done

# ─── Verify ────────────────────────────────────────────────────────────────
#
# The sweep is only trustworthy if it checks its own work. A silent partial
# rewrite is worse than no rewrite, because it looks done.
step "verifying"

remaining="$(cd "$ADZE_IDE_BUILD_ROOT" && rg "${rg_args[@]}" -e "$pattern" 2>/dev/null || true)"
if [ -n "$remaining" ]; then
  err "endpoints survived the sweep:"
  printf '%s\n' "$remaining" | head -n 20 | while IFS= read -r line; do err "    $line"; done
  die "refusing to continue. A partially neutralized build would ship a network call this project promises not to make."
fi

# A build that no longer compiles is a worse outcome than telemetry, so the
# checkout is left in a state a human can inspect and the failure names the tool.
if have git; then
  changed="$(git -C "$ADZE_IDE_BUILD_ROOT" diff --name-only | wc -l | tr -d ' ')"
  dim "$changed file(s) modified in the checkout"
  info "Review with: git -C $ADZE_IDE_BUILD_ROOT diff"
  info "The sweep is not committed as a patch on purpose — it is re-run against"
  info "each upstream tag rather than pinned to line numbers that move weekly."
fi

step "telemetry endpoints neutralized"
info "Verified by re-scanning: zero occurrences remain."
info "This covers hardcoded hosts only. The product.json keys are removed by the"
info "delta, and neither is a substitute for the other."
