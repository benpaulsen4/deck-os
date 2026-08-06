#!/usr/bin/env bash
set -euo pipefail

# Fails when the systemd unit templates rely on ReadWritePaths= to re-open a
# path that ProtectHome= has already covered.
#
# This is not a style rule. DeckOS 0.4.4 shipped:
#
#   ProtectHome=read-only
#   ReadWritePaths=-/opt/deckos -/var/lib/deckos -/home
#
# on the stated assumption that "ReadWritePaths takes precedence over
# ProtectHome". It does not. Every write under /home failed with the file
# browser reporting a bare 500, while writes to the other two ReadWritePaths
# entries succeeded -- because those two are not covered by ProtectHome and
# were never read-only to begin with.
#
# systemd.exec(5) documents ReadWritePaths= as a way to exclude directories
# from ProtectSystem=, and says nothing of the sort for ProtectHome=. The
# asymmetry is easy to miss, reads as a harmless belt-and-braces line, and
# cannot be caught by shellcheck or by a unit-file parser -- it only shows up
# on a booted host. Hence a static check.
#
# If a future unit genuinely needs a writable path under one of these trees,
# the answer is ProtectHome=tmpfs plus an explicit BindPaths=, not another
# ReadWritePaths= entry.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Paths ProtectHome= governs, per systemd.exec(5).
PROTECT_HOME_TREES=(/home /root /run/user)

failed=0

check_script() {
  local script_path="$1"
  local script_name
  script_name="$(basename "$script_path")"

  local protect_home
  protect_home="$(grep -Eo '^ProtectHome=.*' "$script_path" | head -n 1 || true)"

  if [[ -z "$protect_home" ]]; then
    echo "  ${script_name}: no ProtectHome= directive, nothing to check"
    return
  fi

  local protect_home_value="${protect_home#ProtectHome=}"
  if [[ "$protect_home_value" == "no" || "$protect_home_value" == "false" ]]; then
    echo "  ${script_name}: ProtectHome=${protect_home_value}, nothing to check"
    return
  fi

  local read_write_paths
  read_write_paths="$(grep -Eo '^ReadWritePaths=.*' "$script_path" | head -n 1 || true)"
  if [[ -z "$read_write_paths" ]]; then
    echo "  ${script_name}: ProtectHome=${protect_home_value}, no ReadWritePaths="
    return
  fi

  local entry
  # Word splitting is the point: ReadWritePaths= is a space-separated list.
  # shellcheck disable=SC2086
  for entry in ${read_write_paths#ReadWritePaths=}; do
    # A leading '-' only means "ignore if absent"; strip it before comparing.
    local bare_path="${entry#-}"
    local tree
    for tree in "${PROTECT_HOME_TREES[@]}"; do
      if [[ "$bare_path" == "$tree" || "$bare_path" == "$tree"/* ]]; then
        echo "" >&2
        echo "${script_name}: ReadWritePaths= entry '${entry}' is under ${tree}," >&2
        echo "which ProtectHome=${protect_home_value} has already made read-only." >&2
        echo "" >&2
        echo "ReadWritePaths= does not override ProtectHome=. systemd documents it" >&2
        echo "as an escape hatch for ProtectSystem= only. The service will start" >&2
        echo "cleanly and then fail every write under ${tree} at runtime." >&2
        echo "" >&2
        echo "Either drop ProtectHome= (and use ReadOnlyPaths= for the trees you" >&2
        echo "did want protected), or use ProtectHome=tmpfs with BindPaths=." >&2
        failed=1
      fi
    done
  done

  if [[ "$failed" -eq 0 ]]; then
    echo "  ${script_name}: ProtectHome=${protect_home_value} does not collide with ReadWritePaths="
  fi
}

echo "Checking systemd unit hardening..."
check_script "${repo_root}/install.sh"
check_script "${repo_root}/migrate-install-defaults.sh"

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

echo "systemd unit hardening is self-consistent."
