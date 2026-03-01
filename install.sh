#!/usr/bin/env bash
set -euo pipefail

OWNER="${DECKOS_GITHUB_OWNER:-}"
REPO="${DECKOS_GITHUB_REPO:-}"
TOKEN="${DECKOS_GITHUB_TOKEN:-}"
VERSION="${DECKOS_VERSION:-latest}"
INSTALL_ROOT="${DECKOS_INSTALL_ROOT:-/opt/deckos}"
DATA_DIR="${DECKOS_DATA_DIR:-/var/lib/deckos}"
PORT="${PORT:-3000}"
SERVICE_NAME="${DECKOS_SERVICE_NAME:-deckos}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner) OWNER="${2:-}"; shift 2;;
    --repo) REPO="${2:-}"; shift 2;;
    --token) TOKEN="${2:-}"; shift 2;;
    --version) VERSION="${2:-}"; shift 2;;
    --install-root) INSTALL_ROOT="${2:-}"; shift 2;;
    --data-dir) DATA_DIR="${2:-}"; shift 2;;
    --port) PORT="${2:-}"; shift 2;;
    --service-name) SERVICE_NAME="${2:-}"; shift 2;;
    *) echo "Unknown arg: $1" >&2; exit 1;;
  esac
done

if [[ -z "$OWNER" || -z "$REPO" || -z "$TOKEN" ]]; then
  echo "Missing required: --owner, --repo, --token (or DECKOS_GITHUB_OWNER/REPO/TOKEN env vars)" >&2
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

apt-get update -y
apt-get install -y ca-certificates curl gnupg lsb-release jq tar xz-utils bash

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

if [[ ! -s /home/deckos/.nvm/nvm.sh ]]; then
  NVM_TAG="$(curl -fsSL https://api.github.com/repos/nvm-sh/nvm/releases/latest | jq -r '.tag_name' 2>/dev/null || true)"
  if [[ -z "${NVM_TAG}" || "${NVM_TAG}" == "null" ]]; then
    NVM_TAG="v0.39.7"
  fi
  su - deckos -s /bin/bash -c "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_TAG}/install.sh | bash"
fi

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

install -d -m 0755 "${INSTALL_ROOT}/releases" "${INSTALL_ROOT}/tmp"
chown -R deckos:deckos "${INSTALL_ROOT}"
install -d -m 0755 "${DATA_DIR}"
chown -R deckos:deckos "${DATA_DIR}"

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
DECKOS_GITHUB_TOKEN=${TOKEN}
EOF
chmod 600 "$ENV_FILE"

API="https://api.github.com/repos/${OWNER}/${REPO}"
AUTH=(-H "Authorization: Bearer ${TOKEN}" -H "Accept: application/vnd.github+json" -H "User-Agent: deckos-installer")

if [[ "$VERSION" == "latest" ]]; then
  RELEASE_JSON="$(curl -fsSL "${AUTH[@]}" "${API}/releases/latest")"
else
  TAG="v${VERSION#v}"
  RELEASE_JSON="$(curl -fsSL "${AUTH[@]}" "${API}/releases/tags/${TAG}")"
fi

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

TAR_PATH="${INSTALL_ROOT}/tmp/deckos-${VER}.tar.gz"
curl -fL "${AUTH[@]}" -H "Accept: application/octet-stream" "${API}/releases/assets/${ASSET_ID}" -o "$TAR_PATH"

TARGET_DIR="${INSTALL_ROOT}/releases/${VER}"
rm -rf "${TARGET_DIR}.tmp"
mkdir -p "${TARGET_DIR}.tmp"
tar -xzf "$TAR_PATH" -C "${TARGET_DIR}.tmp" --strip-components=1
test -f "${TARGET_DIR}.tmp/packages/server/dist/index.js"
rm -rf "$TARGET_DIR"
mv "${TARGET_DIR}.tmp" "$TARGET_DIR"
ln -sfn "$TARGET_DIR" "${INSTALL_ROOT}/current"
chown -R deckos:deckos "$TARGET_DIR"

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
EnvironmentFile=/etc/deckos/deckos.env
WorkingDirectory=${INSTALL_ROOT}/current
ExecStart=/usr/local/bin/deckos-node ${INSTALL_ROOT}/current/packages/server/dist/index.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"
systemctl status "${SERVICE_NAME}.service" --no-pager || true

echo "Installed DeckOS ${VER} to ${INSTALL_ROOT}. Open: http://<host>:${PORT}/"
