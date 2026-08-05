#!/usr/bin/env bash
set -euo pipefail

# Fails when the systemd [Service] hardening directives in install.sh and
# migrate-install-defaults.sh drift apart.
#
# The two scripts carry duplicate unit templates. The comments in both say they
# must be mirrored, but nothing enforced it, so running the migration script
# could silently downgrade the hardening an install.sh run had just applied.
#
# This compares the directives that matter rather than the whole heredoc, so
# cosmetic differences (comments, ordering of unrelated keys) do not fail the
# build while a missing or changed directive does.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_script="${repo_root}/install.sh"
migrate_script="${repo_root}/migrate-install-defaults.sh"

DIRECTIVE_PATTERN='^(Type|User|Group|SupplementaryGroups|AmbientCapabilities|CapabilityBoundingSet|NoNewPrivileges|PrivateTmp|ProtectSystem|ProtectHome|ProtectKernelTunables|ReadWritePaths|EnvironmentFile|WorkingDirectory|ExecStartPre|ExecStart|Restart|RestartSec)='

extract_directives() {
  grep -Eo "${DIRECTIVE_PATTERN}.*" "$1" | sort
}

install_directives="$(extract_directives "$install_script")"
migrate_directives="$(extract_directives "$migrate_script")"

if [[ -z "$install_directives" ]]; then
  echo "No [Service] directives found in install.sh -- has the unit template moved?" >&2
  exit 1
fi

if [[ "$install_directives" != "$migrate_directives" ]]; then
  echo "systemd unit templates have drifted between install.sh and migrate-install-defaults.sh." >&2
  echo "" >&2
  diff <(printf '%s\n' "$install_directives") <(printf '%s\n' "$migrate_directives") \
    --label install.sh --label migrate-install-defaults.sh -u >&2 || true
  echo "" >&2
  echo "Both scripts write the same unit. Mirror the change into the other one." >&2
  exit 1
fi

directive_count="$(printf '%s\n' "$install_directives" | grep -c .)"
echo "systemd unit templates are in sync (${directive_count} directives)."
