#!/usr/bin/env bash
#
# Fills in the systemd unit templates and installs them.
#
# The units under deploy/ carry placeholders rather than one machine's paths.
# This substitutes them and writes the result to /etc/systemd/system, which is
# the only step of a deployment that needs root.
#
# Usage:
#   sudo JARVIS_ROOT=$HOME/jarvis JARVIS_HOSTNAME=<the certificate's name> \
#     scripts/install-units.sh
#
# Nothing is enabled or started: which of these a machine should run is a
# decision, and a script that makes it silently is a script that starts a voice
# assistant on a machine somebody was only reading the source on.

set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly UNITS="${HERE}/deploy"
readonly TARGET="${TARGET_DIR:-/etc/systemd/system}"

# Defaults from whoever is being sudo'd for, so the common case needs no flags.
JARVIS_USER="${JARVIS_USER:-${SUDO_USER:-$(id -un)}}"
JARVIS_HOME="${JARVIS_HOME:-$(getent passwd "${JARVIS_USER}" | cut -d: -f6)}"
JARVIS_ROOT="${JARVIS_ROOT:-${JARVIS_HOME}/jarvis}"
JARVIS_WORKTREES="${JARVIS_WORKTREES:-${JARVIS_HOME}/jarvis-dev}"
JARVIS_HOSTNAME="${JARVIS_HOSTNAME:-}"
# The timers must all name one zone or their intended order does not hold. The
# machine's own is the right default; it is also what the brain falls back to.
JARVIS_TIMEZONE="${JARVIS_TIMEZONE:-$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)}"

if [[ -z "${JARVIS_HOME}" ]]; then
  echo "install-units: no home directory for ${JARVIS_USER}; set JARVIS_HOME" >&2
  exit 1
fi

if [[ -z "${JARVIS_HOSTNAME}" ]]; then
  echo "install-units: set JARVIS_HOSTNAME to the name the certificate is for" >&2
  exit 1
fi

mkdir -p "${TARGET}"

# The sandbox needs every path it is told to keep writable to exist already.
# `ProtectSystem=strict` plus a missing entry in `ReadWritePaths` is not a
# warning: the unit dies at 226/NAMESPACE before node is ever spawned, naming
# one directory and nothing else. On a machine that has run npm or the agent
# CLI these exist by accident, which is exactly why a fresh host is the one
# that fails. Creating them here is cheap and makes the failure impossible.
for dir in "${JARVIS_HOME}/.claude" "${JARVIS_HOME}/.cache" "${JARVIS_HOME}/.local" "${JARVIS_WORKTREES}"; do
  if [[ ! -d "${dir}" ]]; then
    install -d -o "${JARVIS_USER}" -g "${JARVIS_USER}" "${dir}"
    echo "created ${dir}"
  fi
done

for template in "${UNITS}"/jarvis-*; do
  name="$(basename "${template}")"
  sed \
    -e "s|__JARVIS_USER__|${JARVIS_USER}|g" \
    -e "s|__JARVIS_HOME__|${JARVIS_HOME}|g" \
    -e "s|__JARVIS_ROOT__|${JARVIS_ROOT}|g" \
    -e "s|__JARVIS_WORKTREES__|${JARVIS_WORKTREES}|g" \
    -e "s|__JARVIS_HOSTNAME__|${JARVIS_HOSTNAME}|g" \
    -e "s|__JARVIS_TIMEZONE__|${JARVIS_TIMEZONE}|g" \
    "${template}" > "${TARGET}/${name}"
  echo "installed ${name}"
done

echo
echo "Timers scheduled in ${JARVIS_TIMEZONE}. Set JARVIS_TIMEZONE in the service"
echo "environment to the same zone, or the brain will reason in a different one."
echo
echo "Now: systemctl daemon-reload, then enable what this machine should run."
