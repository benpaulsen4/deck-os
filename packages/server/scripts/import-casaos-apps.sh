#!/usr/bin/env bash
set -euo pipefail

SRC_DIR=""
if [[ "$(uname -s)" == "Linux" ]]; then
  SRC_DIR="/var/lib/casaos/apps"
fi
OUT_DIR="${DECKOS_DATA_DIR:-/var/lib/deckos}/apps"
HOST="localhost"
OVERWRITE=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --src)
      SRC_DIR="${2:-}"
      shift 2
      ;;
    --out)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --host)
      HOST="${2:-}"
      shift 2
      ;;
    --overwrite)
      OVERWRITE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$SRC_DIR" ]]; then
  echo "Missing --src" >&2
  exit 1
fi

if [[ ! -d "$SRC_DIR" ]]; then
  echo "CasaOS app folder not found: $SRC_DIR" >&2
  exit 1
fi

slugify_id() {
  local input="$1"
  local s
  s="$(printf '%s' "$input" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  s="${s:0:64}"
  if [[ -z "$s" ]]; then
    s="app"
  fi
  printf '%s' "$s"
}

is_http_url() {
  [[ "$1" =~ ^https?:// ]]
}

first_paragraph() {
  python3 - "$1" <<'PY'
import re, sys
text = (sys.argv[1] if len(sys.argv) > 1 else "").replace("\r\n", "\n").strip()
if not text:
    print("")
    raise SystemExit(0)
para = re.split(r"\n\s*\n", text, maxsplit=1)[0].strip()
one = re.sub(r"\s+", " ", para).strip()
max_len = 240
if len(one) <= max_len:
    print(one)
else:
    out = one[:max(0, max_len - 1)].rstrip() + "…"
    print(out)
PY
}

get_compose_path() {
  local dir="$1"
  if [[ -f "$dir/docker-compose.yml" ]]; then
    printf '%s\n' "$dir/docker-compose.yml"
    return 0
  fi
  if [[ -f "$dir/docker-compose.yaml" ]]; then
    printf '%s\n' "$dir/docker-compose.yaml"
    return 0
  fi
  return 1
}

read_appfile_fields() {
  python3 - "$1" <<'PY'
import json, re, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
title = data.get("title", "")
overview = data.get("overview", "")
tagline = data.get("tagline", "")
icon = data.get("icon", "")
name = title.strip() if isinstance(title, str) and title.strip() else ""
description = ""
if isinstance(overview, str) and overview.strip():
    description = overview.strip()
elif isinstance(tagline, str) and tagline.strip():
    description = tagline.strip()
if not (isinstance(icon, str) and re.match(r"^https?://", icon.strip() or "")):
    icon = ""
else:
    icon = icon.strip()
print(name)
print(description)
print(icon)
PY
}

extract_compose_meta() {
  python3 - "$1" <<'PY'
import re, sys
from collections import OrderedDict

path = sys.argv[1]
text = open(path, "r", encoding="utf-8").read()
lines = text.splitlines()
title = ""
icon = ""
description = ""
tagline = ""

def strip_quotes(v: str) -> str:
    v = v.strip()
    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
        return v[1:-1].strip()
    return v

x_idx = -1
for i, ln in enumerate(lines):
    if re.match(r"^\s*x-casaos\s*:\s*$", ln):
        x_idx = i
        break

if x_idx != -1:
    x_indent = len(lines[x_idx]) - len(lines[x_idx].lstrip())
    i = x_idx + 1
    while i < len(lines):
        ln = lines[i]
        if not ln.strip():
            i += 1
            continue
        indent = len(ln) - len(ln.lstrip())
        if indent <= x_indent:
            break
        m = re.match(r"^\s*(title|name|icon|description|tagline)\s*:\s*(.*)$", ln)
        if not m:
            i += 1
            continue
        key = m.group(1)
        val = m.group(2).strip()
        if key == "icon":
            if val:
                icon = strip_quotes(val)
            i += 1
            continue
        if key in ("name",):
            if val and not title:
                title = strip_quotes(val)
            i += 1
            continue
        if key in ("title", "description", "tagline"):
            if val:
                chosen = strip_quotes(val)
            else:
                chosen = ""
                pref = OrderedDict((k, "") for k in ("en_US", "en_GB", "en"))
                j = i + 1
                field_indent = indent
                first_nonempty = ""
                while j < len(lines):
                    l2 = lines[j]
                    if not l2.strip():
                        j += 1
                        continue
                    ind2 = len(l2) - len(l2.lstrip())
                    if ind2 <= field_indent:
                        break
                    m2 = re.match(r"^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$", l2)
                    if m2:
                        lk = m2.group(1)
                        lv = strip_quotes(m2.group(2))
                        if lv and not first_nonempty:
                            first_nonempty = lv
                        if lk in pref and lv:
                            pref[lk] = lv
                    j += 1
                for pk in ("en_US", "en_GB", "en"):
                    if pref[pk]:
                        chosen = pref[pk]
                        break
                if not chosen:
                    chosen = first_nonempty
            if key == "title" and chosen and not title:
                title = chosen
            if key == "description" and chosen and not description:
                description = chosen
            if key == "tagline" and chosen and not tagline:
                tagline = chosen
        i += 1

print(title.strip())
print(icon.strip())
print((description or tagline).strip())
PY
}

compose_validate_and_url() {
  local compose_path="$1"
  local host="$2"
  if ! command -v docker >/dev/null 2>&1; then
    echo "0"
    echo ""
    return
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "0"
    echo ""
    return
  fi
  python3 - "$compose_path" "$host" <<'PY'
import json, subprocess, sys

compose_path = sys.argv[1]
host = sys.argv[2]
cmd = ["docker", "compose", "-f", compose_path, "config", "--no-interpolate", "--format", "json"]
try:
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, check=True)
except Exception:
    print("0")
    print("")
    raise SystemExit(0)

try:
    data = json.loads(proc.stdout)
except Exception:
    print("0")
    print("")
    raise SystemExit(0)

services = data.get("services")
if not isinstance(services, dict) or not services:
    print("0")
    print("")
    raise SystemExit(0)

for svc in services.values():
    if not isinstance(svc, dict):
        print("0")
        print("")
        raise SystemExit(0)
    image = svc.get("image")
    if not isinstance(image, str) or not image.strip():
        print("0")
        print("")
        raise SystemExit(0)

url = ""
for svc in services.values():
    ports = svc.get("ports")
    if not isinstance(ports, list):
        continue
    for entry in ports:
        host_port = ""
        if isinstance(entry, str):
            parts = entry.split(":")
            if len(parts) >= 2:
                left = parts[0]
                digits = []
                seen = False
                for ch in left:
                    if ch.isdigit():
                        digits.append(ch)
                        seen = True
                    elif seen:
                        break
                host_port = "".join(digits)
        elif isinstance(entry, dict):
            published = entry.get("published")
            if published is not None:
                host_port = str(published)
        if host_port.isdigit():
            url = f"http://{host}:{host_port}"
            break
    if url:
        break

print("1")
print(url)
PY
}

declare -a SOURCE_APP_DIRS=()
if direct_compose="$(get_compose_path "$SRC_DIR" || true)"; [[ -n "${direct_compose:-}" ]]; then
  SOURCE_APP_DIRS+=("$SRC_DIR")
else
  while IFS= read -r -d '' dir; do
    if get_compose_path "$dir" >/dev/null 2>&1; then
      SOURCE_APP_DIRS+=("$dir")
    fi
  done < <(find "$SRC_DIR" -mindepth 1 -maxdepth 1 -type d -print0)
fi

if [[ "${#SOURCE_APP_DIRS[@]}" -eq 0 ]]; then
  echo "No CasaOS app directories found under: $SRC_DIR" >&2
  exit 1
fi

if [[ "$DRY_RUN" -eq 0 ]]; then
  mkdir -p "$OUT_DIR"
fi

declare -A USED_IDS=()
if [[ -d "$OUT_DIR" ]]; then
  while IFS= read -r -d '' dir; do
    USED_IDS["$(basename "$dir")"]=1
  done < <(find "$OUT_DIR" -mindepth 1 -maxdepth 1 -type d -print0)
fi

next_order=-1
if [[ -d "$OUT_DIR" ]]; then
  while IFS= read -r -d '' metadata; do
    order="$(python3 - "$metadata" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1], "r", encoding="utf-8"))
    value = data.get("order")
    if isinstance(value, int):
        print(value)
except Exception:
    pass
PY
)"
    if [[ "$order" =~ ^[0-9]+$ ]] && (( order > next_order )); then
      next_order="$order"
    fi
  done < <(find "$OUT_DIR" -mindepth 2 -maxdepth 2 -type f -name metadata.json -print0)
fi
next_order=$((next_order + 1))

ensure_unique_id() {
  local base="$1"
  local id="$base"
  local i=2
  while [[ -n "${USED_IDS[$id]+x}" ]]; do
    local suffix="-$i"
    local max_base=$((64 - ${#suffix}))
    if (( max_base < 1 )); then
      max_base=1
    fi
    id="${base:0:max_base}${suffix}"
    i=$((i + 1))
  done
  USED_IDS["$id"]=1
  printf '%s' "$id"
}

now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
imported=0
overwritten=0
skipped=0

for app_dir in "${SOURCE_APP_DIRS[@]}"; do
  folder_name="$(basename "$app_dir")"
  compose_path="$(get_compose_path "$app_dir" || true)"
  if [[ -z "$compose_path" ]]; then
    skipped=$((skipped + 1))
    continue
  fi

  mapfile -t compose_state < <(compose_validate_and_url "$compose_path" "$HOST")
  compose_valid="${compose_state[0]:-0}"
  inferred_url="${compose_state[1]:-}"
  if [[ "$compose_valid" != "1" ]]; then
    skipped=$((skipped + 1))
    continue
  fi

  name="$folder_name"
  description=""
  icon=""

  appfile_path="$app_dir/appfile.json"
  if [[ -f "$appfile_path" ]]; then
    if ! mapfile -t appfile_values < <(read_appfile_fields "$appfile_path" 2>/dev/null); then
      continue
    fi
    app_title="${appfile_values[0]:-}"
    app_desc="${appfile_values[1]:-}"
    app_icon="${appfile_values[2]:-}"
    if [[ -n "$app_title" ]]; then
      name="$app_title"
    fi
    if [[ -n "$app_desc" ]]; then
      description="$app_desc"
    fi
    if [[ -n "$app_icon" ]]; then
      icon="$app_icon"
    fi
  fi

  mapfile -t compose_meta < <(extract_compose_meta "$compose_path")
  compose_title="${compose_meta[0]:-}"
  compose_icon="${compose_meta[1]:-}"
  compose_description="${compose_meta[2]:-}"

  if [[ -z "$description" && -n "$compose_description" ]]; then
    description="$(first_paragraph "$compose_description")"
  fi
  if [[ -z "$icon" && -n "$compose_icon" ]] && is_http_url "$compose_icon"; then
    icon="$compose_icon"
  fi
  if [[ "$name" == "$folder_name" && -n "$compose_title" ]]; then
    name="$compose_title"
  fi

  base_id="$(slugify_id "$folder_name")"
  existing_path="$OUT_DIR/$base_id"
  can_overwrite_base=0
  if [[ "$OVERWRITE" -eq 1 && -d "$existing_path" && -f "$existing_path/metadata.json" && -f "$existing_path/docker-compose.yml" ]]; then
    can_overwrite_base=1
  fi

  if [[ "$can_overwrite_base" -eq 1 ]]; then
    app_id="$base_id"
  else
    app_id="$(ensure_unique_id "$base_id")"
  fi

  target_dir="$OUT_DIR/$app_id"
  target_metadata_path="$target_dir/metadata.json"
  target_compose_path="$target_dir/docker-compose.yml"
  target_exists=0
  if [[ -d "$target_dir" ]]; then
    target_exists=1
  fi

  if [[ "$target_exists" -eq 1 && "$OVERWRITE" -eq 0 && "$can_overwrite_base" -eq 0 ]]; then
    skipped=$((skipped + 1))
    continue
  fi

  created_at="$now"
  order="$next_order"
  if [[ "$target_exists" -eq 1 && "$OVERWRITE" -eq 1 && -f "$target_metadata_path" ]]; then
    if mapfile -t old_meta < <(python3 - "$target_metadata_path" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1], "r", encoding="utf-8"))
    created_at = data.get("createdAt")
    order = data.get("order")
    if isinstance(created_at, str) and isinstance(order, int):
        print(created_at)
        print(order)
except Exception:
    pass
PY
); then
      if [[ "${#old_meta[@]}" -ge 2 ]]; then
        created_at="${old_meta[0]}"
        order="${old_meta[1]}"
      else
        created_at="$now"
        order="$next_order"
      fi
    else
      created_at="$now"
      order="$next_order"
    fi
  else
    next_order=$((next_order + 1))
  fi

  if [[ "$DRY_RUN" -eq 0 ]]; then
    mkdir -p "$target_dir"
    python3 - "$target_metadata_path" "$app_id" "$name" "$icon" "$inferred_url" "$description" "$order" "$created_at" "$now" <<'PY'
import json, sys
path, app_id, name, icon, url, description, order, created_at, updated_at = sys.argv[1:]
obj = {
    "id": app_id,
    "name": name,
    "icon": icon,
    "url": url,
    "description": description,
    "order": int(order),
    "createdAt": created_at,
    "updatedAt": updated_at,
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(obj, f, indent=2)
    f.write("\n")
PY
    cp "$compose_path" "$target_compose_path"
  fi

  if [[ "$target_exists" -eq 1 ]]; then
    overwritten=$((overwritten + 1))
  else
    imported=$((imported + 1))
  fi
done

echo "CasaOS import complete: ${imported} imported, ${overwritten} overwritten, ${skipped} skipped -> ${OUT_DIR}"
