#!/usr/bin/env bash
set -euo pipefail

OWNER="${DECKOS_GITHUB_OWNER:-benpaulsen4}"
REPO="${DECKOS_GITHUB_REPO:-deck-os}"
TOKEN="${DECKOS_GITHUB_TOKEN:-}"
REQUESTED_VERSION="${DECKOS_VERSION:-latest}"
INSTALL_ROOT="${DECKOS_INSTALL_ROOT:-/opt/deckos}"
DATA_DIR="${DECKOS_DATA_DIR:-/var/lib/deckos}"
PORT="${PORT:-80}"
SERVICE_NAME="${DECKOS_SERVICE_NAME:-deckos}"
DEBUG="${DECKOS_INSTALL_DEBUG:-0}"
GITHUB_API_BASE="${DECKOS_GITHUB_API_BASE:-https://api.github.com}"

step() {
  echo "==> $*"
}

debug() {
  if [[ "$DEBUG" == "1" ]]; then
    echo "DEBUG: $*"
  fi
}

is_auth_retry_status() {
  case "$1" in
    401|403|404) return 0;;
    *) return 1;;
  esac
}

github_api_error_hint() {
  local status="$1"
  if ! is_auth_retry_status "$status"; then
    return 0
  fi

  if [[ -n "$TOKEN" ]]; then
    echo " Check repository visibility and GitHub token configuration."
  else
    echo " A GitHub token may still be required while releases remain private."
  fi
}

github_fetch_to_file() {
  local accept="$1"
  local url="$2"
  local dest="$3"
  local tmp status
  tmp="$(mktemp "${DOWNLOAD_TMP_DIR}/github-fetch.XXXXXX")"

  if ! status="$(
    curl -sS -L \
      -H "User-Agent: deckos-installer" \
      -H "Accept: ${accept}" \
      -o "$tmp" \
      -w "%{http_code}" \
      "$url"
  )"; then
    rm -f "$tmp"
    echo "Failed to contact GitHub: ${url}" >&2
    exit 1
  fi

  if [[ ! "$status" =~ ^2 ]] && [[ -n "$TOKEN" ]] && is_auth_retry_status "$status"; then
    debug "Retrying GitHub request with token after HTTP ${status}: ${url}"
    if ! status="$(
      curl -sS -L \
        -H "User-Agent: deckos-installer" \
        -H "Accept: ${accept}" \
        -H "Authorization: Bearer ${TOKEN}" \
        -o "$tmp" \
        -w "%{http_code}" \
        "$url"
    )"; then
      rm -f "$tmp"
      echo "Failed to contact GitHub with token: ${url}" >&2
      exit 1
    fi
  fi

  if [[ ! "$status" =~ ^2 ]]; then
    local detail
    detail="$(<"$tmp")"
    detail="${detail//$'\r'/}"
    detail="${detail:0:600}"
    rm -f "$tmp"
    echo "GitHub API error ${status}: ${detail:-Request failed}$(github_api_error_hint "$status")" >&2
    exit 1
  fi

  mv "$tmp" "$dest"
}

github_fetch_json() {
  local url="$1"
  local tmp
  tmp="$(mktemp "${DOWNLOAD_TMP_DIR}/github-json.XXXXXX")"
  github_fetch_to_file "application/vnd.github+json" "$url" "$tmp"
  cat "$tmp"
  rm -f "$tmp"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner) OWNER="${2:-}"; shift 2;;
    --repo) REPO="${2:-}"; shift 2;;
    --token) TOKEN="${2:-}"; shift 2;;
    --version) REQUESTED_VERSION="${2:-}"; shift 2;;
    --install-root) INSTALL_ROOT="${2:-}"; shift 2;;
    --data-dir) DATA_DIR="${2:-}"; shift 2;;
    --port) PORT="${2:-}"; shift 2;;
    --service-name) SERVICE_NAME="${2:-}"; shift 2;;
    *) echo "Unknown arg: $1" >&2; exit 1;;
  esac
done

OWNER="${OWNER//$'\r'/}"
REPO="${REPO//$'\r'/}"
TOKEN="${TOKEN//$'\r'/}"

OWNER="$(echo -n "$OWNER" | xargs)"
REPO="$(echo -n "$REPO" | xargs)"
TOKEN="$(echo -n "$TOKEN" | tr -d ' \t\n\r')"
REQUESTED_VERSION="$(echo -n "$REQUESTED_VERSION" | xargs)"

if [[ -z "$OWNER" || -z "$REPO" ]]; then
  echo "Missing required repository information. Set --owner/--repo or DECKOS_GITHUB_OWNER/DECKOS_GITHUB_REPO." >&2
  exit 1
fi

if [[ ! "$OWNER" =~ ^[A-Za-z0-9_.-]+$ || ! "$REPO" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "Invalid --owner/--repo. Expected GitHub owner/repo names (no spaces)." >&2
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (sudo)" >&2
  exit 1
fi

if [[ ! -f /etc/os-release ]]; then
  echo "Unsupported distro (missing /etc/os-release)" >&2
  exit 1
fi

source /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  echo "Unsupported distro: ${ID:-unknown} ${VERSION_ID:-unknown} (only Ubuntu supported)" >&2
  exit 1
fi

if [[ "${VERSION_ID:-}" != "24.04" && "${VERSION_ID:-}" != "25.10" ]]; then
  echo "Unsupported Ubuntu version: ${VERSION_ID:-unknown} (supported: 24.04, 25.10)" >&2
  exit 1
fi

if [[ "$REQUESTED_VERSION" != "latest" && ! "$REQUESTED_VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid --version: ${REQUESTED_VERSION} (use 'latest' or a semver like 0.1.0 / v0.1.0)" >&2
  exit 1
fi

apt-get update -y
apt-get install -y ca-certificates curl gnupg lsb-release jq tar xz-utils bash sudo

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

if ! getent group docker >/dev/null 2>&1; then
  groupadd docker
fi

if ! id -u deckos >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin deckos
fi

usermod -aG docker deckos

step "Configuring sudoers for host power actions"
cat > /etc/sudoers.d/deckos-power <<'EOF'
deckos ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff
deckos ALL=(root) NOPASSWD: /usr/bin/systemctl reboot
deckos ALL=(root) NOPASSWD: /usr/sbin/shutdown -h now
deckos ALL=(root) NOPASSWD: /usr/sbin/shutdown -r now
deckos ALL=(root) NOPASSWD: /usr/sbin/poweroff
deckos ALL=(root) NOPASSWD: /usr/sbin/reboot
deckos ALL=(root) NOPASSWD: /sbin/poweroff
deckos ALL=(root) NOPASSWD: /sbin/reboot
EOF
chmod 0440 /etc/sudoers.d/deckos-power

if [[ ! -s /home/deckos/.nvm/nvm.sh ]]; then
  step "Installing NVM (latest release)"
  NVM_TAG="$(curl -fsSL https://api.github.com/repos/nvm-sh/nvm/releases/latest | jq -r '.tag_name' 2>/dev/null || true)"
  if [[ -z "${NVM_TAG}" || "${NVM_TAG}" == "null" ]]; then
    NVM_TAG="v0.39.7"
  fi
  debug "NVM tag: ${NVM_TAG}"
  su - deckos -s /bin/bash -c "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_TAG}/install.sh | bash"
fi

step "Installing Node.js 24 for deckos via NVM"
su - deckos -s /bin/bash -c "export NVM_DIR=\"\$HOME/.nvm\"; . \"\$NVM_DIR/nvm.sh\"; nvm install 24; nvm alias default 24"

cat > /usr/local/bin/deckos-node <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export NVM_DIR="/home/deckos/.nvm"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  . "$NVM_DIR/nvm.sh"
fi
exec node "$@"
EOF
chmod 0755 /usr/local/bin/deckos-node

cat > /usr/local/bin/deckos-fix-cpu-power-perms <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
apply_group_read() {
  local target="$1"
  [[ -r "$target" ]] || return 0
  chgrp deckos "$target" 2>/dev/null || true
  chmod g+r "$target" 2>/dev/null || true
}

for file in \
  /sys/class/powercap/*/energy_uj \
  /sys/class/powercap/*/max_energy_range_uj \
  /sys/class/powercap/*/*/energy_uj \
  /sys/class/powercap/*/*/max_energy_range_uj \
  /sys/class/hwmon/hwmon*/power1_average \
  /sys/class/hwmon/hwmon*/power1_input \
  /sys/class/hwmon/hwmon*/name \
  /sys/devices/platform/zenpower.0/hwmon/hwmon*/power1_average \
  /sys/devices/platform/zenpower.0/hwmon/hwmon*/power1_input \
  /sys/devices/platform/zenpower.0/hwmon/hwmon*/name; do
  apply_group_read "$file"
done
EOF
chmod 0755 /usr/local/bin/deckos-fix-cpu-power-perms

install -d -m 0755 "${INSTALL_ROOT}/releases"
chown -R deckos:deckos "${INSTALL_ROOT}"
install -d -m 0755 "${DATA_DIR}"
chown -R deckos:deckos "${DATA_DIR}"
DOWNLOAD_TMP_DIR="$(mktemp -d /tmp/deckos-install.XXXXXX)"
cleanup_download_tmp() {
  rm -rf "${DOWNLOAD_TMP_DIR}"
}
trap cleanup_download_tmp EXIT

install -d -m 0755 /etc/deckos
ENV_FILE="/etc/deckos/deckos.env"
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

step "Fetching release metadata from GitHub"
API="${GITHUB_API_BASE%/}/repos/${OWNER}/${REPO}"

if [[ "$REQUESTED_VERSION" == "latest" ]]; then
  RELEASE_URL="${API}/releases/latest"
else
  TAG="v${REQUESTED_VERSION#v}"
  RELEASE_URL="${API}/releases/tags/${TAG}"
fi

step "GET ${RELEASE_URL}"
debug "GET (shell-escaped) $(printf '%q' "$RELEASE_URL")"
RELEASE_JSON="$(github_fetch_json "${RELEASE_URL}")"

TAG_NAME="$(echo "$RELEASE_JSON" | jq -r '.tag_name')"
VER="${TAG_NAME#v}"
ASSET_ID="$(echo "$RELEASE_JSON" | jq -r '.assets[] | select(.name|endswith(".tar.gz")) | select(.name|contains("linux-x64")) | .id' | head -n 1)"
if [[ -z "$ASSET_ID" || "$ASSET_ID" == "null" ]]; then
  ASSET_ID="$(echo "$RELEASE_JSON" | jq -r '.assets[] | select(.name|endswith(".tar.gz")) | .id' | head -n 1)"
fi
if [[ -z "$ASSET_ID" || "$ASSET_ID" == "null" ]]; then
  echo "No .tar.gz asset found on release ${TAG_NAME}" >&2
  exit 1
fi

TAR_PATH="${DOWNLOAD_TMP_DIR}/deckos-${VER}.tar.gz"
ASSET_URL="${API}/releases/assets/${ASSET_ID}"
step "Downloading release asset"
step "GET ${ASSET_URL}"
debug "GET (shell-escaped) $(printf '%q' "$ASSET_URL")"
github_fetch_to_file "application/octet-stream" "${ASSET_URL}" "$TAR_PATH"

TARGET_DIR="${INSTALL_ROOT}/releases/${VER}"
rm -rf "${TARGET_DIR}.tmp"
mkdir -p "${TARGET_DIR}.tmp"
step "Extracting release to ${TARGET_DIR}"
step "Validating downloaded archive"
if ! gzip -t "$TAR_PATH" >/dev/null 2>&1; then
  FILE_SIZE="$(stat -c%s "$TAR_PATH" 2>/dev/null || echo "unknown")"
  echo "Downloaded asset is not a valid .tar.gz (size: ${FILE_SIZE})." >&2
  echo "This usually means the GitHub API returned JSON/HTML instead of the tarball (auth/permissions or wrong asset)." >&2
  if [[ "$DEBUG" == "1" ]]; then
    echo "DEBUG: First bytes (printable):" >&2
    head -c 600 "$TAR_PATH" | tr -cd '\11\12\15\40-\176' >&2 || true
    echo >&2
  fi
  exit 1
fi
tar -xzf "$TAR_PATH" -C "${TARGET_DIR}.tmp" --strip-components=1
test -f "${TARGET_DIR}.tmp/packages/server/dist/index.js"
rm -rf "$TARGET_DIR"
mv "${TARGET_DIR}.tmp" "$TARGET_DIR"
ln -sfn "$TARGET_DIR" "${INSTALL_ROOT}/current"
chown -R deckos:deckos "$TARGET_DIR"

step "Installing systemd service ${SERVICE_NAME}"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
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

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"
systemctl status "${SERVICE_NAME}.service" --no-pager || true

if [[ "$PORT" == "80" ]]; then
  echo "Installed DeckOS ${VER} to ${INSTALL_ROOT}. Open: http://<host>/"
else
  echo "Installed DeckOS ${VER} to ${INSTALL_ROOT}. Open: http://<host>:${PORT}/"
fi
