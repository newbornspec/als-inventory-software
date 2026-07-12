#!/usr/bin/env bash
#
# ALS Inventory — Hardware Audit capture tool
# --------------------------------------------
# Run this ON the device you are auditing, from a booted Linux live environment
# (e.g. an Ubuntu "Try Ubuntu" USB) that is connected to Wi-Fi or Ethernet.
#
# It reads this machine's real hardware (CPU / RAM / storage / serial / battery)
# and files it as an audit against the matching device in Als Inventory — matched
# by the asset tag you enter (the label on the device).
#
#   sudo bash hardware-audit.sh
#
# Cosmetic grade and functional test results stay a human judgement — record
# those on the device's page in Als Inventory afterwards.

API_DEFAULT="https://als-inventory-software-production.up.railway.app"

echo "=================================================="
echo "  ALS Inventory — Hardware Audit"
echo "=================================================="

# --- ensure the tools we need are present (needs network) ---
missing=""
for c in curl jq dmidecode lsblk; do
  command -v "$c" >/dev/null 2>&1 || missing="$missing $c"
done
if [ -n "$missing" ]; then
  echo "Installing tools ($missing )…"
  sudo apt-get update -qq >/dev/null 2>&1
  sudo apt-get install -y -qq curl jq dmidecode util-linux smartmontools >/dev/null 2>&1
fi

dmi() { sudo dmidecode -s "$1" 2>/dev/null | grep -v '^#' | head -n1 | sed 's/[[:space:]]*$//'; }

MANUFACTURER=$(dmi system-manufacturer)
MODEL=$(dmi system-product-name)
SERIAL=$(dmi system-serial-number)

CPU=$(lscpu 2>/dev/null | sed -n 's/^Model name:[[:space:]]*//p' | head -n1)
[ -z "$CPU" ] && CPU=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | sed 's/^ //')

MEM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}')
RAM_GB=0
[ -n "$MEM_KB" ] && RAM_GB=$(( (MEM_KB + 512 * 1024) / (1024 * 1024) ))

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

read -rp "Asset tag (the label on this device): " TAG
if [ -z "$TAG" ]; then echo "No tag entered — aborting."; exit 1; fi
read -rp "Als Inventory URL [$API_DEFAULT]: " API
API=${API:-$API_DEFAULT}
read -rp "Your login email: " EMAIL
read -rsp "Your password: " PASSWORD; echo

echo "Signing in…"
TOKEN=$(curl -sS -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg e "$EMAIL" --arg p "$PASSWORD" '{email:$e,password:$p}')" \
  | jq -r '.accessToken // empty')
if [ -z "$TOKEN" ]; then
  echo "Sign-in failed — check the email, password and URL, then re-run."
  exit 1
fi

PAYLOAD=$(jq -n \
  --arg tag "$TAG" --arg man "$MANUFACTURER" --arg mod "$MODEL" --arg ser "$SERIAL" \
  --arg cpu "$CPU" --argjson ram "$RAM_GB" --arg sto "$STORAGE" --arg bat "$BATTERY" '
  {tag: $tag}
  + (if $man != "" then {manufacturer: $man} else {} end)
  + (if $mod != "" then {model: $mod} else {} end)
  + (if $ser != "" then {serialNumber: $ser} else {} end)
  + (if $cpu != "" then {cpu: $cpu} else {} end)
  + (if $ram > 0  then {ramGb: $ram} else {} end)
  + (if $sto != "" then {storageCapacity: $sto} else {} end)
  + (if $bat != "" then {batteryHealth: $bat} else {} end)')

RESP=$(curl -sS -X POST "$API/assets/hardware-audit" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$PAYLOAD")

if [ "$(echo "$RESP" | jq -r '.matched // false')" = "true" ]; then
  echo
  echo "✓ Hardware audit filed for device $(echo "$RESP" | jq -r '.tag')."
  echo "  Finish grading and functional tests on its page in Als Inventory."
else
  echo
  echo "✗ No device found with tag \"$TAG\"."
  echo "  Create/receive it in Als Inventory first, then re-run this tool."
fi
