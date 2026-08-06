#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# DeckOS installer.
#
# This script is fetched standalone (curl | sudo bash) and runs as root, so:
#   * everything lives inside main() and main is only invoked on the very last
#     line. A truncated download therefore defines functions but executes
#     nothing, instead of running a partial install.
#   * release artifacts are verified (ed25519 signature over a SHA256SUMS
#     manifest) before anything is unpacked.
#
# ONE INSTANCE PER HOST. --service-name renames the systemd unit only. The
# configuration directory (/etc/deckos), the `deckos` service account, the
# /usr/local/bin helpers and the sudoers rule are global singletons shared by
# any unit name, so a second install overwrites the first one's configuration.
# ---------------------------------------------------------------------------

DEFAULT_OWNER="benpaulsen4"
DEFAULT_REPO="deck-os"
DEFAULT_VERSION="latest"
DEFAULT_INSTALL_ROOT="/opt/deckos"
DEFAULT_DATA_DIR="/var/lib/deckos"
DEFAULT_PORT="80"
DEFAULT_SERVICE_NAME="deckos"
DEFAULT_GITHUB_API_BASE="https://api.github.com"

ENV_DIR="/etc/deckos"
ENV_FILE="${ENV_DIR}/deckos.env"
SUDOERS_FILE="/etc/sudoers.d/deckos-power"

DEBUG="${DECKOS_INSTALL_DEBUG:-0}"

# Snapshot of the inherited PORT before main() shadows the name with a local.
ENV_PORT="${PORT:-}"

# Path to the curl config file holding the Authorization header, or "" when no
# token is configured. Defined here so github_fetch_to_file is never unbound.
CURL_AUTH_CONFIG=""

# Pinned nvm release plus the SHA256 of that tag's install.sh. Both must be
# updated together; recompute with:
#   curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/<tag>/install.sh | sha256sum
NVM_VERSION="v0.40.6"
NVM_INSTALL_SHA256="2ef7e8d4373c1ffd70daa55f919f629e98a619543ffc0a8d892d77a5247e50e4"

# Release signing. Every release ships:
#   <tarball>.tar.gz   the release archive
#   SHA256SUMS         `sha256sum` output, one line per artifact
#   SHA256SUMS.sig     raw 64-byte ed25519 signature over SHA256SUMS
#
# The public key below MUST stay byte-identical to the copy in
# packages/server/src/lib/releaseKey.ts, which the in-app updater uses.
SUMS_ASSET_NAME="SHA256SUMS"
SIG_ASSET_NAME="SHA256SUMS.sig"
DECKOS_RELEASE_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAnwysTGZxSPefWzF3LBCdUcihmBM9rVTYVmfaCp+FEcw=
-----END PUBLIC KEY-----"

readonly SUPPORTED_UBUNTU_VERSIONS=("24.04" "25.10" "26.04")

step() {
  echo "==> $*"
}

warn() {
  echo "WARNING: $*" >&2
}

die() {
  echo "$*" >&2
  exit 1
}

debug() {
  if [[ "$DEBUG" == "1" ]]; then
    echo "DEBUG: $*"
  fi
}

usage() {
  cat <<'EOF'
Usage: sudo ./install.sh [options]

Options:
  --owner <owner>          GitHub owner of the release source
  --repo <repo>            GitHub repository of the release source
  --version <ver>          "latest" or a semver such as 0.4.3 / v0.4.3
  --token-file <path>      Read the GitHub token from a file (preferred)
  --token-stdin            Read the GitHub token from standard input
  --token <token>          GitHub token on the command line (DISCOURAGED:
                           visible in `ps` and in shell history)
  --port <port>            Listen port (default: 80)
  --data-dir <path>        Persistent data directory (default: /var/lib/deckos)
  --install-root <path>    Release install root (default: /opt/deckos)
  --service-name <name>    systemd unit name (default: deckos). Renames the
                           unit only; one DeckOS instance per host is supported.
  --api-base <url>         GitHub API base URL
  --help                   Show this help

Values not supplied on the command line (or via DECKOS_* environment
variables) are reused from an existing /etc/deckos/deckos.env, so re-running
the installer to change one setting does not reset the others.
EOF
}

join_by() {
  local delimiter="$1"
  shift
  local result="${1:-}"
  shift || true
  for value in "$@"; do
    result+="${delimiter}${value}"
  done
  printf '%s' "$result"
}

array_contains() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    if [[ "$item" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

# Emits an explicit error when a flag is given without its value, instead of
# letting `shift 2` abort the script silently under `set -e`. Also rejects an
# explicitly empty value, which would otherwise pass and silently fall back to
# the env file or a default.
require_value() {
  local flag="$1"
  local remaining="$2"
  local value="${3-}"
  if (( remaining < 2 )); then
    die "Missing value for ${flag}"
  fi
  if [[ -z "$value" ]]; then
    die "${flag} was given an empty value"
  fi
}

validate_port() {
  local value="$1"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < 1 || value > 65535 )); then
    die "Invalid --port: ${value} (expected 1-65535)"
  fi
}

# Deliberately permissive: any ordinary absolute path is accepted. Only values
# that are genuinely dangerous are rejected -- empty, relative, the filesystem
# root, `..` traversal, and control characters (a newline in INSTALL_ROOT or
# DATA_DIR would inject arbitrary directives into the systemd unit heredoc).
validate_abs_path() {
  local flag="$1"
  local value="$2"
  [[ -n "$value" ]] || die "${flag} must not be empty"
  [[ "$value" == /* ]] || die "${flag} must be an absolute path: ${value}"
  [[ "$value" != "/" ]] || die "${flag} must not be the filesystem root"
  if [[ "$value" =~ [[:cntrl:]] ]]; then
    die "${flag} must not contain control characters"
  fi
  if [[ "$value" == *" "* ]]; then
    die "${flag} must not contain spaces (the systemd unit cannot express them): ${value}"
  fi
  case "$value" in
    *"/../"*|*"/..") die "${flag} must not contain '..': ${value}";;
  esac
}

validate_service_name() {
  local value="$1"
  [[ -n "$value" ]] || die "--service-name must not be empty"
  if [[ ! "$value" =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]*$ ]]; then
    die "Invalid --service-name: ${value} (expected a systemd unit name without the .service suffix)"
  fi
  if [[ "$value" == *.service ]]; then
    die "Invalid --service-name: ${value} (omit the .service suffix)"
  fi
}

# Reads a KEY=value line out of an existing deckos.env so re-running the
# installer preserves settings the caller did not pass again.
read_env_value() {
  local key="$1"
  local fallback="$2"
  local env_file="$3"
  if [[ -f "$env_file" ]]; then
    local line
    line="$(grep -E "^${key}=" "$env_file" | tail -n 1 || true)"
    if [[ -n "$line" ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  fi
  printf '%s' "$fallback"
}

read_token_from_file() {
  local path="$1"
  [[ -f "$path" ]] || die "--token-file not found: ${path}"
  [[ -r "$path" ]] || die "--token-file is not readable: ${path}"
  tr -d ' \t\r\n' < "$path"
}

# The placeholder is assembled from two halves on purpose: a blanket
# search-and-replace of the sentinel must not be able to neuter this guard.
release_key_is_placeholder() {
  local sentinel="REPLACE_WITH_DECKOS""_RELEASE_PUBLIC_KEY"
  [[ "$DECKOS_RELEASE_PUBLIC_KEY" == *"$sentinel"* ]]
}

assert_release_key_configured() {
  if release_key_is_placeholder; then
    echo "This installer has no DeckOS release signing key baked in." >&2
    echo "" >&2
    echo "Release verification cannot be skipped, so the install cannot continue." >&2
    echo "The maintainer must generate the release keypair and replace the" >&2
    echo "placeholder public key in BOTH of these places with the same PEM:" >&2
    echo "  1. install.sh                              (DECKOS_RELEASE_PUBLIC_KEY)" >&2
    echo "  2. packages/server/src/lib/releaseKey.ts   (in-app updater)" >&2
    echo "" >&2
    echo "  openssl genpkey -algorithm ed25519 -out deckos-release.key" >&2
    echo "  openssl pkey -in deckos-release.key -pubout -out deckos-release.pub" >&2
    echo "" >&2
    die "Aborting: unsigned or unverifiable releases are never installed."
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

# Writes the Authorization header into a curl config file (mode 0600) instead of
# passing it on the command line, so the token never appears in /proc/<pid>/cmdline.
setup_curl_auth_config() {
  CURL_AUTH_CONFIG=""
  [[ -n "$TOKEN" ]] || return 0
  CURL_AUTH_CONFIG="${DOWNLOAD_TMP_DIR}/curl-auth.conf"
  (
    umask 077
    printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" > "$CURL_AUTH_CONFIG"
  )
  chmod 0600 "$CURL_AUTH_CONFIG"
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

  if [[ ! "$status" =~ ^2 ]] && [[ -n "$CURL_AUTH_CONFIG" ]] && is_auth_retry_status "$status"; then
    debug "Retrying GitHub request with token after HTTP ${status}: ${url}"
    if ! status="$(
      curl -sS -L \
        --config "$CURL_AUTH_CONFIG" \
        -H "User-Agent: deckos-installer" \
        -H "Accept: ${accept}" \
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

asset_id_by_name() {
  local release_json="$1"
  local name="$2"
  printf '%s' "$release_json" |
    jq -r --arg name "$name" '.assets[] | select(.name == $name) | .id' |
    head -n 1
}

# Prefers a linux-x64 tarball, falling back to any .tar.gz. Emits "<id><TAB><name>".
select_tarball_asset() {
  local release_json="$1"
  local result
  result="$(
    printf '%s' "$release_json" |
      jq -r '.assets[] | select(.name|endswith(".tar.gz")) | select(.name|contains("linux-x64")) | "\(.id)\t\(.name)"' |
      head -n 1
  )"
  if [[ -z "$result" ]]; then
    result="$(
      printf '%s' "$release_json" |
        jq -r '.assets[] | select(.name|endswith(".tar.gz")) | "\(.id)\t\(.name)"' |
        head -n 1
    )"
  fi
  printf '%s' "$result"
}

# Extracts the digest recorded for `name` from a sha256sum manifest. Tolerates
# both text ("<hash>  file") and binary ("<hash> *file") sha256sum output.
digest_for_asset() {
  local sums_file="$1"
  local name="$2"
  awk -v name="$name" '
    { sub(/\r$/, "") }
    {
      fname = $2
      sub(/^\*/, "", fname)
      if (fname == name) { print $1; exit }
    }
  ' "$sums_file"
}

main() {
  local OWNER REPO TOKEN REQUESTED_VERSION INSTALL_ROOT DATA_DIR PORT SERVICE_NAME
  local GITHUB_API_BASE TOKEN_FILE TOKEN_FROM_STDIN

  OWNER="${DECKOS_GITHUB_OWNER:-}"
  REPO="${DECKOS_GITHUB_REPO:-}"
  TOKEN="${DECKOS_GITHUB_TOKEN:-}"
  REQUESTED_VERSION="${DECKOS_VERSION:-$DEFAULT_VERSION}"
  INSTALL_ROOT="${DECKOS_INSTALL_ROOT:-}"
  DATA_DIR="${DECKOS_DATA_DIR:-}"
  PORT="$ENV_PORT"
  SERVICE_NAME="${DECKOS_SERVICE_NAME:-}"
  GITHUB_API_BASE="${DECKOS_GITHUB_API_BASE:-}"
  TOKEN_FILE=""
  TOKEN_FROM_STDIN=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --owner) require_value "$1" "$#" "${2-}"; OWNER="$2"; shift 2;;
      --repo) require_value "$1" "$#" "${2-}"; REPO="$2"; shift 2;;
      --token) require_value "$1" "$#" "${2-}"; TOKEN="$2"; shift 2;;
      --token-file) require_value "$1" "$#" "${2-}"; TOKEN_FILE="$2"; shift 2;;
      --token-stdin) TOKEN_FROM_STDIN=1; shift 1;;
      --version) require_value "$1" "$#" "${2-}"; REQUESTED_VERSION="$2"; shift 2;;
      --install-root) require_value "$1" "$#" "${2-}"; INSTALL_ROOT="$2"; shift 2;;
      --data-dir) require_value "$1" "$#" "${2-}"; DATA_DIR="$2"; shift 2;;
      --port) require_value "$1" "$#" "${2-}"; PORT="$2"; shift 2;;
      --service-name) require_value "$1" "$#" "${2-}"; SERVICE_NAME="$2"; shift 2;;
      --api-base) require_value "$1" "$#" "${2-}"; GITHUB_API_BASE="$2"; shift 2;;
      --help|-h) usage; exit 0;;
      *) echo "Unknown arg: $1" >&2; usage >&2; exit 1;;
    esac
  done

  if [[ -n "$TOKEN_FILE" && "$TOKEN_FROM_STDIN" == "1" ]]; then
    die "Use either --token-file or --token-stdin, not both"
  fi

  # Precedence: --token-file / --token-stdin > --token / DECKOS_GITHUB_TOKEN.
  if [[ -n "$TOKEN_FILE" ]]; then
    TOKEN="$(read_token_from_file "$TOKEN_FILE")"
  elif [[ "$TOKEN_FROM_STDIN" == "1" ]]; then
    if [[ -t 0 ]]; then
      echo "Reading GitHub token from stdin (end with Ctrl-D)..." >&2
    fi
    TOKEN="$(tr -d ' \t\r\n')"
    [[ -n "$TOKEN" ]] || die "--token-stdin was given but stdin was empty"
  fi

  # Only strip CR/whitespace; do not use `xargs`, which would also strip quotes.
  OWNER="$(printf '%s' "$OWNER" | tr -d ' \t\n\r')"
  REPO="$(printf '%s' "$REPO" | tr -d ' \t\n\r')"
  TOKEN="$(printf '%s' "$TOKEN" | tr -d ' \t\n\r')"
  REQUESTED_VERSION="$(printf '%s' "$REQUESTED_VERSION" | tr -d ' \t\n\r')"
  INSTALL_ROOT="$(printf '%s' "$INSTALL_ROOT" | tr -d '\t\n\r')"
  DATA_DIR="$(printf '%s' "$DATA_DIR" | tr -d '\t\n\r')"
  PORT="$(printf '%s' "$PORT" | tr -d ' \t\n\r')"
  SERVICE_NAME="$(printf '%s' "$SERVICE_NAME" | tr -d ' \t\n\r')"
  GITHUB_API_BASE="$(printf '%s' "$GITHUB_API_BASE" | tr -d ' \t\n\r')"

  if [[ -n "$TOKEN" && ! "$TOKEN" =~ ^[A-Za-z0-9_.~+/=:-]+$ ]]; then
    die "Invalid GitHub token: contains characters that are not valid in a GitHub token"
  fi

  # Fail before touching the host: without a signing key nothing can be verified.
  assert_release_key_configured

  if [[ "$(id -u)" -ne 0 ]]; then
    die "Run as root (sudo)"
  fi

  if [[ ! -f /etc/os-release ]]; then
    die "Unsupported distro (missing /etc/os-release)"
  fi

  # shellcheck source=/dev/null
  source /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    die "Unsupported distro: ${ID:-unknown} ${VERSION_ID:-unknown} (only Ubuntu supported)"
  fi

  if ! array_contains "${VERSION_ID:-}" "${SUPPORTED_UBUNTU_VERSIONS[@]}"; then
    die "Unsupported Ubuntu version: ${VERSION_ID:-unknown} (supported: $(join_by ', ' "${SUPPORTED_UBUNTU_VERSIONS[@]}"))"
  fi

  local UBUNTU_CODENAME_VALUE
  UBUNTU_CODENAME_VALUE="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
  if [[ -z "${UBUNTU_CODENAME_VALUE}" ]]; then
    die "Unable to determine Ubuntu codename from /etc/os-release"
  fi

  # Re-running the installer must not discard settings from a previous run:
  # anything the caller did not pass falls back to the existing env file.
  OWNER="${OWNER:-$(read_env_value "DECKOS_GITHUB_OWNER" "$DEFAULT_OWNER" "$ENV_FILE")}"
  REPO="${REPO:-$(read_env_value "DECKOS_GITHUB_REPO" "$DEFAULT_REPO" "$ENV_FILE")}"
  INSTALL_ROOT="${INSTALL_ROOT:-$(read_env_value "DECKOS_INSTALL_ROOT" "$DEFAULT_INSTALL_ROOT" "$ENV_FILE")}"
  DATA_DIR="${DATA_DIR:-$(read_env_value "DECKOS_DATA_DIR" "$DEFAULT_DATA_DIR" "$ENV_FILE")}"
  PORT="${PORT:-$(read_env_value "PORT" "$DEFAULT_PORT" "$ENV_FILE")}"
  GITHUB_API_BASE="${GITHUB_API_BASE:-$(read_env_value "DECKOS_GITHUB_API_BASE" "$DEFAULT_GITHUB_API_BASE" "$ENV_FILE")}"
  SERVICE_NAME="${SERVICE_NAME:-$DEFAULT_SERVICE_NAME}"
  if [[ -z "$TOKEN" ]]; then
    TOKEN="$(read_env_value "DECKOS_GITHUB_TOKEN" "" "$ENV_FILE")"
  fi

  if [[ -z "$OWNER" || -z "$REPO" ]]; then
    die "Missing required repository information. Set --owner/--repo or DECKOS_GITHUB_OWNER/DECKOS_GITHUB_REPO."
  fi

  if [[ ! "$OWNER" =~ ^[A-Za-z0-9_.-]+$ || ! "$REPO" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    die "Invalid --owner/--repo. Expected GitHub owner/repo names (no spaces)."
  fi

  if [[ "$REQUESTED_VERSION" != "latest" && ! "$REQUESTED_VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    die "Invalid --version: ${REQUESTED_VERSION} (use 'latest' or a semver like 0.1.0 / v0.1.0)"
  fi

  validate_port "$PORT"
  validate_abs_path "--install-root" "$INSTALL_ROOT"
  validate_abs_path "--data-dir" "$DATA_DIR"
  validate_service_name "$SERVICE_NAME"
  INSTALL_ROOT="${INSTALL_ROOT%/}"
  DATA_DIR="${DATA_DIR%/}"

  DOWNLOAD_TMP_DIR="$(mktemp -d /tmp/deckos-install.XXXXXX)"
  chmod 0700 "$DOWNLOAD_TMP_DIR"
  cleanup_download_tmp() {
    rm -rf "${DOWNLOAD_TMP_DIR}"
  }
  trap cleanup_download_tmp EXIT
  setup_curl_auth_config

  apt-get update -y
  apt-get install -y ca-certificates curl gnupg jq openssl tar xz-utils bash sudo coreutils

  # ---------------------------------------------------------------------
  # Fetch and verify the release BEFORE mutating the host.
  #
  # This block needs only curl, jq, openssl and coreutils, all installed
  # above. Everything below it changes the machine -- the Docker apt repo and
  # engine, the deckos account, its docker-group membership, the NOPASSWD
  # sudoers rule, nvm and Node, and deckos.env. Verifying first means a bad
  # signature aborts while the host is still essentially untouched, and in
  # particular leaves deckos.env describing the release that is actually
  # installed rather than one that never arrived.
  # ---------------------------------------------------------------------
  step "Fetching release metadata from GitHub"
  local API RELEASE_URL TAG
  API="${GITHUB_API_BASE%/}/repos/${OWNER}/${REPO}"

  if [[ "$REQUESTED_VERSION" == "latest" ]]; then
    RELEASE_URL="${API}/releases/latest"
  else
    TAG="v${REQUESTED_VERSION#v}"
    RELEASE_URL="${API}/releases/tags/${TAG}"
  fi

  step "GET ${RELEASE_URL}"
  debug "GET (shell-escaped) $(printf '%q' "$RELEASE_URL")"
  local RELEASE_JSON TAG_NAME VER
  RELEASE_JSON="$(github_fetch_json "${RELEASE_URL}")"

  TAG_NAME="$(printf '%s' "$RELEASE_JSON" | jq -r '.tag_name')"
  VER="${TAG_NAME#v}"

  local ASSET_LINE ASSET_ID ASSET_NAME SUMS_ID SIG_ID
  ASSET_LINE="$(select_tarball_asset "$RELEASE_JSON")"
  if [[ -z "$ASSET_LINE" ]]; then
    die "No .tar.gz asset found on release ${TAG_NAME}"
  fi
  ASSET_ID="${ASSET_LINE%%$'\t'*}"
  ASSET_NAME="${ASSET_LINE#*$'\t'}"
  if [[ -z "$ASSET_ID" || "$ASSET_ID" == "null" || -z "$ASSET_NAME" ]]; then
    die "No .tar.gz asset found on release ${TAG_NAME}"
  fi
  # ASSET_NAME is server-supplied and becomes a path component below.
  if [[ ! "$ASSET_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
    die "Refusing to use release asset name with unexpected characters: ${ASSET_NAME}"
  fi

  SUMS_ID="$(asset_id_by_name "$RELEASE_JSON" "$SUMS_ASSET_NAME")"
  SIG_ID="$(asset_id_by_name "$RELEASE_JSON" "$SIG_ASSET_NAME")"
  if [[ -z "$SUMS_ID" || "$SUMS_ID" == "null" || -z "$SIG_ID" || "$SIG_ID" == "null" ]]; then
    echo "Release ${TAG_NAME} does not publish ${SUMS_ASSET_NAME} and ${SIG_ASSET_NAME}." >&2
    echo "DeckOS only installs signed releases. Choose a release that ships both" >&2
    echo "assets, or re-publish this tag with the current release workflow." >&2
    die "Aborting: release ${TAG_NAME} cannot be verified."
  fi

  local TAR_PATH SUMS_PATH SIG_PATH PUBKEY_PATH
  TAR_PATH="${DOWNLOAD_TMP_DIR}/${ASSET_NAME}"
  SUMS_PATH="${DOWNLOAD_TMP_DIR}/${SUMS_ASSET_NAME}"
  SIG_PATH="${DOWNLOAD_TMP_DIR}/${SIG_ASSET_NAME}"
  PUBKEY_PATH="${DOWNLOAD_TMP_DIR}/deckos-release.pub"

  step "Downloading release asset ${ASSET_NAME}"
  debug "GET (shell-escaped) $(printf '%q' "${API}/releases/assets/${ASSET_ID}")"
  github_fetch_to_file "application/octet-stream" "${API}/releases/assets/${ASSET_ID}" "$TAR_PATH"
  step "Downloading ${SUMS_ASSET_NAME}"
  github_fetch_to_file "application/octet-stream" "${API}/releases/assets/${SUMS_ID}" "$SUMS_PATH"
  step "Downloading ${SIG_ASSET_NAME}"
  github_fetch_to_file "application/octet-stream" "${API}/releases/assets/${SIG_ID}" "$SIG_PATH"

  # Write the embedded key to a real file (not a process substitution) so this
  # works when the script is invoked through a plain `sh`-style shell too.
  printf '%s\n' "$DECKOS_RELEASE_PUBLIC_KEY" > "$PUBKEY_PATH"
  chmod 0644 "$PUBKEY_PATH"
  if ! openssl pkey -pubin -in "$PUBKEY_PATH" -noout >/dev/null 2>&1; then
    die "Embedded DeckOS release public key is not a valid PEM public key."
  fi

  step "Verifying ${SUMS_ASSET_NAME} signature"
  if ! openssl pkeyutl -verify -pubin -inkey "$PUBKEY_PATH" -rawin \
    -sigfile "$SIG_PATH" -in "$SUMS_PATH" >/dev/null 2>&1; then
    echo "Signature verification FAILED for ${SUMS_ASSET_NAME} on release ${TAG_NAME}." >&2
    echo "The release manifest is not signed by the DeckOS release key. This may" >&2
    echo "mean the download was tampered with, or that the release was signed" >&2
    echo "with a different key than this installer trusts." >&2
    die "Aborting install. The host has not been modified."
  fi

  step "Verifying ${ASSET_NAME} digest"
  local EXPECTED_DIGEST ACTUAL_DIGEST
  EXPECTED_DIGEST="$(digest_for_asset "$SUMS_PATH" "$ASSET_NAME")"
  if [[ ! "$EXPECTED_DIGEST" =~ ^[0-9a-f]{64}$ ]]; then
    die "${SUMS_ASSET_NAME} has no valid SHA256 entry for ${ASSET_NAME}."
  fi
  ACTUAL_DIGEST="$(sha256sum "$TAR_PATH" | awk '{print $1}')"
  if [[ "$EXPECTED_DIGEST" != "$ACTUAL_DIGEST" ]]; then
    echo "Checksum mismatch for ${ASSET_NAME}:" >&2
    echo "  expected: ${EXPECTED_DIGEST}" >&2
    echo "  actual:   ${ACTUAL_DIGEST}" >&2
    die "Aborting install. The host has not been modified."
  fi

  step "Validating downloaded archive"
  if ! gzip -t "$TAR_PATH" >/dev/null 2>&1; then
    local FILE_SIZE
    FILE_SIZE="$(stat -c%s "$TAR_PATH" 2>/dev/null || echo "unknown")"
    echo "Downloaded asset is not a valid .tar.gz (size: ${FILE_SIZE})." >&2
    if [[ "$DEBUG" == "1" ]]; then
      echo "DEBUG: First bytes (printable):" >&2
      head -c 600 "$TAR_PATH" | tr -cd '\11\12\15\40-\176' >&2 || true
      echo >&2
    fi
    die "Aborting install. The host has not been modified."
  fi
  step "Release ${TAG_NAME} verified"

  # ---------------------------------------------------------------------
  # Everything below this line mutates the host.
  # ---------------------------------------------------------------------

  if ! command -v docker >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME_VALUE} stable" > /etc/apt/sources.list.d/docker.list
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
  local staged_sudoers="${DOWNLOAD_TMP_DIR}/deckos-power"
  cat > "$staged_sudoers" <<'EOF'
deckos ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff
deckos ALL=(root) NOPASSWD: /usr/bin/systemctl reboot
deckos ALL=(root) NOPASSWD: /usr/sbin/shutdown -h now
deckos ALL=(root) NOPASSWD: /usr/sbin/shutdown -r now
deckos ALL=(root) NOPASSWD: /usr/sbin/poweroff
deckos ALL=(root) NOPASSWD: /usr/sbin/reboot
deckos ALL=(root) NOPASSWD: /sbin/poweroff
deckos ALL=(root) NOPASSWD: /sbin/reboot
EOF
  chown root:root "$staged_sudoers"
  chmod 0440 "$staged_sudoers"
  if command -v visudo >/dev/null 2>&1; then
    if ! visudo -cf "$staged_sudoers" >/dev/null; then
      die "Generated sudoers rule failed validation; refusing to install ${SUDOERS_FILE}."
    fi
  else
    warn "visudo not found; installing ${SUDOERS_FILE} without syntax validation."
  fi
  install -o root -g root -m 0440 "$staged_sudoers" "$SUDOERS_FILE"

  if [[ ! -s /home/deckos/.nvm/nvm.sh ]]; then
    step "Installing nvm ${NVM_VERSION}"
    local nvm_script="${DOWNLOAD_TMP_DIR}/nvm-install.sh"
    if ! curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" -o "$nvm_script"; then
      die "Failed to download the pinned nvm installer (${NVM_VERSION})."
    fi
    if ! printf '%s  %s\n' "$NVM_INSTALL_SHA256" "$nvm_script" | sha256sum -c - >/dev/null 2>&1; then
      echo "nvm installer checksum mismatch for ${NVM_VERSION}." >&2
      echo "  expected: ${NVM_INSTALL_SHA256}" >&2
      echo "  actual:   $(sha256sum "$nvm_script" | awk '{print $1}')" >&2
      die "Refusing to execute an unverified nvm installer."
    fi
    install -o deckos -g deckos -m 0700 "$nvm_script" /home/deckos/nvm-install.sh
    su - deckos -s /bin/bash -c 'bash "$HOME/nvm-install.sh"'
    rm -f /home/deckos/nvm-install.sh
  fi

  step "Installing Node.js 24 for deckos via NVM"
  su - deckos -s /bin/bash -c 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm install 24; nvm alias default 24'

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
  # Deliberately 0755: managed app data under this tree is bind-mounted into
  # containers that run as arbitrary non-root UIDs and need path traversal.
  # The sensitive subtree (<data-dir>/security) is created 0700 by the server.
  install -d -m 0755 "${DATA_DIR}"
  chown -R deckos:deckos "${DATA_DIR}"

  step "Writing runtime configuration to ${ENV_FILE}"
  install -d -m 0755 "$ENV_DIR"
  if [[ -f "$ENV_FILE" ]]; then
    local env_backup
    env_backup="${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
    cp -a "$ENV_FILE" "$env_backup"
    step "Backed up ${ENV_FILE} to ${env_backup}"
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

  local TARGET_DIR="${INSTALL_ROOT}/releases/${VER}"
  rm -rf "${TARGET_DIR}.tmp"
  mkdir -p "${TARGET_DIR}.tmp"
  step "Extracting release to ${TARGET_DIR}"
  # --no-same-owner/--no-same-permissions: tar run as root would otherwise
  # honour archived ownership and setuid/setgid bits.
  tar -xzf "$TAR_PATH" -C "${TARGET_DIR}.tmp" --strip-components=1 \
    --no-same-owner --no-same-permissions
  test -f "${TARGET_DIR}.tmp/packages/server/dist/index.js"
  rm -rf "$TARGET_DIR"
  mv "${TARGET_DIR}.tmp" "$TARGET_DIR"
  ln -sfn "$TARGET_DIR" "${INSTALL_ROOT}/current"
  chown -R deckos:deckos "$TARGET_DIR"

  step "Installing systemd service ${SERVICE_NAME}"
  # Keep this unit template in lockstep with the copy in
  # migrate-install-defaults.sh.
  local UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
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
# NoNewPrivileges is deliberately NOT set: the UI's restart/shutdown actions
# go through setuid sudo and would break. Membership of the docker group is
# root-equivalent anyway, so these directives are containment, not a sandbox.
#
# ReadWritePaths takes precedence over ProtectHome, so /home stays writable:
# the file browser is a headline feature and /home is where a home-server
# user's files live. The net effect of ProtectHome here is that /root and
# /run/user are read-only.
PrivateTmp=yes
ProtectSystem=yes
ProtectHome=read-only
ReadWritePaths=-${INSTALL_ROOT} -${DATA_DIR} -/home
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
  systemctl enable "${SERVICE_NAME}.service"
  # Unconditional restart: `enable --now` is a no-op on an already-running unit,
  # which left re-installs serving the previous release on the previous port.
  step "Restarting ${SERVICE_NAME}.service"
  systemctl restart "${SERVICE_NAME}.service"
  systemctl status "${SERVICE_NAME}.service" --no-pager || true

  if [[ "$PORT" == "80" ]]; then
    echo "Installed DeckOS ${VER} to ${INSTALL_ROOT}. Open: http://<host>/"
  else
    echo "Installed DeckOS ${VER} to ${INSTALL_ROOT}. Open: http://<host>:${PORT}/"
  fi
}

main "$@"
