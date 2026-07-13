#!/usr/bin/env bash
#
# ALS Inventory — Hardware Audit capture tool
# --------------------------------------------
# Boot the device off a Linux live USB, connect to Wi-Fi, and run this. It reads
# the machine's hardware and files it as an audit INTO the lot you selected in
# the web app ("Set audit target" on the Lots page). It does NOT verify anything
# against a list — it simply creates/updates the device in that lot.
#
#   sudo bash hardware-audit.sh
#
# Preconfigure login once by putting an "audit.conf" next to this script:
#   AUDIT_URL="https://als-inventory-software-production.up.railway.app"
#   AUDIT_EMAIL="you@company.com"
#   AUDIT_PASSWORD="your-password"
# Then each run is just: confirm, and it uploads. (If audit.conf is missing it
# will ask once.)

API_DEFAULT="https://als-inventory-software-production.up.railway.app"

# --- load preconfigured settings if present ---
SELF_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
for conf in "$SELF_DIR/audit.conf" /cdrom/audit.conf ./audit.conf; do
  [ -f "$conf" ] && . "$conf" && break
done
API="${AUDIT_URL:-$API_DEFAULT}"

echo "=================================================="
echo "  ALS Inventory — Hardware Audit"
echo "=================================================="

# --- tools ---
missing=""
for c in curl jq dmidecode lsblk; do
  command -v "$c" >/dev/null 2>&1 || missing="$missing $c"
done
if [ -n "$missing" ]; then
  echo "Installing tools ($missing )…"
  sudo apt-get update -qq >/dev/null 2>&1
  sudo apt-get install -y -qq curl jq dmidecode util-linux smartmontools >/dev/null 2>&1
fi

# --- login (from config, or prompt once) ---
if [ -z "${AUDIT_EMAIL:-}" ]; then read -rp "Login email: " AUDIT_EMAIL; fi
if [ -z "${AUDIT_PASSWORD:-}" ]; then read -rsp "Password: " AUDIT_PASSWORD; echo; fi

echo "Signing in…"
TOKEN=$(curl -sS -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg e "$AUDIT_EMAIL" --arg p "$AUDIT_PASSWORD" '{email:$e,password:$p}')" \
  | jq -r '.accessToken // empty')
if [ -z "$TOKEN" ]; then echo "Sign-in failed — check audit.conf (email/password/URL)."; exit 1; fi

# --- which lot are we auditing into? (chosen in the web app) ---
TARGET=$(curl -sS "$API/devices/audit-target" -H "Authorization: Bearer $TOKEN")
LOT=$(echo "$TARGET" | jq -r '.batchNumber // empty')
if [ -z "$LOT" ]; then
  echo
  echo "No audit lot selected. In Als Inventory → Lots → 'Set audit target' on the"
  echo "lot you're working on, then re-run this tool."
  exit 1
fi

# --- read hardware ---
dmi() { sudo dmidecode -s "$1" 2>/dev/null | grep -v '^#' | head -n1 | sed 's/[[:space:]]*$//'; }
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
  if [ -n "$full" ] && [ -n "$design" ] && [ "$design" -gt 0 ] 2>/dev/null; then
    BATTERY="$(( full * 100 / design ))%"
  fi
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

PAYLOAD=$(jq -n \
  --arg man "$MANUFACTURER" --arg mod "$MODEL" --arg ser "$SERIAL" --arg cat "$CATEGORY" \
  --arg cpu "$CPU" --argjson ram "$RAM_GB" --arg sto "$STORAGE" --arg bat "$BATTERY" '
  {category: $cat}
  + (if $man != "" then {manufacturer: $man} else {} end)
  + (if $mod != "" then {model: $mod} else {} end)
  + (if $ser != "" then {serialNumber: $ser} else {} end)
  + (if $cpu != "" then {cpu: $cpu} else {} end)
  + (if $ram > 0  then {ramGb: $ram} else {} end)
  + (if $sto != "" then {storageCapacity: $sto} else {} end)
  + (if $bat != "" then {batteryHealth: $bat} else {} end)')

RESP=$(curl -sS -X POST "$API/devices/hardware-audit" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$PAYLOAD")

if echo "$RESP" | jq -e '.assetId' >/dev/null 2>&1; then
  VERB=$([ "$(echo "$RESP" | jq -r '.created')" = "true" ] && echo "added to" || echo "re-audited in")
  echo
  echo "✓ $(echo "$RESP" | jq -r '.name') ($(echo "$RESP" | jq -r '.tag')) $VERB $(echo "$RESP" | jq -r '.lot')."
else
  echo
  echo "✗ Upload failed: $(echo "$RESP" | jq -r '.message // .')"
fi
