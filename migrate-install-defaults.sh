#!/usr/bin/env bash
set -euo pipefail

DEFAULT_SERVICE_NAME="deckos"
DEFAULT_OWNER="benpaulsen4"
DEFAULT_REPO="deck-os"
DEFAULT_PORT="80"
DEFAULT_INSTALL_ROOT="/opt/deckos"
DEFAULT_DATA_DIR="/var/lib/deckos"
DEFAULT_GITHUB_API_BASE="https://api.github.com"

SERVICE_NAME="${DECKOS_SERVICE_NAME:-$DEFAULT_SERVICE_NAME}"
OWNER="$DEFAULT_OWNER"
REPO="$DEFAULT_REPO"
PORT="$DEFAULT_PORT"
INSTALL_ROOT=""
DATA_DIR=""
GITHUB_API_BASE=""
TOKEN=""
RESTART_SERVICE="1"

usage() {
  cat <<'EOF'
Usage: sudo ./migrate-install-defaults.sh [options]

Updates an existing DeckOS install to the new defaults:
- GitHub repo: benpaulsen4/deck-os
- Port: 80
- systemd low-port bind capability

Options:
  --service-name <name>   Systemd service name (default: deckos)
  --install-root <path>   DeckOS install root (defaults to current env or /opt/deckos)
  --data-dir <path>       DeckOS data dir (defaults to current env or /var/lib/deckos)
  --owner <owner>         GitHub owner to write into deckos.env
  --repo <repo>           GitHub repo to write into deckos.env
  --port <port>           Port to write into deckos.env
  --api-base <url>        GitHub API base URL
  --token <token>         GitHub token to write into deckos.env
  --no-restart            Rewrite files but do not restart the service
  --help                  Show this help
EOF
}

step() {
  echo "==> $*"
}

read_env_value() {
  local key="$1"
  local fallback="$2"
  local env_file="$3"
  if [[ -f "$env_file" ]]; then
    local line
    line="$(grep -E "^${key}=" "$env_file" | tail -n 1 || true)"
    if [[ -n "$line" ]]; then
      echo "${line#*=}"
      return 0
    fi
  fi
  echo "$fallback"
}

validate_port() {
  local value="$1"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < 1 || value > 65535 )); then
    echo "Invalid --port: ${value}" >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service-name) SERVICE_NAME="${2:-}"; shift 2;;
    --install-root) INSTALL_ROOT="${2:-}"; shift 2;;
    --data-dir) DATA_DIR="${2:-}"; shift 2;;
    --owner) OWNER="${2:-}"; shift 2;;
    --repo) REPO="${2:-}"; shift 2;;
    --port) PORT="${2:-}"; shift 2;;
    --api-base) GITHUB_API_BASE="${2:-}"; shift 2;;
    --token) TOKEN="${2:-}"; shift 2;;
    --no-restart) RESTART_SERVICE="0"; shift 1;;
    --help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (sudo)" >&2
  exit 1
fi

if [[ -z "$SERVICE_NAME" ]]; then
  echo "Service name cannot be empty" >&2
  exit 1
fi

validate_port "$PORT"

ENV_DIR="/etc/deckos"
ENV_FILE="${ENV_DIR}/deckos.env"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
BACKUP_SUFFIX=".bak.$(date +%Y%m%d%H%M%S)"

INSTALL_ROOT="${INSTALL_ROOT:-$(read_env_value "DECKOS_INSTALL_ROOT" "$DEFAULT_INSTALL_ROOT" "$ENV_FILE")}"
DATA_DIR="${DATA_DIR:-$(read_env_value "DECKOS_DATA_DIR" "$DEFAULT_DATA_DIR" "$ENV_FILE")}"
GITHUB_API_BASE="${GITHUB_API_BASE:-$(read_env_value "DECKOS_GITHUB_API_BASE" "$DEFAULT_GITHUB_API_BASE" "$ENV_FILE")}"
if [[ -z "$TOKEN" ]]; then
  TOKEN="$(read_env_value "DECKOS_GITHUB_TOKEN" "" "$ENV_FILE")"
fi

step "Preparing DeckOS runtime configuration"
install -d -m 0755 "$ENV_DIR"
if [[ -f "$ENV_FILE" ]]; then
  cp -a "$ENV_FILE" "${ENV_FILE}${BACKUP_SUFFIX}"
  step "Backed up ${ENV_FILE} to ${ENV_FILE}${BACKUP_SUFFIX}"
fi

umask 077
cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=${PORT}
DECKOS_DATA_DIR=${DATA_DIR}
DECKOS_INSTALL_ROOT=${INSTALL_ROOT}
DECKOS_GITHUB_OWNER=${OWNER}
DECKOS_GITHUB_REPO=${REPO}
DECKOS_GITHUB_API_BASE=${GITHUB_API_BASE}
EOF
if [[ -n "$TOKEN" ]]; then
  echo "DECKOS_GITHUB_TOKEN=${TOKEN}" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

step "Rewriting systemd unit ${SERVICE_NAME}.service"
if [[ -f "$UNIT_PATH" ]]; then
  cp -a "$UNIT_PATH" "${UNIT_PATH}${BACKUP_SUFFIX}"
  step "Backed up ${UNIT_PATH} to ${UNIT_PATH}${BACKUP_SUFFIX}"
fi

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=DeckOS
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
User=deckos
Group=deckos
SupplementaryGroups=docker
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
EnvironmentFile=/etc/deckos/deckos.env
WorkingDirectory=${INSTALL_ROOT}/current
ExecStartPre=+/usr/local/bin/deckos-fix-cpu-power-perms
ExecStart=/usr/local/bin/deckos-node ${INSTALL_ROOT}/current/packages/server/dist/index.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

step "Reloading systemd"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service" >/dev/null

if [[ "$RESTART_SERVICE" == "1" ]]; then
  step "Restarting ${SERVICE_NAME}.service"
  systemctl restart "${SERVICE_NAME}.service"
  systemctl status "${SERVICE_NAME}.service" --no-pager || true
else
  step "Skipping service restart"
  echo "Run: sudo systemctl restart ${SERVICE_NAME}.service"
fi

if [[ "$PORT" == "80" ]]; then
  echo "Updated DeckOS defaults. Open: http://<host>/"
else
  echo "Updated DeckOS defaults. Open: http://<host>:${PORT}/"
fi
