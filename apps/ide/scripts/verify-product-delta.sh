#!/usr/bin/env bash
# verify-product-delta.sh — exercise the branding delta without cloning upstream.
#
# This is the one part of the pipeline that can be verified today. It needs jq and
# node and nothing else: no 2 GB clone, no toolchain, no 40-minute compile. Run it
# in CI and before every change to product.delta.jq.
#
#   bash apps/ide/scripts/verify-product-delta.sh
#
# What it establishes:
#
#   * the delta is a syntactically valid jq program
#   * it produces a JSON object from a representative upstream-shaped input
#   * every override, deletion, and shape constraint the fork depends on holds
#   * upstream keys the delta does not mention survive — the property that makes
#     "regenerate rather than merge" correct in the first place
#   * it is idempotent, which the merge bot relies on when it re-applies the delta
#     to an already-generated file
#   * the generated document passes the ADR-0009 gallery audit
#
# What it does not establish: that the real upstream product.json has the shape
# this fixture models. Only a clone can show that. The fixture is honest about
# being a stand-in — see apps/ide/fixtures/product.upstream.json.
set -euo pipefail

_here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../config.sh
. "${_here}/../config.sh"
# shellcheck source=./lib.sh
. "${_here}/lib.sh"

require_bash
require_cmd jq
require_cmd node

fixture="${ADZE_FIXTURE_DIR}/product.upstream.json"
[ -f "$fixture" ] || die "missing fixture: $fixture"
[ -f "$ADZE_PRODUCT_DELTA" ] || die "missing delta: $ADZE_PRODUCT_DELTA"

pass=0
fail=0

check() {
  local label="$1" filter="$2"
  if printf '%s' "$out" | jq -e "$filter" >/dev/null 2>&1; then
    printf '  ok    %s\n' "$label" >&2
    pass=$((pass + 1))
  else
    printf '  FAIL  %s\n' "$label" >&2
    fail=$((fail + 1))
  fi
}

step "verifying the product.json delta"
info "delta   ${ADZE_PRODUCT_DELTA#"${ADZE_REPO_ROOT}/"}"
info "fixture ${fixture#"${ADZE_REPO_ROOT}/"}"

# ─── 1. The program parses ─────────────────────────────────────────────────
#
# Against null input. A syntax error fails here rather than in the middle of a
# build, and this is also what a pre-commit hook should run.
log ""
info "1. jq program parses"
if jq -n -f "$ADZE_PRODUCT_DELTA" >/dev/null 2>&1; then
  printf '  ok    parses and evaluates against null input\n' >&2
  pass=$((pass + 1))
else
  printf '  FAIL  jq rejected the program:\n' >&2
  jq -n -f "$ADZE_PRODUCT_DELTA" 2>&1 | sed 's/^/        /' >&2 || true
  die "the delta is not a valid jq program."
fi

# ─── 2. Applied to the fixture ─────────────────────────────────────────────

log ""
info "2. applied to an upstream-shaped fixture"
out="$(jq -S -f "$ADZE_PRODUCT_DELTA" "$fixture")" || die "the delta failed against the fixture."

check "output is a JSON object" 'type == "object"'

log ""
info "   identity"
check "nameShort is Adze" '.nameShort == "Adze"'
check "applicationName does not collide with VS Code" '.applicationName == "adze"'
check "dataFolderName does not collide with VS Code" '.dataFolderName == ".adze"'
check "urlProtocol is ours" '.urlProtocol == "adze"'
check "darwinBundleIdentifier is under a domain we control" \
  '.darwinBundleIdentifier == "io.github.ayanb123.adze"'
check "linuxIconName is ours" '.linuxIconName == "adze"'

log ""
info "   win32 installer identity"
check "all four AppIds present" \
  'has("win32x64AppId") and has("win32arm64AppId")
   and has("win32x64UserAppId") and has("win32arm64UserAppId")'
check "the four AppIds are distinct" \
  '[.win32x64AppId, .win32arm64AppId, .win32x64UserAppId, .win32arm64UserAppId]
   | (unique | length) == 4'
check "Inno Setup doubled-brace escaping is preserved" \
  '[.win32x64AppId, .win32arm64AppId, .win32x64UserAppId, .win32arm64UserAppId]
   | all(test("^\\{\\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\\}\\}$"))'
# The fixture carries upstream's published Code-OSS AppIds precisely so that this
# comparison is against real values rather than against a placeholder.
check "no AppId survives from the input" \
  '. as $o
   | [$o.win32x64AppId, $o.win32arm64AppId, $o.win32x64UserAppId, $o.win32arm64UserAppId] as $ours
   | ["{{EA457B21-F73E-494C-ACAB-524FDE069978}}",
      "{{D1ACE434-89C5-48D1-88D3-E2991DF85475}}",
      "{{771FD6B0-FA20-440A-A002-3B3BAC16DC50}}",
      "{{D9E514E7-1A56-452D-9337-2990C0DC4310}}"]
   | all(. as $up | $ours | index($up) == null)'
check "mutex, registry, and AppUserModelId differ from upstream" \
  '.win32MutexName == "adze" and .win32RegValueName == "Adze"
   and (.win32AppUserModelId | startswith("Microsoft.") | not)'
check "win32SetupMutexName is set explicitly" '.win32SetupMutexName == "adzesetup"'

log ""
info "   telemetry"
check "aiConfig removed" 'has("aiConfig") == false'
check "appCenter removed" 'has("appCenter") == false'
check "msftInternalDomains removed" 'has("msftInternalDomains") == false'
check "experimentsUrl removed" 'has("experimentsUrl") == false'
check "tasConfig removed" 'has("tasConfig") == false'
check "crashReporter removed" 'has("crashReporter") == false'
check "enableTelemetry is false" '.enableTelemetry == false'

log ""
info "   gallery"
check "serviceUrl is not the Microsoft Marketplace" \
  '.extensionsGallery.serviceUrl | test("marketplace\\.visualstudio\\.com") | not'
check "resourceUrlTemplate is present" \
  '.extensionsGallery.resourceUrlTemplate | type == "string" and (. | length > 0)'
check "builtInExtensions no longer fetches from the Marketplace" '.builtInExtensions == []'

log ""
info "   recommendation maps pruned, shapes kept"
check "extensionRecommendations holds only our own publisher" \
  '.extensionRecommendations | keys == ["adze.adze"]'
check "configBasedExtensionTips is an empty object" \
  '.configBasedExtensionTips == {} and (.configBasedExtensionTips | type == "object")'
check "exeBasedExtensionTips is an empty object" '.exeBasedExtensionTips == {}'
check "remoteExtensionTips is an empty object" '.remoteExtensionTips == {}'
check "languageExtensionTips is an empty array" \
  '.languageExtensionTips == [] and (.languageExtensionTips | type == "array")'
check "keymapExtensionTips is an empty array" '.keymapExtensionTips == []'
check "webExtensionTips is an empty array" '.webExtensionTips == []'
check "no Marketplace publisher id survives anywhere in the maps" \
  '[.extensionRecommendations, .configBasedExtensionTips, .exeBasedExtensionTips,
    .remoteExtensionTips, .languageExtensionTips, .keymapExtensionTips,
    .webExtensionTips, .virtualWorkspaceExtensionTips]
   | tostring | test("ms-python|ms-dotnettools|ms-vscode|github\\.") | not'

log ""
info "   upstream keys we do not mention survive"
# This is the property the whole strategy rests on. If a regenerated product.json
# dropped upstream's additions, "regenerate rather than merge" would be silently
# lossy and the merge would have been the safer choice after all.
check "commit preserved" '.commit == "0000000000000000000000000000000000000000"'
check "date preserved" '.date == "2026-01-01T00:00:00.000Z"'
check "checksums preserved" '.checksums | type == "object"'
check "extensionAllowedProposedApi preserved" \
  '.extensionAllowedProposedApi == ["ms-vscode.vscode-js-profile-flame"]'
check "extensionKind preserved" '.extensionKind | type == "object"'

log ""
info "   Adze-specific keys namespaced"
check "adze key is an object" '.adze | type == "object"'
check "agent runs behind the Agent Host Protocol" '.adze.agentHostProtocolVersion == "1"'

# ─── 3. Idempotence ────────────────────────────────────────────────────────
#
# The merge bot regenerates product.json on a branch where it may already have
# been generated. If the delta were not idempotent, the second application would
# drift and the drift would be invisible in review.
log ""
info "3. idempotent"
twice="$(printf '%s' "$out" | jq -S -f "$ADZE_PRODUCT_DELTA")"
if [ "$out" = "$twice" ]; then
  printf '  ok    applying the delta twice equals applying it once\n' >&2
  pass=$((pass + 1))
else
  printf '  FAIL  the delta is not idempotent:\n' >&2
  diff <(printf '%s\n' "$out") <(printf '%s\n' "$twice") | head -n 20 | sed 's/^/        /' >&2 || true
  fail=$((fail + 1))
fi

# ─── 4. The gallery audit accepts the output ───────────────────────────────
#
# The generated document is fed to the real gate from ADR-0009, not to a copy of
# its logic. If pruning and the claimed-namespace manifest ever disagree, this is
# where it shows up.
log ""
info "4. ADR-0009 gallery audit accepts the generated document"
tmp_product="$(mktemp)"
trap 'rm -f -- "$tmp_product"' EXIT
printf '%s\n' "$out" >"$tmp_product"

if node "$ADZE_GALLERY_AUDIT" --product "$tmp_product" --namespaces "$ADZE_GALLERY_NAMESPACES" >/dev/null 2>&1; then
  printf '  ok    every recommended namespace is claimed\n' >&2
  pass=$((pass + 1))
else
  printf '  FAIL  the audit rejected the generated product.json:\n' >&2
  node "$ADZE_GALLERY_AUDIT" --product "$tmp_product" --namespaces "$ADZE_GALLERY_NAMESPACES" 2>&1 |
    sed 's/^/        /' >&2 || true
  fail=$((fail + 1))
fi

# ─── 5. Placeholder endpoints are still detectable ─────────────────────────
#
# 30-generate-product.sh refuses to write a product.json containing a reserved-TLD
# endpoint. That refusal is what makes "no distributable binary exists" structural
# rather than a promise, so it needs a test of its own: if the detector stopped
# matching, the guard would silently stop guarding.
log ""
info "5. placeholder endpoints are detected"
placeholder_count="$(printf '%s' "$out" |
  jq '[paths(type == "string") as $p | getpath($p)]
      | map(select(test("://[^/\"]*\\.(example|invalid|test|localhost)(/|$)")))
      | length')"

if [ "$placeholder_count" -gt 0 ]; then
  printf '  ok    %s placeholder endpoint(s) found, so the build gate will refuse\n' "$placeholder_count" >&2
  pass=$((pass + 1))
else
  printf '  FAIL  no placeholder endpoints found.\n' >&2
  printf '        Either real endpoints have been configured (in which case delete\n' >&2
  printf '        this check and the guard in 30-generate-product.sh), or the\n' >&2
  printf '        detector has stopped matching and the guard is now decoration.\n' >&2
  fail=$((fail + 1))
fi

# ─── Verdict ───────────────────────────────────────────────────────────────

log ""
if [ "$fail" -gt 0 ]; then
  die "$fail check(s) failed, $pass passed."
fi

step "$pass checks passed"
info "Verified without cloning upstream. What remains unverifiable here: whether"
info "the real product.json for $ADZE_UPSTREAM_TAG matches the fixture's shape."
