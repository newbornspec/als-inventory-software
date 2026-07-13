#!/usr/bin/env bash
#
# ALS Inventory — Hardware Audit capture tool
# --------------------------------------------
# Boot the device off a Linux live USB (SystemRescue or Ubuntu), then run:
#   bash hardware-audit.sh
#
# It connects to Wi-Fi automatically, reads the machine's hardware, and files it
# as an audit INTO the lot you selected in the web app ("Set audit target" on the
# Lots page). It does NOT verify anything against a list — it creates/updates the
# device in that lot.
#
# Preconfigure everything once in an "audit.conf" beside this script:
#   AUDIT_URL, AUDIT_EMAIL, AUDIT_PASSWORD, WIFI_SSID, WIFI_PASSWORD
# Then each run is just: confirm, and it uploads.

API_DEFAULT="https://als-inventory-software-production.up.railway.app"

# --- load preconfigured settings ---
SELF_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
for conf in "$SELF_DIR/audit.conf" /cdrom/audit.conf /run/archiso/bootmnt/audit.conf ./audit.conf; do
  [ -f "$conf" ] && . "$conf" && break
done
API="${AUDIT_URL:-$API_DEFAULT}"

echo "=================================================="
echo "  ALS Inventory — Hardware Audit"
echo "=================================================="

# --- tiny JSON helpers (no jq dependency) ---
jesc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\r\n'; }
jstr() { printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -n1 | sed 's/.*":"//; s/"$//'; }
jraw() { printf '%s' "$1" | grep -o "\"$2\":[^,}]*" | head -n1 | sed 's/.*://; s/[[:space:]]//g'; }

online() { curl -s --max-time 6 -o /dev/null "$API" 2>/dev/null; }

# --- connect Wi-Fi automatically (iwd on SystemRescue, nmcli on Ubuntu) ---
connect_wifi() {
  online && return 0
  [ -z "${WIFI_SSID:-}" ] && return 0   # wired/manual — nothing to do

  rfkill unblock all 2>/dev/null
  IFACE=""
  for w in /sys/class/net/*/wireless; do
    [ -e "$w" ] && IFACE=$(basename "$(dirname "$w")") && break
  done
  [ -n "$IFACE" ] && ip link set "$IFACE" up 2>/dev/null

  echo "Connecting to Wi-Fi \"$WIFI_SSID\"…"
  if command -v nmcli >/dev/null 2>&1; then
    nmcli device wifi connect "$WIFI_SSID" password "$WIFI_PASSWORD" >/dev/null 2>&1
  elif command -v iwctl >/dev/null 2>&1 && [ -n "$IFACE" ]; then
    systemctl start iwd 2>/dev/null; sleep 2
    iwctl station "$IFACE" scan >/dev/null 2>&1; sleep 3
    iwctl --passphrase "$WIFI_PASSWORD" station "$IFACE" connect "$WIFI_SSID" >/dev/null 2>&1
  fi

  for _ in $(seq 1 25); do
    online && { echo "Wi-Fi connected."; return 0; }
    sleep 2
  done
  echo "Could not reach the server over Wi-Fi — check WIFI_SSID/WIFI_PASSWORD in audit.conf,"
  echo "or plug in Ethernet. (Adapter: ${IFACE:-none found}.)"
  return 1
}

# --- make sure the tools we need exist (SystemRescue/Ubuntu both ship these) ---
ensure_tools() {
  local miss=""
  for c in curl dmidecode lsblk; do command -v "$c" >/dev/null 2>&1 || miss="$miss $c"; done
  [ -z "$miss" ] && return 0
  if command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm curl dmidecode util-linux >/dev/null 2>&1
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl dmidecode util-linux >/dev/null 2>&1
  fi
}

connect_wifi || exit 1
ensure_tools

# --- login ---
[ -z "${AUDIT_EMAIL:-}" ] && read -rp "Login email: " AUDIT_EMAIL
[ -z "${AUDIT_PASSWORD:-}" ] && { read -rsp "Password: " AUDIT_PASSWORD; echo; }

echo "Signing in…"
LOGIN=$(curl -sS -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$(jesc "$AUDIT_EMAIL")\",\"password\":\"$(jesc "$AUDIT_PASSWORD")\"}")
TOKEN=$(jstr "$LOGIN" accessToken)
[ -z "$TOKEN" ] && { echo "Sign-in failed — check audit.conf (email/password/URL)."; exit 1; }

# --- which lot? (chosen in the web app) ---
TARGET=$(curl -sS "$API/devices/audit-target" -H "Authorization: Bearer $TOKEN")
LOT=$(jstr "$TARGET" batchNumber)
if [ -z "$LOT" ]; then
  echo
  echo "No audit lot selected. In Als Inventory → Lots → 'Set audit target' on the lot"
  echo "you're working on, then re-run this tool."
  exit 1
fi

# --- read hardware ---
dmi() { dmidecode -s "$1" 2>/dev/null | grep -v '^#' | head -n1 | sed 's/[[:space:]]*$//'; }
MANUFACTURER=$(dmi system-manufacturer)
MODEL=$(dmi system-product-name)
SERIAL=$(dmi system-serial-number)
CPU=$(lscpu 2>/dev/null | sed -n 's/^Model name:[[:space:]]*//p' | head -n1)
[ -z "$CPU" ] && CPU=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | sed 's/^ //')
MEM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}')
RAM_GB=0; [ -n "$MEM_KB" ] && RAM_GB=$(( (MEM_KB + 512 * 1024) / (1024 * 1024) ))
STORAGE=""
DEV=$(lsblk -dno NAME,TYPE 2>/dev/null | awk '$2=="disk"{print $1; exit}')
if [ -n "$DEV" ]; then
  DSIZE=$(lsblk -dnbo SIZE "/dev/$DEV" 2>/dev/null | awk '{printf "%.0f", $1/1000000000}')
  DMODEL=$(lsblk -dno MODEL "/dev/$DEV" 2>/dev/null | sed 's/[[:space:]]*$//')
  STORAGE="${DSIZE}GB${DMODEL:+ $DMODEL}"
fi
BATTERY=""
for b in /sys/class/power_supply/BAT*; do
  [ -e "$b" ] || continue
  full=$(cat "$b/energy_full" 2>/dev/null || cat "$b/charge_full" 2>/dev/null)
  design=$(cat "$b/energy_full_design" 2>/dev/null || cat "$b/charge_full_design" 2>/dev/null)
  [ -n "$full" ] && [ -n "$design" ] && [ "$design" -gt 0 ] 2>/dev/null && BATTERY="$(( full * 100 / design ))%"
  break
done
CATEGORY="Desktop"; [ -n "$BATTERY" ] && CATEGORY="Laptop"

echo
echo "Detected on this machine:"
printf "  %-14s %s\n" "Manufacturer" "${MANUFACTURER:-?}"
printf "  %-14s %s\n" "Model"        "${MODEL:-?}"
printf "  %-14s %s\n" "Serial"       "${SERIAL:-?}"
printf "  %-14s %s\n" "CPU"          "${CPU:-?}"
printf "  %-14s %s\n" "RAM"          "${RAM_GB} GB"
printf "  %-14s %s\n" "Storage"      "${STORAGE:-?}"
printf "  %-14s %s\n" "Battery"      "${BATTERY:-n/a}"
echo
read -rp "Start audit into ${LOT}? [Y/n] " GO
case "${GO:-Y}" in [nN]*) echo "Cancelled."; exit 0 ;; esac

# --- build payload (no jq) ---
P="{\"category\":\"$(jesc "$CATEGORY")\""
add() { [ -n "$2" ] && P="$P,\"$1\":\"$(jesc "$2")\""; }
add manufacturer "$MANUFACTURER"
add model "$MODEL"
add serialNumber "$SERIAL"
add cpu "$CPU"
add storageCapacity "$STORAGE"
add batteryHealth "$BATTERY"
[ "$RAM_GB" -gt 0 ] 2>/dev/null && P="$P,\"ramGb\":$RAM_GB"
P="$P}"

RESP=$(curl -sS -X POST "$API/devices/hardware-audit" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$P")

if [ -n "$(jstr "$RESP" assetId)" ]; then
  VERB=$([ "$(jraw "$RESP" created)" = "true" ] && echo "added to" || echo "re-audited in")
  echo
  echo "✓ $(jstr "$RESP" name) ($(jstr "$RESP" tag)) $VERB $(jstr "$RESP" lot)."
else
  echo
  echo "✗ Upload failed: $(jstr "$RESP" message)"
fi
