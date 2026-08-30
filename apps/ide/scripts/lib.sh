#!/usr/bin/env bash
# Shared helpers for the Adze IDE build scripts.
#
# Sourced, never executed. Every script in this directory sources config.sh and
# then this file, in that order.
#
# shellcheck shell=bash

# Colour only when stderr is a terminal. CI logs and `2>&1 | tee` are the common
# cases and escape codes make both harder to read.
if [ -t 2 ]; then
  _c_red=$'\033[31m'; _c_yellow=$'\033[33m'; _c_green=$'\033[32m'
  _c_dim=$'\033[2m'; _c_reset=$'\033[0m'
else
  _c_red=''; _c_yellow=''; _c_green=''; _c_dim=''; _c_reset=''
fi

# Everything diagnostic goes to stderr so that a script whose real output is data
# (a generated product.json, a list of patches) stays pipeable.
log()  { printf '%s\n' "$*" >&2; }
step() { printf '\n%s==>%s %s\n' "$_c_green" "$_c_reset" "$*" >&2; }
info() { printf '    %s\n' "$*" >&2; }
dim()  { printf '    %s%s%s\n' "$_c_dim" "$*" "$_c_reset" >&2; }
warn() { printf '%swarn:%s %s\n' "$_c_yellow" "$_c_reset" "$*" >&2; }
err()  { printf '%serror:%s %s\n' "$_c_red" "$_c_reset" "$*" >&2; }

die() {
  err "$*"
  exit 1
}

# `command -v` rather than `which`: `which` is not POSIX, is a separate binary,
# and on some systems exits 0 for a shell builtin it cannot actually report.
have() { command -v "$1" >/dev/null 2>&1; }

require_cmd() {
  local cmd="$1" why="${2:-}"
  if ! have "$cmd"; then
    if [ -n "$why" ]; then
      die "\`$cmd\` is not on PATH. $why"
    fi
    die "\`$cmd\` is not on PATH."
  fi
}

# Absolute path with symlinks resolved where the platform can, and an honest
# fallback where it cannot. macOS ships a readlink without -f.
abspath() {
  local target="$1"
  if have realpath; then
    realpath "$target"
  elif readlink -f "$target" >/dev/null 2>&1; then
    readlink -f "$target"
  else
    printf '%s\n' "$(cd -- "$(dirname -- "$target")" && pwd)/$(basename -- "$target")"
  fi
}

# msys/cygwin bash reports Windows drive paths as /c/..., which git accepts but
# node and Electron tooling frequently do not.
is_windows_bash() {
  case "${OSTYPE:-}" in
    msys* | cygwin*) return 0 ;;
    *) return 1 ;;
  esac
}

# Guard against a script being run with `sh script.sh`, which silently disables
# every bash feature these scripts use and then fails somewhere confusing.
#
# Bash 4.4 is the floor, for one specific reason: expanding an empty array under
# `set -u` is an unbound-variable error before 4.4, and these scripts build arrays
# of patches and build targets that are legitimately empty. macOS still ships bash
# 3.2 at /bin/bash, so this check is what turns "works on Linux and CI, fails on a
# maintainer's Mac with an incomprehensible error" into one actionable line.
require_bash() {
  if [ -z "${BASH_VERSION:-}" ]; then
    printf 'error: this script requires bash. Run it as `bash %s`.\n' "$0" >&2
    exit 1
  fi
  if [ "${BASH_VERSINFO[0]}" -lt 4 ] ||
    { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -lt 4 ]; }; then
    printf 'error: bash %s is too old; 4.4 or newer is required.\n' "$BASH_VERSION" >&2
    printf '       macOS ships bash 3.2 at /bin/bash for licensing reasons.\n' >&2
    printf '       Install a current one and put it first on PATH:\n' >&2
    printf '           brew install bash\n' >&2
    exit 1
  fi
}
