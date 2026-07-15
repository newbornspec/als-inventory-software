#!/usr/bin/env bash
#
# ALS Inventory — Hardware Audit capture tool
# --------------------------------------------
# Boot the device off a Linux live USB (SystemRescue or Ubuntu), then run:
#   bash hardware-audit.sh
#
# It connects to Wi-Fi automatically, reads a COMPREHENSIVE hardware profile
# (identification, system/BIOS, CPU, memory, per-drive storage + SMART, graphics,
# display, battery, network, security) and files it as an audit INTO the lot you
# selected in the web app ("Set audit target" on the Lots page). It does NOT verify
# anything against a list — it creates/updates the device in that lot.
#
# The profile is sent as a nested JSON object; the server stores it verbatim
# (JSONB), so new fields added here need no backend change.
#
# Preconfigure everything once in an "audit.conf" beside this script:
#   AUDIT_URL, AUDIT_EMAIL, AUDIT_PASSWORD, WIFI_SSID, WIFI_PASSWORD
#
# Tip: run `AUDIT_DEBUG=1 bash hardware-audit.sh` to print the captured JSON
# and exit WITHOUT uploading — handy for checking what a machine reports.

API_DEFAULT="https://als-inventory-software-production.up.railway.app"

# --- load preconfigured settings ---
SELF_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
for conf in "$SELF_DIR/audit.conf" /cdrom/audit.conf /run/archiso/bootmnt/audit.conf ./audit.conf; do
  [ -f "$conf" ] || continue
  # Strip any Windows CRLF endings before sourcing — audit.conf is usually edited
  # on Windows, and a stray carriage return would otherwise end up inside the
  # Wi-Fi password / URL and break the run.
  . <(sed 's/\r$//' "$conf") && break
done
API="${AUDIT_URL:-$API_DEFAULT}"

echo "=================================================="
echo "  ALS Inventory — Hardware Audit"
echo "=================================================="

# --- JSON helpers (no jq dependency) ---
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\r\n\t'; }
jstr() { printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -n1 | sed 's/.*":"//; s/"$//'; }
jraw() { printf '%s' "$1" | grep -o "\"$2\":[^,}]*" | head -n1 | sed 's/.*://; s/[[:space:]]//g'; }

# Build a JSON object incrementally in OB. o_s = string field, o_n = numeric field
# (both skip empty/invalid values so the profile only carries what was read).
OB=""
o_begin() { OB=""; }
o_s() { [ -n "$2" ] || return 0; OB="$OB,\"$1\":\"$(esc "$2")\""; }
o_n() { [ -n "$2" ] || return 0; case "$2" in ''|*[!0-9]*) return 0;; esac; OB="$OB,\"$1\":$2"; }
o_end() { printf '{%s}' "${OB#,}"; }

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

# --- ensure the read tools exist (SystemRescue/Ubuntu ship most already) ---
ensure_tools() {
  command -v curl >/dev/null 2>&1 && command -v dmidecode >/dev/null 2>&1 \
    && command -v lsblk >/dev/null 2>&1 && command -v smartctl >/dev/null 2>&1 \
    && command -v lspci >/dev/null 2>&1 && return 0
  if command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm curl dmidecode util-linux smartmontools pciutils usbutils mokutil >/dev/null 2>&1
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq >/dev/null 2>&1
    apt-get install -y -qq curl dmidecode util-linux smartmontools pciutils usbutils mokutil >/dev/null 2>&1
  fi
}

# --- OPTIONAL, DESTRUCTIVE: securely erase the machine's INTERNAL drives ---
# Runs ONLY when AUDIT_WIPE=1 in audit.conf, AND the operator types WIPE to
# confirm. Every command targets ONE specific device (nvme format / blkdiscard /
# shred) — none can touch another drive — and USB/removable disks are excluded,
# so the boot stick is never at risk. Sets WIPE_STATUS + WIPE_METHOD for the
# upload so the wipe lands on the audit record and the erasure certificate.
WIPE_STATUS=""; WIPE_METHOD=""

# Verification pass: sampled read-back confirming the device now reads as zeros
# at the start, middle and near the end. Returns 0 (verified) or 1 (not clean).
verify_zero() {
  local dev="$1" sz mb offs o n
  sz=$(blockdev --getsize64 "$dev" 2>/dev/null)
  case "$sz" in ''|*[!0-9]*) return 1;; esac
  [ "$sz" -gt 0 ] || return 1
  mb=$(( sz / 1048576 ))
  offs="0"
  [ "$mb" -gt 128 ] && offs="0 $(( mb / 2 )) $(( mb - 32 ))"
  for o in $offs; do
    n=$(dd if="$dev" bs=1M count=32 skip="$o" 2>/dev/null | tr -d '\0' | wc -c | tr -d ' ')
    [ "${n:-1}" = "0" ] || return 1
  done
  return 0
}

wipe_internal_drives() {
  [ "${AUDIT_WIPE:-0}" = "1" ] || return 0

  local disks=() line n t tr rm
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    n=$(pval "$line" NAME); t=$(pval "$line" TYPE); tr=$(pval "$line" TRAN); rm=$(pval "$line" RM)
    [ "$t" = "disk" ] || continue
    [ "$tr" = "usb" ] && continue
    [ "$rm" = "1" ] && continue
    [ "$(cat "/sys/block/$n/removable" 2>/dev/null)" = "1" ] && continue
    disks+=("$n")
  done <<WIPEEOF
$(lsblk -dP -o NAME,TYPE,TRAN,RM 2>/dev/null)
WIPEEOF

  [ "${#disks[@]}" -eq 0 ] && { echo "Data wipe: no internal drive found — skipped."; return 0; }

  echo
  echo "=====================  DATA WIPE  ====================="
  echo "This will PERMANENTLY erase the internal drive(s) below."
  local d
  for d in "${disks[@]}"; do
    printf "   /dev/%-9s %8s  %s\n" "$d" \
      "$(lsblk -dno SIZE "/dev/$d" 2>/dev/null)" "$(lsblk -dno MODEL "/dev/$d" 2>/dev/null)"
  done
  echo "(The USB you booted from is NOT listed and will not be touched.)"
  local ans
  read -rp "Type WIPE to erase, or press Enter to skip: " ans
  [ "$ans" = "WIPE" ] || { echo "Data wipe skipped."; return 0; }

  local all_ok=1 methods="" dev rota m verified
  for d in "${disks[@]}"; do
    dev="/dev/$d"; m=""; verified=0
    rota=$(cat "/sys/block/$d/queue/rotational" 2>/dev/null)
    echo "Erasing $dev …"

    # Fast, type-appropriate erase first.
    case "$d" in
      nvme*)
        command -v nvme >/dev/null 2>&1 && nvme format "$dev" -s 1 --force >/dev/null 2>&1 \
          && m="NVMe secure erase (nvme format)"
        ;;
    esac
    if [ -z "$m" ] && [ "$rota" = "0" ] && command -v blkdiscard >/dev/null 2>&1 \
       && blkdiscard -f "$dev" >/dev/null 2>&1; then
      m="Block discard / TRIM (SSD)"
    fi
    if [ -z "$m" ] && command -v shred >/dev/null 2>&1 \
       && shred -f -n 1 -z "$dev" >/dev/null 2>&1; then
      m="Overwrite — shred 1 pass + zero (NIST Clear)"
    fi

    # Verification pass — confirm the drive reads back as zeros.
    if [ -n "$m" ]; then
      echo "  verifying …"
      if verify_zero "$dev"; then
        verified=1
      elif command -v shred >/dev/null 2>&1 && shred -f -n 1 -z "$dev" >/dev/null 2>&1 && verify_zero "$dev"; then
        # Fast erase didn't read back clean — force a full zero overwrite, re-verify.
        m="Overwrite — shred 1 pass + zero (NIST Clear)"; verified=1
      fi
    fi

    if [ -n "$m" ] && [ "$verified" = "1" ]; then
      echo "  ✓ $m — verified"
      methods="${methods:+$methods; }$m — verified"
    else
      echo "  ✗ FAILED on $dev${m:+ ($m; verification did not pass)}"
      all_ok=0
    fi
  done

  WIPE_METHOD=$(printf '%s' "$methods" | tr ';' '\n' | sed 's/^ *//' | grep -v '^$' | sort -u | paste -sd'; ' -)
  if [ $all_ok -eq 1 ]; then
    WIPE_STATUS="wiped"; echo "Data wipe complete."
  else
    WIPE_STATUS="failed"; echo "Data wipe had failures — recording as FAILED."
  fi
  echo "======================================================"
}

if [ "${AUDIT_DEBUG:-0}" != "1" ]; then
  connect_wifi || exit 1
fi
ensure_tools

# ================= read the hardware profile =================
dmi() { dmidecode -s "$1" 2>/dev/null | grep -v '^#' | head -n1 | sed 's/[[:space:]]*$//'; }
notspecified() { case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
  ''|'not specified'|'to be filled by o.e.m.'|'default string'|'none'|'system serial number'|'0'|'na'|'n/a') return 0;; *) return 1;; esac; }
clean() { notspecified "$1" && printf '' || printf '%s' "$1"; }

# Dell express service code = base-36 value of the 7-char service tag, in decimal.
express_code() {
  local tag n=0 i c d
  tag=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')
  case "$tag" in *[!0-9A-Z]*|'') return 0;; esac
  [ "${#tag}" -ge 5 ] && [ "${#tag}" -le 8 ] || return 0
  for ((i=0;i<${#tag};i++)); do
    c=${tag:$i:1}
    case $c in [0-9]) d=$c;; *) d=$(( $(printf '%d' "'$c") - 55 ));; esac
    n=$(( n*36 + d ))
  done
  printf '%s' "$n"
}

# --- identification (from SMBIOS/DMI — the computer itself, never attached devices) ---
MFR=$(clean "$(dmi system-manufacturer)")
FAMILY=$(clean "$(dmi system-family)")
PRODUCT_NAME=$(clean "$(dmi system-product-name)")
VERSION=$(clean "$(dmi system-version)")
SERIAL=$(clean "$(dmi system-serial-number)")
UUID=$(clean "$(dmi system-uuid)")
ASSET_TAG=$(clean "$(dmi chassis-asset-tag)")
# Friendly model name: Lenovo puts the marketing name ("ThinkPad T440") in
# system-version and a type code in system-product-name; Dell/HP/most others put
# the marketing name ("Latitude 5420") in system-product-name.
case "$(printf '%s' "$MFR" | tr '[:upper:]' '[:lower:]')" in
  *lenovo*) MODEL="${VERSION:-$PRODUCT_NAME}";;
  *) MODEL="${PRODUCT_NAME:-$VERSION}";;
esac
CHASSIS=$(dmidecode --string chassis-type 2>/dev/null | head -n1)
case "$(printf '%s' "$CHASSIS" | tr '[:upper:]' '[:lower:]')" in
  *notebook*|*laptop*|*portable*|*convertible*|*detachable*) DEVICE_TYPE="Laptop";;
  *server*|*rack*|*blade*) DEVICE_TYPE="Server";;
  *workstation*) DEVICE_TYPE="Workstation";;
  *desktop*|*tower*|*mini*|*space*|*"all in one"*|*"all-in-one"*) DEVICE_TYPE="Desktop";;
  *) DEVICE_TYPE="";;
esac
EXPRESS=""
case "$(printf '%s' "$MFR" | tr '[:upper:]' '[:lower:]')" in *dell*) EXPRESS=$(express_code "$SERIAL");; esac

# --- system / BIOS / firmware ---
BIOS_VER=$(clean "$(dmi bios-version)")
BIOS_DATE=$(clean "$(dmi bios-release-date)")
BOOT_MODE=$([ -d /sys/firmware/efi ] && echo "UEFI" || echo "Legacy")
SECURE_BOOT=""
if command -v mokutil >/dev/null 2>&1; then
  SECURE_BOOT=$(mokutil --sb-state 2>/dev/null | grep -io 'enabled\|disabled' | head -n1)
fi
[ -z "$SECURE_BOOT" ] && [ "$BOOT_MODE" = "Legacy" ] && SECURE_BOOT="n/a"
TPM_VER=""
if [ -r /sys/class/tpm/tpm0/tpm_version_major ]; then
  TPM_VER="$(cat /sys/class/tpm/tpm0/tpm_version_major 2>/dev/null).0"
elif [ -e /sys/class/tpm/tpm0 ]; then
  TPM_VER="present"
fi

# --- CPU ---
LSCPU=$(LC_ALL=C lscpu 2>/dev/null)
cpu_val() { printf '%s\n' "$LSCPU" | sed -n "s/^$1:[[:space:]]*//p" | head -n1; }
CPU_MODEL=$(cpu_val 'Model name')
[ -z "$CPU_MODEL" ] && CPU_MODEL=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | sed 's/^ //')
case "$(cpu_val 'Vendor ID')" in *Intel*) CPU_VENDOR="Intel";; *AMD*) CPU_VENDOR="AMD";; *) CPU_VENDOR="";; esac
CPU_SOCKETS=$(cpu_val 'Socket(s)'); CPU_PERCORE=$(cpu_val 'Core(s) per socket'); CPU_ALL=$(cpu_val 'CPU(s)')
CPU_CORES=""; { [ -n "$CPU_SOCKETS" ] && [ -n "$CPU_PERCORE" ]; } && CPU_CORES=$(( CPU_SOCKETS * CPU_PERCORE ))
CPU_THREADS="$CPU_ALL"
CPU_MAXMHZ=$(cpu_val 'CPU max MHz')
CPU_MAX=""; [ -n "$CPU_MAXMHZ" ] && CPU_MAX=$(awk -v m="$CPU_MAXMHZ" 'BEGIN{ if(m+0>0) printf "%.1f GHz", m/1000 }')
CPU_GEN=""
if [ "$CPU_VENDOR" = "Intel" ]; then
  n=$(printf '%s' "$CPU_MODEL" | grep -oE 'i[3579][- ]?[0-9]{4,5}' | grep -oE '[0-9]{4,5}' | head -n1)
  [ -n "$n" ] && [ "${#n}" -gt 3 ] && CPU_GEN="${n%???}th Gen"
fi

# --- memory ---
MEM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}')
RAM_GB=""; [ -n "$MEM_KB" ] && RAM_GB=$(( (MEM_KB + 512*1024) / (1024*1024) ))
MEMT=$(dmidecode -t memory 2>/dev/null)
RAM_TYPE=$(printf '%s\n' "$MEMT" | sed -n 's/^[[:space:]]*Type:[[:space:]]*//p' | grep -iE '^DDR|^LPDDR' | head -n1)
RAM_SPEED=$(printf '%s\n' "$MEMT" | sed -n 's/^[[:space:]]*Speed:[[:space:]]*//p' | grep -iE 'MT/s|MHz' | head -n1)
RAM_SLOTS=$(printf '%s\n' "$MEMT" | grep -c '^Memory Device')
RAM_MODULES=$(printf '%s\n' "$MEMT" | sed -n 's/^[[:space:]]*Size:[[:space:]]*//p' | grep -iE 'MB|GB' | grep -vi 'No Module' | wc -l | tr -d ' ')
# 0 here means dmidecode had nothing to say — omit rather than report "0 slots".
[ "$RAM_SLOTS" = "0" ] && RAM_SLOTS=""
[ "$RAM_MODULES" = "0" ] && RAM_MODULES=""
RAM_MAX_RAW=$(printf '%s\n' "$MEMT" | sed -n 's/^[[:space:]]*Maximum Capacity:[[:space:]]*//p' | head -n1)
RAM_MAX=""
case "$RAM_MAX_RAW" in
  *TB) RAM_MAX=$(( $(printf '%s' "$RAM_MAX_RAW" | grep -oE '[0-9]+') * 1024 ));;
  *GB) RAM_MAX=$(printf '%s' "$RAM_MAX_RAW" | grep -oE '[0-9]+');;
esac

# --- storage (INTERNAL fixed drives only; ignore all external/removable media) ---
# Pull KEY="value" from an lsblk -P line WITHOUT eval. eval would define shell
# vars literally named MODEL/SERIAL and clobber the machine's identity read above
# (lsblk's column names collide with ours) — that mis-identified the PC as its USB
# boot stick. Distinct D_* names + manual parsing keep the two completely separate.
pval() { printf ' %s' "$1" | grep -oE " $2=\"[^\"]*\"" | head -n1 | sed -e "s/^ $2=\"//" -e 's/"$//'; }

STOR_ELEMS=""; SMART_SUMMARY=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  D_NAME=$(pval "$line" NAME); D_TYPE=$(pval "$line" TYPE); D_TRAN=$(pval "$line" TRAN)
  D_RM=$(pval "$line" RM); D_SIZE=$(pval "$line" SIZE); D_MODEL=$(pval "$line" MODEL)
  D_SERIAL=$(pval "$line" SERIAL); D_ROTA=$(pval "$line" ROTA)
  [ "$D_TYPE" = "disk" ] || continue
  # Exclude USB sticks, external HDD/SSD, SD cards and the live boot medium.
  [ "$D_TRAN" = "usb" ] && continue
  [ "$D_RM" = "1" ] && continue
  [ "$(cat "/sys/block/$D_NAME/removable" 2>/dev/null)" = "1" ] && continue
  CAP=""; [ -n "$D_SIZE" ] && CAP=$(awk -v b="$D_SIZE" 'BEGIN{ if(b+0>0) printf "%.0fGB", b/1000000000 }')
  DTYPE=""; IFACE_D=""
  case "$D_NAME" in nvme*) DTYPE="NVMe"; IFACE_D="NVMe";; esac
  if [ -z "$DTYPE" ]; then
    [ "$D_ROTA" = "1" ] && DTYPE="HDD" || DTYPE="SSD"
    case "$D_TRAN" in sata|ata) IFACE_D="SATA";; *) IFACE_D="$D_TRAN";; esac
  fi
  # SMART health report — overall status plus the attributes that matter for
  # grading (drive age + failure indicators). Best-effort parse of smartctl -a,
  # which covers both ATA and NVMe layouts.
  SMART=""; SM_POH=""; SM_PCY=""; SM_REALLOC=""; SM_PENDING=""; SM_USED=""; SM_HEALTH=""
  if command -v smartctl >/dev/null 2>&1; then
    SM=$(smartctl -a "/dev/$D_NAME" 2>/dev/null)
    SMART=$(printf '%s\n' "$SM" | sed -n 's/.*self-assessment test result:[[:space:]]*//p; s/.*SMART Health Status:[[:space:]]*//p' | head -n1 | tr -d ' ')
    SM_POH=$(printf '%s\n' "$SM" | grep -iE 'Power.?[- ]?On.?[- ]?Hours' | grep -oE '[0-9][0-9,]*' | tail -n1 | tr -d ',')
    SM_PCY=$(printf '%s\n' "$SM" | grep -iE 'Power.?[- ]?Cycle' | grep -oE '[0-9][0-9,]*' | tail -n1 | tr -d ',')
    SM_REALLOC=$(printf '%s\n' "$SM" | grep -iE 'Reallocated_Sector' | grep -oE '[0-9]+' | tail -n1)
    SM_PENDING=$(printf '%s\n' "$SM" | grep -iE 'Current_Pending_Sector' | grep -oE '[0-9]+' | tail -n1)
    SM_USED=$(printf '%s\n' "$SM" | grep -iE 'Percentage Used' | grep -oE '[0-9]+' | head -n1)
    # Health % = life remaining. NVMe reports "Percentage Used" (health = 100-used);
    # ATA SSDs expose a normalised wear/life attribute (VALUE column, 100 = new).
    if [ -n "$SM_USED" ]; then
      SM_HEALTH=$(( 100 - SM_USED ))
    else
      hv=$(printf '%s\n' "$SM" | grep -iE 'Media_Wearout_Indicator|SSD_Life_Left|Wear_Leveling_Count|Remaining_Lifetime_Perc' | head -n1 | awk '{print $4}' | grep -oE '^[0-9]+')
      [ -n "$hv" ] && SM_HEALTH=$(( 10#$hv ))
    fi
  fi
  # Show the first drive's health in the on-screen summary so it's easy to confirm.
  [ -z "$SMART_SUMMARY" ] && SMART_SUMMARY="${SMART:-n/a}${SM_HEALTH:+  ${SM_HEALTH}% health}${SM_POH:+  ${SM_POH}h}${SM_REALLOC:+  realloc ${SM_REALLOC}}"
  o_begin
  o_s model "$D_MODEL"; o_s capacity "$CAP"; o_s type "$DTYPE"
  o_s interface "$IFACE_D"; o_s smartStatus "$SMART"; o_s serialNumber "$D_SERIAL"
  o_n healthPct "$SM_HEALTH"; o_n powerOnHours "$SM_POH"; o_n powerCycles "$SM_PCY"
  o_n reallocatedSectors "$SM_REALLOC"; o_n pendingSectors "$SM_PENDING"; o_n ssdLifeUsedPct "$SM_USED"
  STOR_ELEMS="$STOR_ELEMS,$(o_end)"
done <<STOREOF
$(lsblk -bdP -o NAME,TYPE,TRAN,RM,SIZE,MODEL,SERIAL,ROTA 2>/dev/null)
STOREOF
STORAGE="[${STOR_ELEMS#,}]"

# --- graphics ---
GFX_ELEMS=""
while IFS= read -r l; do
  [ -z "$l" ] && continue
  vend=$(printf '%s' "$l" | awk -F'"' '{print $4}')
  dev=$(printf '%s' "$l" | awk -F'"' '{print $6}')
  case "$vend" in *Intel*) vend="Intel"; gtype="Integrated";;
    *NVIDIA*) vend="NVIDIA"; gtype="Dedicated";;
    *Advanced\ Micro*|*AMD*|*ATI*) vend="AMD"; gtype="";;
    *) gtype="";; esac
  o_begin; o_s manufacturer "$vend"; o_s model "$dev"; o_s type "$gtype"
  GFX_ELEMS="$GFX_ELEMS,$(o_end)"
done <<GFXEOF
$(lspci -mm 2>/dev/null | grep -iE '"(VGA compatible controller|3D controller|Display controller)"')
GFXEOF
GRAPHICS="[${GFX_ELEMS#,}]"

# --- display (best-effort EDID; often blank on a headless live boot) ---
DISP_RES=""; DISP_SIZE=""
if command -v edid-decode >/dev/null 2>&1; then
  for e in /sys/class/drm/*/edid; do
    [ -s "$e" ] || continue
    dec=$(edid-decode "$e" 2>/dev/null)
    DISP_RES=$(printf '%s\n' "$dec" | grep -oE 'DTD [0-9]+:[[:space:]]*[0-9]+x[0-9]+' | grep -oE '[0-9]+x[0-9]+' | head -n1)
    DISP_SIZE=$(printf '%s\n' "$dec" | sed -n 's/.*Maximum image size:[[:space:]]*//p' | head -n1)
    [ -n "$DISP_RES" ] && break
  done
fi

# --- battery ---
BAT_HEALTH=""; BAT_DESIGN=""; BAT_FULL=""; BAT_CYCLES=""; BAT_STATUS=""
for b in /sys/class/power_supply/BAT*; do
  [ -e "$b" ] || continue
  ef=$(cat "$b/energy_full" 2>/dev/null); efd=$(cat "$b/energy_full_design" 2>/dev/null)
  full=${ef:-$(cat "$b/charge_full" 2>/dev/null)}
  design=${efd:-$(cat "$b/charge_full_design" 2>/dev/null)}
  { [ -n "$full" ] && [ -n "$design" ] && [ "$design" -gt 0 ] 2>/dev/null; } && BAT_HEALTH="$(( full*100/design ))%"
  [ -n "$ef" ]  && BAT_FULL=$(awk -v v="$ef" 'BEGIN{printf "%.0f Wh", v/1000000}')
  [ -n "$efd" ] && BAT_DESIGN=$(awk -v v="$efd" 'BEGIN{printf "%.0f Wh", v/1000000}')
  BAT_CYCLES=$(cat "$b/cycle_count" 2>/dev/null)
  BAT_STATUS=$(cat "$b/status" 2>/dev/null)
  break
done
[ "$BAT_CYCLES" = "0" ] && BAT_CYCLES=""
[ -z "$DEVICE_TYPE" ] && { [ -n "$BAT_HEALTH" ] && DEVICE_TYPE="Laptop" || DEVICE_TYPE="Desktop"; }

# --- network ---
NET_ETH=$(lspci -mm 2>/dev/null | grep -i '"Ethernet controller"' | awk -F'"' '{print $6}' | head -n1)
NET_WIFI=$(lspci -mm 2>/dev/null | grep -i '"Network controller"' | awk -F'"' '{print $6}' | head -n1)
NET_BT=""
command -v lsusb >/dev/null 2>&1 && NET_BT=$(lsusb 2>/dev/null | grep -i bluetooth | sed 's/.*ID [0-9a-fA-F:]*[[:space:]]*//' | head -n1)
NET_MAC=""
for n in /sys/class/net/*; do
  ifn=$(basename "$n")
  case "$ifn" in lo|wl*|ww*) continue;; esac
  [ -r "$n/address" ] && NET_MAC=$(cat "$n/address" 2>/dev/null) && break
done

# ================= assemble the profile JSON =================
o_begin
o_s manufacturer "$MFR"; o_s model "$MODEL"; o_s productName "$PRODUCT_NAME"
o_s productFamily "$FAMILY"; o_s deviceType "$DEVICE_TYPE"
o_s serialNumber "$SERIAL"; o_s serviceTag "$SERIAL"
o_s expressServiceCode "$EXPRESS"; o_s biosUuid "$UUID"; o_s assetTag "$ASSET_TAG"
IDENT=$(o_end)

o_begin
o_s biosVersion "$BIOS_VER"; o_s biosReleaseDate "$BIOS_DATE"; o_s bootMode "$BOOT_MODE"
o_s secureBoot "$SECURE_BOOT"; o_s tpmVersion "$TPM_VER"
SYSTEM=$(o_end)

o_begin
o_s manufacturer "$CPU_VENDOR"; o_s model "$CPU_MODEL"; o_s generation "$CPU_GEN"
o_n cores "$CPU_CORES"; o_n threads "$CPU_THREADS"; o_s maxClock "$CPU_MAX"
CPU=$(o_end)

o_begin
o_n totalGb "$RAM_GB"; o_s type "$RAM_TYPE"; o_s speed "$RAM_SPEED"
o_n modules "$RAM_MODULES"; o_n slots "$RAM_SLOTS"; o_n maxGb "$RAM_MAX"
MEMORY=$(o_end)

o_begin
o_s size "$DISP_SIZE"; o_s resolution "$DISP_RES"
DISPLAY=$(o_end)

o_begin
o_s health "$BAT_HEALTH"; o_s designCapacity "$BAT_DESIGN"; o_s fullChargeCapacity "$BAT_FULL"
o_n cycleCount "$BAT_CYCLES"; o_s status "$BAT_STATUS"
BATTERY=$(o_end)

o_begin
o_s ethernet "$NET_ETH"; o_s wifi "$NET_WIFI"; o_s bluetooth "$NET_BT"; o_s macAddress "$NET_MAC"
NETWORK=$(o_end)

o_begin
o_s tpm "$TPM_VER"; o_s secureBoot "$SECURE_BOOT"
SECURITY=$(o_end)

# Join non-empty sections into the profile.
PB=""
p_obj() { [ "$2" = "{}" ] || [ "$2" = "[]" ] && return 0; PB="$PB,\"$1\":$2"; }
p_obj identification "$IDENT"
p_obj system "$SYSTEM"
p_obj cpu "$CPU"
p_obj memory "$MEMORY"
p_obj storage "$STORAGE"
p_obj graphics "$GRAPHICS"
p_obj display "$DISPLAY"
p_obj battery "$BATTERY"
p_obj network "$NETWORK"
p_obj security "$SECURITY"
PROFILE="{${PB#,}}"

# ================= summary =================
echo
echo "Detected on this machine:"
printf "  %-14s %s\n" "Device"   "${MFR:-?} ${MODEL:-?} (${DEVICE_TYPE:-?})"
printf "  %-14s %s\n" "Serial"   "${SERIAL:-?}${EXPRESS:+  ·  express $EXPRESS}"
printf "  %-14s %s\n" "CPU"      "${CPU_MODEL:-?} — ${CPU_CORES:-?}C/${CPU_THREADS:-?}T"
printf "  %-14s %s\n" "RAM"      "${RAM_GB:-?} GB ${RAM_TYPE} ${RAM_SPEED}"
printf "  %-14s %s\n" "Storage"  "$(printf '%s' "$STORAGE" | grep -oE '"capacity":"[^"]*"' | sed 's/.*://; s/"//g' | paste -sd', ' -)"
printf "  %-14s %s\n" "Drive health" "${SMART_SUMMARY:-n/a}"
printf "  %-14s %s\n" "Battery"  "${BAT_HEALTH:-n/a}"
printf "  %-14s %s\n" "TPM/Boot" "${TPM_VER:-none} / ${BOOT_MODE} ${SECURE_BOOT:+(SecureBoot $SECURE_BOOT)}"
echo

if [ "${AUDIT_DEBUG:-0}" = "1" ]; then
  echo "--- captured JSON (debug; not uploaded) ---"
  printf '%s\n' "$PROFILE"
  exit 0
fi

# ================= login + target + upload =================
[ -z "${AUDIT_EMAIL:-}" ] && read -rp "Login email: " AUDIT_EMAIL
[ -z "${AUDIT_PASSWORD:-}" ] && { read -rsp "Password: " AUDIT_PASSWORD; echo; }

echo "Signing in…"
LOGIN=$(curl -sS -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$(esc "$AUDIT_EMAIL")\",\"password\":\"$(esc "$AUDIT_PASSWORD")\"}")
TOKEN=$(jstr "$LOGIN" accessToken)
[ -z "$TOKEN" ] && { echo "Sign-in failed — check audit.conf (email/password/URL)."; exit 1; }

# Which lot to file this device into? Pick from the pre-created lots on the
# server. Defaults to the web-set audit target, so a run of machines into one lot
# is just Enter each time — and you can switch lot per machine here without
# touching the web app.
TARGET=$(curl -sS "$API/devices/audit-target" -H "Authorization: Bearer $TOKEN")
DEFAULT_ID=$(jstr "$TARGET" batchId); DEFAULT_NUM=$(jstr "$TARGET" batchNumber)

# Parse the compact [{id,batchNumber}] list. Each object has exactly one "id" and
# one "batchNumber", in that order, so pulling each field in document order gives
# two index-aligned arrays (portable — no reliance on sed \n in the replacement).
LOTS=$(curl -sS "$API/devices/lots" -H "Authorization: Bearer $TOKEN")
mapfile -t LOT_IDS  < <(printf '%s' "$LOTS" | grep -oE '"id":"[^"]*"'          | sed 's/"id":"//; s/"$//')
mapfile -t LOT_NUMS < <(printf '%s' "$LOTS" | grep -oE '"batchNumber":"[^"]*"' | sed 's/"batchNumber":"//; s/"$//')

if [ "${#LOT_IDS[@]}" -eq 0 ]; then
  echo
  echo "No lots found. Create one in Als Inventory → Lots → New Lot, then re-run."
  exit 1
fi

echo
echo "Available lots:"
for j in "${!LOT_NUMS[@]}"; do
  mark=""; [ "${LOT_IDS[$j]}" = "$DEFAULT_ID" ] && mark="  ← current audit target"
  printf "  %2d) %s%s\n" "$((j + 1))" "${LOT_NUMS[$j]}" "$mark"
done
read -rp "File this device into which lot? [number${DEFAULT_NUM:+, or Enter for $DEFAULT_NUM}] " sel
if [ -z "$sel" ]; then
  CHOSEN_ID="$DEFAULT_ID"; CHOSEN_NUM="$DEFAULT_NUM"
else
  CHOSEN_ID="${LOT_IDS[$((sel - 1))]:-}"; CHOSEN_NUM="${LOT_NUMS[$((sel - 1))]:-}"
fi
[ -z "$CHOSEN_ID" ] && { echo "No lot selected. Cancelled."; exit 1; }

# Optional: drop it into a sub-lot (spec bucket) within the chosen lot.
CHOSEN_SUB_ID=""; CHOSEN_SUB_NUM=""
SUBS=$(curl -sS "$API/lots?batchId=$CHOSEN_ID" -H "Authorization: Bearer $TOKEN")
mapfile -t SUB_IDS  < <(printf '%s' "$SUBS" | grep -oE '"id":"[^"]*"'        | sed 's/"id":"//; s/"$//')
mapfile -t SUB_NUMS < <(printf '%s' "$SUBS" | grep -oE '"lotNumber":"[^"]*"' | sed 's/"lotNumber":"//; s/"$//')
if [ "${#SUB_IDS[@]}" -gt 0 ]; then
  echo "Sub-lots in ${CHOSEN_NUM}:    0) none"
  for j in "${!SUB_NUMS[@]}"; do printf "  %2d) %s\n" "$((j + 1))" "${SUB_NUMS[$j]}"; done
  read -rp "Sub-lot? [number, or Enter for none] " ssel
  if [ -n "$ssel" ] && [ "$ssel" != "0" ]; then
    CHOSEN_SUB_ID="${SUB_IDS[$((ssel - 1))]:-}"; CHOSEN_SUB_NUM="${SUB_NUMS[$((ssel - 1))]:-}"
  fi
fi

read -rp "Start audit into ${CHOSEN_NUM}${CHOSEN_SUB_NUM:+ / $CHOSEN_SUB_NUM}? [Y/n] " GO
case "${GO:-Y}" in [nN]*) echo "Cancelled."; exit 0 ;; esac

# Destructive data wipe (only if AUDIT_WIPE=1 and the operator confirms).
wipe_internal_drives

BODY="{\"lotId\":\"$CHOSEN_ID\""
[ -n "$CHOSEN_SUB_ID" ] && BODY="$BODY,\"subLotId\":\"$CHOSEN_SUB_ID\""
[ -n "$WIPE_STATUS" ] && BODY="$BODY,\"dataWipeStatus\":\"$WIPE_STATUS\",\"dataWipeMethod\":\"$(esc "$WIPE_METHOD")\""
BODY="$BODY,\"profile\":$PROFILE}"

RESP=$(curl -sS -X POST "$API/devices/hardware-audit" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$BODY")

if [ -n "$(jstr "$RESP" assetId)" ]; then
  VERB=$([ "$(jraw "$RESP" created)" = "true" ] && echo "added to" || echo "re-audited in")
  echo
  echo "✓ $(jstr "$RESP" name) ($(jstr "$RESP" tag)) $VERB $(jstr "$RESP" lot)."
  [ -n "$WIPE_STATUS" ] && echo "  Data wipe: $WIPE_STATUS — $WIPE_METHOD"
  exit 0
else
  echo
  echo "✗ Upload failed: $(jstr "$RESP" message)"
  exit 1
fi
