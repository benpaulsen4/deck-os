#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# DeckOS uninstaller.
#
# Like install.sh this is fetched standalone (curl | sudo bash) and runs as
# root, so the whole body lives in main() and main is invoked only on the last
# line: a truncated download must not be able to execute a partial removal.
#
# Paths default to whatever install.sh recorded in /etc/deckos/deckos.env, so
# the caller no longer has to retype them from memory. Flags override, every
# path is range-checked, and the exact deletion list is printed and confirmed
# before anything is removed.
# ---------------------------------------------------------------------------

ENV_DIR="/etc/deckos"
ENV_FILE="${ENV_DIR}/deckos.env"
SUDOERS_FILE="/etc/sudoers.d/deckos-power"

DEFAULT_INSTALL_ROOT="/opt/deckos"
DEFAULT_DATA_DIR="/var/lib/deckos"
DEFAULT_SERVICE_NAME="deckos"

# Removing one of these outright is a typo, never a real DeckOS location, so a
# supplied path must be strictly deeper than any of them.
CRITICAL_PATHS=(
  "/" "/bin" "/boot" "/data" "/dev" "/etc" "/export" "/home" "/lib" "/lib32"
  "/lib64" "/media" "/mnt" "/opt" "/proc" "/root" "/run" "/sbin" "/srv"
  "/storage" "/sys" "/tmp" "/usr" "/usr/local" "/usr/share" "/var" "/var/lib"
  "/var/log" "/var/opt" "/var/tmp"
)

# Subtrees that never hold a DeckOS install root or data directory.
FORBIDDEN_PREFIXES=(
  "/bin" "/boot" "/dev" "/etc" "/lib" "/lib32" "/lib64" "/proc" "/run"
  "/sbin" "/sys" "/usr"
)

step() {
  echo "==> $*"
}

die() {
  echo "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: sudo ./uninstall.sh [options]

Removes the DeckOS service, its configuration, install root and data
directory. Docker and Node.js are left installed.

Options:
  --install-root <path>   Install root to remove (default: the value recorded
                          in /etc/deckos/deckos.env, else /opt/deckos)
  --data-dir <path>       Data directory to remove (default: the value recorded
                          in /etc/deckos/deckos.env, else /var/lib/deckos)
  --service-name <name>   systemd unit name (default: deckos)
  --keep-data             Keep the data directory
  --dry-run               Print what would be removed, then exit
  --yes                   Do not prompt for confirmation
  --help                  Show this help

When this script is piped (curl ... | sudo bash) there is usually no terminal
to prompt on. It reads the confirmation from /dev/tty when it can, and
otherwise refuses to continue unless --yes is passed.
EOF
}

require_value() {
  local flag="$1"
  local remaining="$2"
  if (( remaining < 2 )); then
    die "Missing value for ${flag}"
  fi
}

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

# Refuses anything that is not plausibly a DeckOS-owned directory. This is the
# guard against a typo such as `--data-dir /var/lib` wiping an unrelated tree.
validate_removable_path() {
  local flag="$1"
  local value="$2"

  [[ -n "$value" ]] || die "${flag} must not be empty"
  [[ "$value" == /* ]] || die "${flag} must be an absolute path: ${value}"
  if [[ "$value" =~ [[:cntrl:]] ]]; then
    die "${flag} must not contain control characters"
  fi
  case "$value" in
    *"/../"*|*"/..") die "${flag} must not contain '..': ${value}";;
  esac

  if array_contains "$value" "${CRITICAL_PATHS[@]}"; then
    die "Refusing to remove ${flag} ${value}: that is a system directory, not a DeckOS directory."
  fi

  local prefix
  for prefix in "${FORBIDDEN_PREFIXES[@]}"; do
    if [[ "$value" == "$prefix" || "$value" == "$prefix"/* ]]; then
      die "Refusing to remove ${flag} ${value}: ${prefix} never holds a DeckOS install root or data directory."
    fi
  done

  # Require at least two path components so a bare top-level directory still
  # has to be a deliberate, explicit DeckOS location.
  local trimmed="${value#/}"
  if [[ "$trimmed" != */* ]]; then
    die "Refusing to remove ${flag} ${value}: expected a path at least two levels deep (for example /opt/deckos)."
  fi
}

confirm_removal() {
  local reply=""
  echo -n "Type 'y' to permanently remove everything listed above [y/N]: "
  if [[ -r /dev/tty ]]; then
    read -r reply < /dev/tty || true
  elif [[ -t 0 ]]; then
    read -r reply || true
  else
    echo ""
    echo "No terminal is available to read a confirmation from." >&2
    die "Re-run with --yes to confirm non-interactively."
  fi
  echo ""
  [[ "$reply" == "y" || "$reply" == "Y" ]]
}

main() {
  local INSTALL_ROOT DATA_DIR SERVICE_NAME ASSUME_YES DRY_RUN KEEP_DATA

  INSTALL_ROOT="${DECKOS_INSTALL_ROOT:-}"
  DATA_DIR="${DECKOS_DATA_DIR:-}"
  SERVICE_NAME="${DECKOS_SERVICE_NAME:-}"
  ASSUME_YES=0
  DRY_RUN=0
  KEEP_DATA=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --install-root) require_value "$1" "$#"; INSTALL_ROOT="$2"; shift 2;;
      --data-dir) require_value "$1" "$#"; DATA_DIR="$2"; shift 2;;
      --service-name) require_value "$1" "$#"; SERVICE_NAME="$2"; shift 2;;
      --keep-data) KEEP_DATA=1; shift 1;;
      --dry-run) DRY_RUN=1; shift 1;;
      --yes|-y) ASSUME_YES=1; shift 1;;
      --help|-h) usage; exit 0;;
      *) echo "Unknown arg: $1" >&2; usage >&2; exit 1;;
    esac
  done

  if [[ "$(id -u)" -ne 0 ]]; then
    die "Run as root (sudo)"
  fi

  INSTALL_ROOT="$(printf '%s' "$INSTALL_ROOT" | tr -d '\t\n\r')"
  DATA_DIR="$(printf '%s' "$DATA_DIR" | tr -d '\t\n\r')"
  SERVICE_NAME="$(printf '%s' "$SERVICE_NAME" | tr -d ' \t\n\r')"

  # Default from what install.sh actually recorded, rather than from what the
  # operator remembers typing months ago.
  INSTALL_ROOT="${INSTALL_ROOT:-$(read_env_value "DECKOS_INSTALL_ROOT" "$DEFAULT_INSTALL_ROOT" "$ENV_FILE")}"
  DATA_DIR="${DATA_DIR:-$(read_env_value "DECKOS_DATA_DIR" "$DEFAULT_DATA_DIR" "$ENV_FILE")}"
  SERVICE_NAME="${SERVICE_NAME:-$DEFAULT_SERVICE_NAME}"

  if [[ ! "$SERVICE_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]*$ ]]; then
    die "Invalid --service-name: ${SERVICE_NAME}"
  fi

  INSTALL_ROOT="${INSTALL_ROOT%/}"
  DATA_DIR="${DATA_DIR%/}"
  validate_removable_path "--install-root" "$INSTALL_ROOT"
  if [[ "$KEEP_DATA" -eq 0 ]]; then
    validate_removable_path "--data-dir" "$DATA_DIR"
  fi

  local UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

  echo "DeckOS uninstall plan"
  echo ""
  echo "  systemd unit        ${SERVICE_NAME}.service (stop, disable, remove ${UNIT_PATH})"
  echo "  sudoers rule        ${SUDOERS_FILE}"
  echo "  helper scripts      /usr/local/bin/deckos-node"
  echo "                      /usr/local/bin/deckos-fix-cpu-power-perms"
  echo "  configuration       ${ENV_DIR}"
  echo "  install root        ${INSTALL_ROOT}"
  if [[ "$KEEP_DATA" -eq 1 ]]; then
    echo "  data directory      (kept: --keep-data)"
  else
    echo "  data directory      ${DATA_DIR}"
  fi
  echo "  service account     user 'deckos' and group 'deckos'"
  echo ""
  echo "Docker and Node.js are NOT removed."
  echo ""

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "--dry-run: nothing was removed."
    exit 0
  fi

  if [[ "$ASSUME_YES" -ne 1 ]]; then
    if ! confirm_removal; then
      die "Aborted. Nothing was removed."
    fi
  fi

  if command -v systemctl >/dev/null 2>&1; then
    if [[ "$(systemctl show --property=LoadState --value "${SERVICE_NAME}.service" 2>/dev/null || true)" != "not-found" ]]; then
      systemctl stop "${SERVICE_NAME}.service" || true
      systemctl disable "${SERVICE_NAME}.service" || true
    fi
  fi

  rm -f "$UNIT_PATH"
  rm -f /usr/local/bin/deckos-node
  rm -f /usr/local/bin/deckos-fix-cpu-power-perms

  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || true
    systemctl reset-failed || true
  fi

  # Remove the NOPASSWD power rule BEFORE deleting the account. sudo happily
  # keeps rules for users that no longer exist, so leaving this behind means a
  # later `deckos` account -- a reinstall, or a human account of that name --
  # silently inherits passwordless poweroff/reboot.
  step "Removing ${SUDOERS_FILE}"
  rm -f "$SUDOERS_FILE"

  rm -rf "$ENV_DIR"
  step "Removing ${INSTALL_ROOT}"
  rm -rf "${INSTALL_ROOT}"
  if [[ "$KEEP_DATA" -eq 0 ]]; then
    step "Removing ${DATA_DIR}"
    rm -rf "${DATA_DIR}"
  else
    step "Keeping ${DATA_DIR}"
  fi

  if id -u deckos >/dev/null 2>&1; then
    userdel --remove deckos || true
  fi

  if getent group deckos >/dev/null 2>&1; then
    groupdel deckos || true
  fi

  echo "DeckOS removed. Node.js and Docker were not uninstalled."
}

main "$@"
