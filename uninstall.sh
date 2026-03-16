#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT="${DECKOS_INSTALL_ROOT:-/opt/deckos}"
DATA_DIR="${DECKOS_DATA_DIR:-/var/lib/deckos}"
SERVICE_NAME="${DECKOS_SERVICE_NAME:-deckos}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-root) INSTALL_ROOT="${2:-}"; shift 2;;
    --data-dir) DATA_DIR="${2:-}"; shift 2;;
    --service-name) SERVICE_NAME="${2:-}"; shift 2;;
    *) echo "Unknown arg: $1" >&2; exit 1;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (sudo)" >&2
  exit 1
fi

if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files | grep -q "^${SERVICE_NAME}\\.service"; then
    systemctl stop "${SERVICE_NAME}.service" || true
    systemctl disable "${SERVICE_NAME}.service" || true
  fi
fi

UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
rm -f "$UNIT_PATH"
rm -f /usr/local/bin/deckos-node
rm -f /usr/local/bin/deckos-fix-cpu-power-perms

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
  systemctl reset-failed || true
fi

rm -rf /etc/deckos
rm -rf "${INSTALL_ROOT}"
rm -rf "${DATA_DIR}"

if id -u deckos >/dev/null 2>&1; then
  userdel --remove deckos || true
fi

if getent group deckos >/dev/null 2>&1; then
  groupdel deckos || true
fi

echo "DeckOS removed. Node.js and Docker were not uninstalled."
