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

# The version of THIS TOOL, stamped on every wipe result so a certificate can
# name the software that did the erasure. Bump it when the wipe behaviour
# changes. NOT to be confused with VERSION further down, which is the AUDITED
# machine's DMI system-version (e.g. "ThinkPad T440").
ALS_TOOL_VERSION="2026.09.19"

# --- privilege warning -------------------------------------------------------
# SystemRescue boots you in as root, so this never came up. The Ubuntu stick
# does not, and almost every lock check reads something only root can read:
# the ACPI tables (0400), efivars, the Windows partition mount, blkid. Those
# checks report UNKNOWN rather than guessing, but the operator should be told
# BEFORE the audit runs, not left to notice a page of UNKNOWNs afterwards.
if [ "$(id -u 2>/dev/null)" != "0" ]; then
  echo
  echo "  !!  NOT RUNNING AS ROOT"
  echo "      The device lock checks (Autopilot, MDM, BIOS password, Absolute,"
  echo "      Secure Boot, BitLocker) cannot read what they need and will all"
  echo "      report UNKNOWN. They will NOT report the machine as clear."
  echo "      Stop and re-run with:   sudo bash $0"
  echo
fi


# --- load preconfigured settings ---
SELF_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
# On Ubuntu the tools live on a second, writable partition that the live system
# mounts wherever it likes, so the media is found by label rather than by a
# hardcoded archiso path. Falls back silently when the helper is absent.
ALS_MEDIA=""
[ -r "$SELF_DIR/find-media.sh" ] && { . "$SELF_DIR/find-media.sh"; ALS_MEDIA=$(als_find_media 2>/dev/null); }
for conf in "$SELF_DIR/audit.conf" "${ALS_MEDIA:-/nonexistent}/audit.conf"             /cdrom/audit.conf /run/archiso/bootmnt/audit.conf ./audit.conf; do
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
# esc() drops EVERY control character (0x00-0x1F and DEL), not just CR/LF/TAB.
# JSON forbids raw control characters inside a string, and DMI, SMART and lsblk
# strings come from firmware: one stray byte (an ESC in a vendor string, a 0x01
# pad in a serial) made the whole profile or WIPE_RESULT unparseable, so the
# machine or the wipe had no record at all. Must stay a one-liner: the lock
# check tests extract this exact line.
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037\177'; }
jstr() { printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -n1 | sed 's/.*":"//; s/"$//'; }
jraw() { printf '%s' "$1" | grep -o "\"$2\":[^,}]*" | head -n1 | sed 's/.*://; s/[[:space:]]//g'; }

# Build a JSON object incrementally in OB. o_s = string field, o_n = numeric field
# (both skip empty/invalid values so the profile only carries what was read).
OB=""
o_begin() { OB=""; }
o_s() { [ -n "$2" ] || return 0; OB="$OB,\"$1\":\"$(esc "$2")\""; }
o_n() { [ -n "$2" ] || return 0; case "$2" in ''|*[!0-9]*) return 0;; esac; OB="$OB,\"$1\":$2"; }
# o_s0 = string field that is kept even when empty (a field a reader relies on
# always being there, e.g. WIPE_RESULT's "reason"). o_raw = an already-built
# JSON value (true/false, or a nested object made with o_begin..o_end first and
# saved to a variable - o_* share one buffer, so build the inner object BEFORE
# o_begin of the outer one).
o_s0() { OB="$OB,\"$1\":\"$(esc "$2")\""; }
o_raw() { [ -n "$2" ] || return 0; OB="$OB,\"$1\":$2"; }
o_end() { printf '{%s}' "${OB#,}"; }

# Reachability, with enough patience for a cold boot.
#
# This was one curl with a 6-second budget, which is tight for the FIRST TLS
# handshake on a freshly booted live USB: no DNS cache, no session to resume,
# and on a network that advertises IPv6 without it working, curl spends the
# whole budget on the v6 attempt before it would ever fall back. The machine
# then reports the server unreachable while its network is perfectly fine.
#
# So: a longer budget, a separate connect timeout, and an explicit IPv4 retry
# rather than waiting for a fallback that never gets the time to happen.
online() {
  # Reachability WITHOUT depending on any one binary being installed.
  #
  # This used to be a single curl. SystemRescue ships curl, so it always worked;
  # Ubuntu Desktop's live image does NOT, and every run reported "server
  # unreachable" on a machine whose network was provably fine — right address,
  # right default route, ping to 1.1.1.1 fine, DNS resolving. The failure was
  # `curl: command not found`, exit 127, and the check reported it as the server
  # being down. Two rounds of diagnosis went into the network as a result.
  #
  # Ordering matters too: the tool that INSTALLS curl runs after this check, so
  # a curl-only probe can never bootstrap itself on an image without it.
  #
  # So: curl if present, else wget, else bash's own /dev/tcp, which is a shell
  # builtin and needs nothing installed at all.
  local host port
  if command -v curl >/dev/null 2>&1; then
    curl -s --connect-timeout 5 --max-time 12 -o /dev/null "$API" 2>/dev/null && return 0
    # Some networks advertise IPv6 that does not work; curl spends the whole
    # budget on it before it would fall back. Ask for v4 explicitly.
    curl -s -4 --connect-timeout 5 --max-time 12 -o /dev/null "$API" 2>/dev/null && return 0
    return 1
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -q -T 12 -t 1 --spider "$API" 2>/dev/null && return 0
    return 1
  fi
  # Last resort: a raw TCP connect using the shell itself. This proves the
  # server is reachable, which is all this function is asked to decide.
  host=$(printf '%s' "$API" | sed -e 's#^https\?://##' -e 's#/.*##' -e 's#:.*##')
  case "$API" in https://*) port=443 ;; *) port=80 ;; esac
  [ -n "$host" ] || return 1
  (exec 3<>"/dev/tcp/$host/$port") >/dev/null 2>&1 && return 0
  return 1
}

# One HTTP client, whichever binary this image happens to have.
#
# online() already falls back curl -> wget -> /dev/tcp, but it only has to
# decide whether the server ANSWERS. The five calls below need the response
# BODY, and /dev/tcp cannot speak TLS, so the ladder here is curl -> wget and
# then an honest failure.
#
# Without this, an image with no curl reported "Sign-in failed - check
# audit.conf (email/password/URL)": curl exited 127, $LOGIN was empty, no token
# came out, and the operator was sent to re-check a password that was never the
# problem. Same shape as the "server unreachable" bug that online() was
# hardened for, and it survives in the one place that actually files the audit.
#
# Request bodies go through a 0600 temp FILE, never the command line.
# /proc/<pid>/cmdline is world-readable and the login body carries the account
# password, so passing it as an argument publishes it to every process on the
# machine for as long as the request runs.
HTTP_CLIENT=""
http_client() {
  if [ -z "$HTTP_CLIENT" ]; then
    if command -v curl >/dev/null 2>&1; then HTTP_CLIENT=curl
    elif command -v wget >/dev/null 2>&1; then HTTP_CLIENT=wget
    else HTTP_CLIENT=none
    fi
  fi
  printf '%s' "$HTTP_CLIENT"
}

http_missing() {
  echo "  Neither curl nor wget is installed, so the server cannot be contacted."
  echo "  This is NOT a credentials or network problem."
  echo "  Re-run with sudo so the audit can install them, or install by hand:"
  echo "      sudo apt-get install -y curl"
}

# http_get URL [header ...]
http_get() {
  local url="$1"; shift
  local h; local args=()
  case "$(http_client)" in
    curl) for h in "$@"; do args+=(-H "$h"); done
          curl -sS --max-time 30 "${args[@]}" "$url" ;;
    wget) for h in "$@"; do args+=(--header="$h"); done
          wget -q -O - --content-on-error --timeout=30 --tries=1 "${args[@]}" "$url" ;;
    *)    return 127 ;;
  esac
}

# http_post URL BODY [header ...]
http_post() {
  local url="$1" body="$2"; shift 2
  local h f rc; local args=()
  [ "$(http_client)" = none ] && return 127
  f=$(mktemp 2>/dev/null) || return 127
  chmod 600 "$f" 2>/dev/null
  printf '%s' "$body" > "$f"
  case "$(http_client)" in
    curl) for h in "$@"; do args+=(-H "$h"); done
          curl -sS --max-time 60 -X POST "${args[@]}" --data-binary "@$f" "$url" ;;
    wget) for h in "$@"; do args+=(--header="$h"); done
          wget -q -O - --content-on-error --timeout=60 --tries=1 \
               --post-file="$f" "${args[@]}" "$url" ;;
  esac
  rc=$?
  rm -f "$f"
  return $rc
}

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

# --- Ethernet ---------------------------------------------------------------
# Nothing else in the boot path requests a DHCP lease, so plugging in a cable
# does nothing on its own. Bring wired links up and lease an address ourselves.
# Ethernet is tried BEFORE Wi-Fi: no credentials, and it is what an operator
# reaches for when Wi-Fi fails.
has_cmd() { command -v "$1" >/dev/null 2>&1; }

iface_ip() { ip -4 addr show "$1" 2>/dev/null | grep -o 'inet [0-9.]*' | head -n1 | cut -d' ' -f2; }

wired_ifaces() {
  for n in /sys/class/net/*; do
    [ -e "$n" ] || continue
    i=$(basename "$n")
    case "$i" in lo|veth*|docker*|br-*|virbr*|tun*|tap*|bond*|dummy*) continue ;; esac
    [ -e "$n/wireless" ] && continue        # that one is the Wi-Fi adapter
    echo "$i"
  done
}

# Try each DHCP client this live image might ship, checking for an address after
# each one rather than trusting exit codes (they vary between clients).
dhcp_lease() {
  has_cmd nmcli    && nmcli device connect "$1" >/dev/null 2>&1
  [ -n "$(iface_ip "$1")" ] && return 0
  has_cmd dhcpcd   && dhcpcd -w -t 12 "$1" >/dev/null 2>&1
  [ -n "$(iface_ip "$1")" ] && return 0
  has_cmd dhclient && dhclient -1 "$1" >/dev/null 2>&1
  [ -n "$(iface_ip "$1")" ] && return 0
  has_cmd udhcpc   && udhcpc -i "$1" -n -q -t 4 >/dev/null 2>&1
  [ -n "$(iface_ip "$1")" ]
}

connect_wired() {
  for i in $(wired_ifaces); do ip link set "$i" up 2>/dev/null; done
  sleep 2                                   # let the link/carrier settle
  for i in $(wired_ifaces); do
    [ "$(cat "/sys/class/net/$i/carrier" 2>/dev/null)" = "1" ] || continue
    echo "Ethernet $i: cable detected — requesting an address…"
    [ -n "$(iface_ip "$i")" ] || dhcp_lease "$i"
    for _ in 1 2 3 4 5 6 7 8; do
      online && { echo "Connected via Ethernet ($i, $(iface_ip "$i"))."; return 0; }
      sleep 2
    done
  done
  return 1
}

# Say what is actually wrong instead of always blaming Wi-Fi. The GUI shows the
# last two lines, so the summary goes last.
net_diagnose() {
  # Diagnose by LAYER, in order, and stop guessing. The previous version checked
  # an address and a name and then said "unreachable", which is the least useful
  # true statement available: it sent us hunting a network fault on a machine
  # whose network was fine.
  #
  # In particular DNS succeeding proves almost nothing. Resolving a name only
  # needs to reach the router on the local subnet, which is on-link — it works
  # perfectly with NO DEFAULT ROUTE AT ALL. "DNS: ok" alongside "unreachable"
  # is exactly the signature of a missing or broken default route.
  eth_state="no cable detected"
  for i in $(wired_ifaces); do
    if [ "$(cat "/sys/class/net/$i/carrier" 2>/dev/null)" = "1" ]; then
      ipa=$(iface_ip "$i")
      if [ -n "$ipa" ]; then eth_state="$i has IP $ipa"
      else eth_state="$i cable is in, but no IP address (DHCP gave none)"; fi
      break
    fi
  done
  echo "Network check:"
  echo "  1. link/address : $eth_state"

  # 2. Is there a way OUT of this subnet, and through which interface? A failed
  #    Wi-Fi attempt can leave the default route on a dead wireless interface
  #    while Ethernet sits there working.
  gw=$(ip route show default 2>/dev/null | head -n1)
  if [ -n "$gw" ]; then
    echo "  2. default route: $gw"
  else
    echo "  2. default route: NONE — this machine has an address but no way out"
    echo "     of its own subnet. DNS may still work (the router is on-link),"
    echo "     which is why this looks like a server problem and is not one."
  fi

  # 3. Raw IP reachability, no DNS and no TLS involved. This separates routing
  #    from name resolution from certificates.
  if has_cmd ping && ping -c1 -W3 1.1.1.1 >/dev/null 2>&1; then
    echo "  3. internet     : reachable (ping 1.1.1.1 ok)"
  else
    echo "  3. internet     : NOT reachable by IP — routing or upstream is down"
  fi

  host=$(printf '%s' "$API" | sed -e 's#^https\?://##' -e 's#/.*##')
  if has_cmd getent; then
    if getent hosts "$host" >/dev/null 2>&1; then
      echo "  4. DNS          : resolves $host (note: proves only that the local resolver answered)"
    else
      echo "  4. DNS          : FAILED to resolve $host"
    fi
  else
    echo "  4. DNS          : not checked"
  fi

  # 5. The actual request, with curl's own reason rather than a shrug.
  #
  # This step is built on curl's exit codes, so it needs curl to exist. On an
  # image without it the case below fell through to "server: curl exit 127",
  # which reads as a server fault and is the opposite of the truth. Say it
  # plainly instead, and still answer the actual question with wget.
  if ! command -v curl >/dev/null 2>&1; then
    echo "  5. server       : not tested - curl is not installed on this image."
    echo "                    This is a MISSING TOOL, not a server or network fault."
    if command -v wget >/dev/null 2>&1; then
      if wget -q -T 10 -t 1 --spider "$API" 2>/dev/null; then
        echo "                    wget does reach $API - the server is up."
      else
        echo "                    wget cannot reach $API either."
      fi
    fi
    echo "                    Install it with:  sudo apt-get install -y curl"
    curl_rc=""
  else
  curl_err=$(curl -sS --max-time 10 -o /dev/null "$API" 2>&1)
  curl_rc=$?
  case "$curl_rc" in
    0)  echo "  5. server       : reachable now — the earlier failure was timing. Retry." ;;
    6)  echo "  5. server       : cannot resolve $host" ;;
    7)  echo "  5. server       : no route / connection refused" ;;
    28) echo "  5. server       : timed out — an address, but no working route out" ;;
    35|51|58|59|60|77|83)
        # Common on second-hand hardware: a flat CMOS battery leaves the clock
        # years out, every certificate reads "not yet valid", and HTTPS fails
        # while DNS keeps working.
        echo "  5. server       : TLS/certificate failure (curl $curl_rc)"
        echo "     $curl_err"
        echo "     CHECK THE CLOCK — this machine says: $(date)"
        echo "     Fix:  sudo timedatectl set-ntp true"
        echo "           sudo date -s 'YYYY-MM-DD HH:MM:SS'"
        ;;
    *)  echo "  5. server       : curl exit $curl_rc — $curl_err" ;;
  esac
  fi

  yr=$(date +%Y 2>/dev/null)
  case "$yr" in
    ''|*[!0-9]*) : ;;
    *) if [ "$yr" -lt 2025 ] || [ "$yr" -gt 2100 ]; then
         echo "  !  the clock reads $(date) — almost certainly wrong, and that alone breaks HTTPS."
       fi ;;
  esac

  echo "Could not reach $API."
  [ -z "$gw" ] && echo "Most likely: no default route. Try  sudo dhclient -v $i  or reconnect Ethernet in Settings."
}

# Bring up whatever is available: already-online → Ethernet → Wi-Fi.
connect_network() {
  online && return 0
  connect_wired && return 0
  connect_wifi && online && return 0
  net_diagnose
  return 1
}

# --- ensure the read tools exist (SystemRescue/Ubuntu ship most already) ---
ensure_tools() {
  # Called TWICE on purpose — see the call sites. Once before the network is
  # brought up, in case this image already has connectivity (Ubuntu's live
  # session gets DHCP on its own), and once after, to fetch whatever is still
  # missing. Neither call is allowed to be fatal.
  #
  # curl is the one that matters most: the upload uses it, and Ubuntu Desktop's
  # live image does not ship it. It used to be installed only AFTER the network
  # check that needed it, which is a deadlock on any image without it.
  command -v curl >/dev/null 2>&1 && command -v dmidecode >/dev/null 2>&1 \
    && command -v lsblk >/dev/null 2>&1 && command -v smartctl >/dev/null 2>&1 \
    && command -v lspci >/dev/null 2>&1 && return 0

  # hivex and ntfs-3g are for the device-lock checks: Autopilot, Intune and
  # Entra state live in the Windows registry, so without them those three
  # checks can only ever report UNKNOWN. tpm2-tools reads TPM ownership.
  # Say something first. This installs ten packages with all output suppressed,
  # and on a fresh live image over warehouse Wi-Fi it can sit here for minutes
  # immediately after the banner with nothing on screen. An operator watching a
  # dead terminal reasonably concludes it has hung and presses Ctrl-C.
  echo "Installing tools this live image is missing (first run only, needs internet)…"
  if command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm curl dmidecode util-linux smartmontools pciutils usbutils mokutil \
      hivex ntfs-3g tpm2-tools >/dev/null 2>&1
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq >/dev/null 2>&1
    apt-get install -y -qq curl dmidecode util-linux smartmontools pciutils usbutils mokutil \
      libhivex-bin ntfs-3g tpm2-tools >/dev/null 2>&1
  fi
  return 0
}

# --- DESTRUCTIVE: the erase helpers behind gui_wipe_one ---------------------
# Every command below targets ONE specific device (nvme / hdparm / shred) - none
# can touch another drive. The only caller is gui_wipe_one (the kiosk's
# per-drive wipe, `--wipe-drive`), which refuses USB, removable, boot and
# pseudo devices before any of these run. The text-mode wipe that used to call
# them too was retired - see wipe_internal_drives.

# --- read-back verification: does the drive still hold what it held? ---------
#
# A firmware erase used to be verified by asking whether the drive now read as
# ZEROS - and when it did not, the result was recorded anyway as
# "confirmed by the controller", on its own word. A crypto erase SHOULD read
# back as random (the old key is gone, the ciphertext stays), so that branch
# existed for a real reason; but it also passed, byte for byte the same, a
# controller that answered "done" and changed nothing. That drive got a
# certificate saying its data was unrecoverable while the customer's partition
# table, NTFS volume and files were still there to be read.
#
# So the read-back now asks the question that matters: is any of the OLD data
# still recognisable? verify_erased reads bounded windows of the drive with
# O_DIRECT (the first MiB, eight spread across the device, the last MiB, and a
# MiB at every partition start recorded BEFORE the erase) and hands each one to
# a small python3 checker (als_verify_py) that:
#   - hard-fails on any on-disk structure signature: the 0x55AA boot signature
#     at byte 510, "EFI PART" (primary GPT at LBA 1 for 512 or 4096 byte
#     sectors, and the backup at the last LBA), NTFS, BitLocker (-FVE-FS-),
#     FAT/exFAT, LUKS, ext2/3/4, XFS, Btrfs, APFS and swap - at the start of
#     the disk and at every saved partition start. An erase that worked leaves
#     none of them; a controller that lied leaves all of them.
#   - after a FIRMWARE method, accepts content that is all zeros, all 0xFF, a
#     short repeated vendor fill, or high-entropy (ciphertext after a crypto
#     erase), judged per 4 KiB. Anything else looks like data and fails.
#   - after an OVERWRITE, accepts nothing but zeros (the last pass wrote them).
# Returns 0 = clean, 1 = old data found, 2 = could not verify (a short or failed
# read, the device gone, no python3). Sets VE_WHY (the finding or the reason),
# VE_LABEL (what the clean drive read as: zeros, 0xFF, random, pattern, or a
# "+"-joined mix) and VE_MIB (MiB read). Owner decision D31 (reversible): a
# drive that could not be verified is recorded as failed, never as wiped.
#
# What it cannot see: data that is already high-entropy (compressed or
# encrypted files) sitting in the middle of the drive between the windows
# looks the same as ciphertext. The signature checks at every saved partition
# start are what catch the lying controller; the content check catches the
# rest of what it reads.
#
# The checker is printed by a function (not kept in a variable) so the tests
# can extract and run exactly this code. Keep every python line from starting
# with "}" - the tests' extractor ends a function at the first such line.
als_verify_py() {
  cat <<'PYEOF'
import sys, math
from collections import Counter

def u32(b, o):
    return int.from_bytes(b[o:o + 4], "little")

def u64(b, o):
    return int.from_bytes(b[o:o + 8], "little")

# (what it is, offset from the start of the structure, the magic bytes)
# The bare 0x55AA is last: every NTFS/FAT/BitLocker boot sector carries it
# too, and the finding should name the volume, not just "a boot sector".
SIGS = [
    ("GPT header (EFI PART)", 512, b"EFI PART"),
    ("GPT header (EFI PART, 4K sectors)", 4096, b"EFI PART"),
    ("NTFS boot sector", 3, b"NTFS    "),
    ("BitLocker boot sector (-FVE-FS-)", 3, b"-FVE-FS-"),
    ("exFAT boot sector", 3, b"EXFAT   "),
    ("FAT boot sector", 54, b"FAT12   "),
    ("FAT boot sector", 54, b"FAT16   "),
    ("FAT boot sector", 54, b"FAT     "),
    ("FAT32 boot sector", 82, b"FAT32   "),
    ("LUKS header", 0, b"LUKS\xba\xbe"),
    ("LUKS2 secondary header", 16384, b"SKUL\xba\xbe"),
    ("ext2/3/4 superblock", 1080, b"\x53\xef"),
    ("XFS superblock", 0, b"XFSB"),
    ("Btrfs superblock", 65600, b"_BHRfS_M"),
    ("APFS container", 32, b"NXSB"),
    ("Linux swap signature", 4086, b"SWAPSPACE2"),
    ("MBR/boot-sector signature 0x55AA", 510, b"\x55\xaa"),
]

def parts(data, ss):
    # Partition start byte offsets from the MBR and the GPT (either sector size).
    out = []
    if len(data) >= 512 and data[510:512] == b"\x55\xaa":
        for i in range(4):
            e = data[446 + 16 * i:462 + 16 * i]
            if len(e) == 16 and e[4] not in (0, 0xEE) and u32(e, 8):
                out.append(u32(e, 8) * ss)
    for gss in (512, 4096):
        h = data[gss:gss + 92]
        if len(h) < 92 or h[:8] != b"EFI PART":
            continue
        lba, n, esz = u64(h, 72), u32(h, 80), u32(h, 84)
        if esz < 128 or n > 1024:
            continue
        for i in range(n):
            o = lba * gss + i * esz
            e = data[o:o + esz]
            if len(e) < 48:
                break
            if e[:16] != bytes(16) and u64(e, 32):
                out.append(u64(e, 32) * gss)
    return out

def entropy(c):
    n = len(c)
    return -sum(k / n * math.log2(k / n) for k in Counter(c).values())

def classify(c):
    n = len(c)
    if c.count(0) == n:
        return "zeros"
    if c.count(255) == n:
        return "0xFF"
    for p in (1, 2, 4, 8, 16, 32, 64, 128, 256, 512):
        if n > p and n % p == 0 and c == c[:p] * (n // p):
            return "pattern"
    if entropy(c) >= (7.8 if n >= 4096 else 7.0):
        return "random"
    return None

def fill(data, r, n):
    # A 4 KiB block that is one uniform fill cannot hold a boot sector or a
    # superblock. Without this a vendor fill of 55 AA 55 AA ... would "hold"
    # the 0x55AA boot signature at byte 510.
    # A TWO-byte magic (0x55AA, the ext 0xEF53) inside a block of ciphertext is
    # chance: 1 in 65536 per place looked, so a genuine crypto erase would be
    # sent to an hours-long overwrite now and then for nothing. A real boot
    # sector or superblock is mostly zeros and small fields - it never reads as
    # 7.8 bits/byte - so a 2-byte hit inside a random-looking block is ignored.
    # Every longer magic (EFI PART, NTFS, -FVE-FS-, LUKS...) still counts there.
    o = r // 4096 * 4096
    k = classify(data[o:o + 4096])
    return k in ("zeros", "0xFF", "pattern") or (k == "random" and n <= 2)

def check(mode, base, want, size, starts, data):
    if len(data) < want:
        return 2, "short read at byte %d: %d of %d bytes came back" % (base, len(data), want)
    data = data[:want]
    end = base + want
    for s in sorted(set(starts)):
        for name, off, magic in SIGS:
            a = s + off
            if base <= a and a + len(magic) <= end and data[a - base:a - base + len(magic)] == magic \
                    and not fill(data, a - base, len(magic)):
                return 1, "%s at byte %d" % (name, a)
    for ss in (512, 4096):
        a = size - ss
        if a > 0 and base <= a and a + 8 <= end and data[a - base:a - base + 8] == b"EFI PART" \
                and not fill(data, a - base, 8):
            return 1, "backup GPT header (EFI PART) at byte %d" % a
    if mode == "overwrite":
        z = len(data) - len(data.lstrip(b"\0"))
        if z < len(data):
            return 1, "non-zero data at byte %d (an overwrite must read back as zeros)" % (base + z)
        return 0, "zeros"
    seen = []
    for o in range(0, len(data), 4096):
        c = data[o:o + 4096]
        k = classify(c)
        if k is None:
            return 1, "data that is not an erase pattern at byte %d (entropy %.2f bits/byte)" % (base + o, entropy(c))
        if k not in seen:
            seen.append(k)
    return 0, ",".join(seen)

# Answers are written with no newline: the shell's $(...) would strip a "\n"
# but not the "\r" a text-mode stdout adds on some platforms, and a stray "\r"
# would end up inside the method label.
def main():
    a = sys.argv[1:]
    data = sys.stdin.buffer.read()
    if a[0] == "parts":
        sys.stdout.write(" ".join(str(x) for x in parts(data, int(a[1]))))
        return 0
    rc, msg = check(a[0], int(a[1]), int(a[2]), int(a[3]), [int(x) for x in a[4:]], data)
    sys.stdout.write(["clean", "found", "unverified"][rc] + " " + msg)
    return rc

try:
    sys.exit(main())
except SystemExit:
    raise
except BaseException as e:
    sys.stdout.write("unverified checker error: %s" % e)
    sys.exit(2)
PYEOF
}

# Byte offsets where a partition started, recorded BEFORE the erase: the ones
# the kernel knows (sysfs, in 512-byte units) and the ones in the on-disk MBR /
# GPT itself (the kernel may not have scanned a table, and a table the kernel
# rejected can still hold a volume). After the erase these are exactly the
# places a filesystem's own boot sector or superblock would still be found if
# the erase did nothing - which is what verify_erased looks for there.
# $1 = device, $2 = kernel name. Prints space-separated offsets (maybe none).
als_part_starts() {
  local dev="$1" d="$2" sys="${ALS_SYS_ROOT:-}/sys" f s out="" py sz ss blk
  for f in "$sys/block/$d/$d"*/start; do
    [ -r "$f" ] || continue
    s=$(cat "$f" 2>/dev/null)
    case "$s" in ''|*[!0-9]*) continue ;; esac
    out="$out $(( s * 512 ))"
  done
  py=$(command -v python3 2>/dev/null)
  sz=$(blockdev --getsize64 "$dev" 2>/dev/null)
  if [ -n "$py" ] && case "$sz" in ''|*[!0-9]*|0) false ;; *) true ;; esac; then
    ss=$(blockdev --getss "$dev" 2>/dev/null)
    case "$ss" in 512|4096) ;; *) ss=512 ;; esac
    blk=4096; [ $(( sz % 4096 )) -eq 0 ] || blk=512
    s=1048576; [ "$sz" -lt "$s" ] && s="$sz"
    out="$out $(dd if="$dev" bs="$blk" count=$(( s / blk )) iflag=direct 2>/dev/null \
      | "$py" -c "$(als_verify_py)" parts "$ss" 2>/dev/null)"
  fi
  # shellcheck disable=SC2086
  printf '%s' "$(echo $out)"
}

verify_erased() {
  local dev="$1" mode="$2" starts="${3:-}" py sz blk win=1048576 offs o s i n out rc seen=" " cnt=0 lab=""
  VE_WHY=""; VE_LABEL=""; VE_MIB=0
  py=$(command -v python3 2>/dev/null)
  [ -n "$py" ] || { VE_WHY="python3 is not installed, so the drive could not be read back"; return 2; }
  [ -e "$dev" ] || { VE_WHY="$dev is no longer present"; return 2; }
  sz=$(blockdev --getsize64 "$dev" 2>/dev/null)
  case "$sz" in ''|*[!0-9]*|0) VE_WHY="could not read the size of $dev"; return 2 ;; esac
  # Read the DRIVE, not the page cache: flush it, then read with O_DIRECT. A
  # cached copy of what was just written would otherwise answer for the disk.
  blockdev --flushbufs "$dev" >/dev/null 2>&1
  # O_DIRECT needs offsets and lengths in whole logical sectors. A size that is
  # a multiple of 4096 works in 4 KiB units whatever the sector size; one that
  # is not can only be a 512-byte-sector drive, whose last 512 bytes (the
  # backup GPT) 4 KiB units would miss.
  blk=4096; [ $(( sz % 4096 )) -eq 0 ] || blk=512
  # Bounded windows, never the whole drive: the first MiB, eight spread
  # evenly, the last MiB, and one at each pre-erase partition start (at most
  # 32). A 1 TB drive with no partitions reads 10 MiB.
  offs="0"
  if [ "$sz" -gt "$win" ]; then
    for i in 1 2 3 4 5 6 7 8; do offs="$offs $(( sz / 9 * i / blk * blk ))"; done
    offs="$offs $(( (sz - win) / blk * blk ))"
  fi
  n=0
  for s in $starts; do
    case "$s" in ''|*[!0-9]*) continue ;; esac
    [ "$s" -lt "$sz" ] || continue
    n=$(( n + 1 )); [ "$n" -le 32 ] || break
    offs="$offs $(( s / blk * blk ))"
  done
  for o in $offs; do
    case "$seen" in *" $o "*) continue ;; esac
    seen="$seen$o "
    n=$(( sz - o )); [ "$n" -gt "$win" ] && n=$win
    # shellcheck disable=SC2086
    out=$(dd if="$dev" bs="$blk" skip=$(( o / blk )) count=$(( n / blk )) iflag=direct 2>/dev/null \
      | "$py" -c "$(als_verify_py)" "$mode" "$o" "$n" "$sz" 0 $starts 2>/dev/null)
    rc=$?
    cnt=$(( cnt + n ))
    # Only a checker that SAID what it found counts as a finding. A crash, a
    # killed interpreter or no output is "could not verify", never "clean" and
    # never a reason to overwrite.
    case "$rc:$out" in
      0:clean\ *) for i in $(printf '%s' "${out#clean }" | tr ',' ' '); do
                    case " $lab " in *" $i "*) ;; *) lab="$lab $i" ;; esac
                  done ;;
      1:found\ *) VE_WHY="${out#found }"; VE_MIB=$(( cnt / 1048576 )); return 1 ;;
      2:unverified\ *) VE_WHY="${out#unverified }"; VE_MIB=$(( cnt / 1048576 )); return 2 ;;
      *) VE_WHY="the read-back checker gave no verdict at byte $o (exit $rc)"; VE_MIB=$(( cnt / 1048576 )); return 2 ;;
    esac
  done
  VE_MIB=$(( cnt / 1048576 ))
  # shellcheck disable=SC2086
  set -- $lab
  VE_LABEL="$1"; shift
  for i in "$@"; do VE_LABEL="$VE_LABEL + $i"; done
  [ -n "$VE_LABEL" ] || { VE_WHY="nothing was read back"; return 2; }
  return 0
}

# ATA Secure Erase for one SATA/ATA drive via hdparm, honouring the wanted method
# ("crypto" needs enhanced/SED support). Sets M. Returns 0 on success. Handles the
# BIOS "frozen" state (optional suspend/resume) and clears the temporary password
# if the erase fails so the drive is never left locked.
ata_secure_erase() {
  local dev="$1" want="$2" info enh="" eraseflag="--security-erase" pass="ALSwipe1" label="ATA secure erase"
  command -v hdparm >/dev/null 2>&1 || return 1
  info=$(hdparm -I "$dev" 2>/dev/null | tr '\t' ' ' | tr -s ' ')
  printf '%s\n' "$info" | grep -qi 'Security:' || return 1
  printf '%s\n' "$info" | grep -qi 'supported: enhanced erase' && enh="yes"

  if ! printf '%s\n' "$info" | grep -qi 'not frozen'; then
    if [ "${AUDIT_WIPE_UNFREEZE:-0}" = "1" ] && command -v rtcwake >/dev/null 2>&1; then
      echo "    $dev is frozen — suspending ~6s to unfreeze …"
      rtcwake -m mem -s 6 >/dev/null 2>&1; sleep 2
      info=$(hdparm -I "$dev" 2>/dev/null | tr '\t' ' ' | tr -s ' ')
    fi
    printf '%s\n' "$info" | grep -qi 'not frozen' || { echo "    $dev still frozen — will overwrite instead."; return 1; }
  fi

  if [ "$want" = "crypto" ]; then
    [ -n "$enh" ] || return 1
    eraseflag="--security-erase-enhanced"; label="ATA enhanced secure erase (crypto on self-encrypting drives)"
  elif [ -n "$enh" ]; then
    eraseflag="--security-erase-enhanced"; label="ATA enhanced secure erase"
  fi

  hdparm --user-master u --security-set-pass "$pass" "$dev" >/dev/null 2>&1 || return 1
  if hdparm --user-master u $eraseflag "$pass" "$dev" >/dev/null 2>&1; then
    # NIST SP 800-88: the ENHANCED erase (which also reaches reallocated and
    # vendor-reserved areas) is a Purge; the normal one writes only the user
    # area, which is a Clear.
    M="$label"
    if [ "$eraseflag" = "--security-erase-enhanced" ]; then FW_LEVEL=purge; else FW_LEVEL=clear; fi
    return 0
  fi
  hdparm --user-master u --security-disable "$pass" "$dev" >/dev/null 2>&1
  echo "    ATA secure erase failed on $dev — will overwrite instead."
  return 1
}

# Read the NVMe Sanitize Status log page (log 81h) as NUMBERS.
#
# This used to grep `nvme sanitize-log -H` for the English words "completed
# successfully". That log page describes the LAST sanitize the controller ran,
# not the one just issued - so a success left over from an earlier sanitize
# (a previous run, the refurbisher before us, or a block erase when we asked for
# crypto) matched the words and was taken as this erase finishing. The words are
# also nvme-cli's wording, which changes between versions.
#
# So read the raw page (-b) and decode the fields the spec defines, little-endian:
#   bytes 0-1   SPROG   progress, 65535 = complete
#   bytes 2-3   SSTAT   bits 2:0 = status (0 never, 1 done, 2 running, 3 FAILED,
#                       4 done with no-deallocate)
#   bytes 4-7   SCDW10  the Sanitize command's CDW10; bits 2:0 = the action run
#   bytes 8-19  estimated seconds for overwrite / block erase / crypto erase
#               (0 or 0xFFFFFFFF = no estimate)
# Sets SAN_SPROG SAN_SSTAT SAN_ACT SAN_EST_OW SAN_EST_BE SAN_EST_CE.
# Returns 1 if the page could not be read (fewer than 8 bytes came back).
nvme_sanitize_log() {
  local b
  SAN_SPROG=""; SAN_SSTAT=""; SAN_ACT=""; SAN_EST_OW=""; SAN_EST_BE=""; SAN_EST_CE=""
  b=$(nvme sanitize-log "$1" -b 2>/dev/null | od -An -tu1 -v -N20 2>/dev/null)
  # shellcheck disable=SC2086
  set -- $b
  [ "$#" -ge 8 ] || return 1
  SAN_SPROG=$(( $1 + $2 * 256 ))
  SAN_SSTAT=$(( $3 + $4 * 256 ))
  SAN_ACT=$(( $5 & 7 ))
  if [ "$#" -ge 20 ]; then
    SAN_EST_OW=$(( ${9} + ${10} * 256 + ${11} * 65536 + ${12} * 16777216 ))
    SAN_EST_BE=$(( ${13} + ${14} * 256 + ${15} * 65536 + ${16} * 16777216 ))
    SAN_EST_CE=$(( ${17} + ${18} * 256 + ${19} * 65536 + ${20} * 16777216 ))
  fi
  return 0
}

# How long to wait for a sanitize, in seconds, from the drive's own estimate.
# $1 = estimated seconds (may be empty, 0 or 4294967295 = no estimate).
# Twice the estimate plus a minute, never under 5 minutes (a crypto erase that
# estimates 2 s should not be failed by a slow first log read), capped at 6 h.
# With no estimate, the 20 minutes this always waited.
nvme_sanitize_limit() {
  local est="${1:-}"
  case "$est" in ''|*[!0-9]*|0|4294967295) echo 1200; return 0 ;; esac
  est=$(( est * 2 + 60 ))
  [ "$est" -lt 300 ] && est=300
  [ "$est" -gt 21600 ] && est=21600
  echo "$est"
}

# Run an NVMe SANITIZE (action 4 = crypto erase, 2 = block erase) on the
# controller and wait for it to finish. Sanitize is asynchronous, so poll the
# sanitize log. Success ONLY when all three hold at once: the status is
# "completed" (1 or 4), progress is 65535, and the action the log records is
# the action issued here. Anything else is still running, stale, or failed.
# Returns 0 on success.
#
# The log only describes the LAST sanitize, with no timestamp. A drive that was
# crypto-sanitized before (by a refurbisher, or an earlier run) already shows
# "done, 65535, action 4" before we issue anything - and a controller that
# updates the page a moment after accepting the command, or accepts it without
# starting a new operation, would let that old entry pass as this erase. So the
# log is read BEFORE the command. If that snapshot already looks like the
# success we are waiting for (or cannot be read at all), a completed entry is
# accepted only after this run has SEEN the new operation: status 2 (in
# progress) or progress below 65535. If that never shows within a short grace,
# the result is indistinguishable from the old one and is not accepted - the
# caller then falls back to the next method, which is honest; a false "wiped"
# is not.
nvme_sanitize() {
  local ctrl="$1" act="$2" limit=1200 waited=0 st est need_fresh=0 grace=60
  if nvme_sanitize_log "$ctrl"; then
    st=$(( SAN_SSTAT & 7 ))
    case "$st" in
      1|4) [ "$SAN_SPROG" = "65535" ] && [ "$SAN_ACT" = "$act" ] && need_fresh=1 ;;
    esac
  else
    need_fresh=1
  fi
  nvme sanitize "$ctrl" -a "$act" >/dev/null 2>&1 || return 1
  echo "    sanitize started — waiting for completion …"
  while :; do
    if nvme_sanitize_log "$ctrl"; then
      case "$act" in 4) est="$SAN_EST_CE" ;; 2) est="$SAN_EST_BE" ;; 3) est="$SAN_EST_OW" ;; *) est="" ;; esac
      limit=$(nvme_sanitize_limit "$est")
      st=$(( SAN_SSTAT & 7 ))
      # The new operation, seen: running, or progress not yet complete.
      if [ "$st" = 2 ] || { [ -n "$SAN_SPROG" ] && [ "$SAN_SPROG" != "65535" ]; }; then
        need_fresh=0
      fi
      case "$st" in
        1|4)
          if [ "$SAN_SPROG" = "65535" ] && [ "$SAN_ACT" = "$act" ]; then
            [ "$need_fresh" = 0 ] && return 0
            # Identical to what the log said before we issued the command.
            if [ "$waited" -ge "$grace" ]; then
              echo "    sanitize log still shows only the earlier completed action $act — this run's erase was never seen; not accepted"
              return 1
            fi
          fi
          # A completed entry for a DIFFERENT action (or not at 100%) is the
          # previous sanitize, not this one. Keep waiting; the deadline decides.
          ;;
        3)
          echo "    sanitize reported FAILED (status $SAN_SSTAT, action $SAN_ACT)"
          return 1
          ;;
      esac
    fi
    if [ "$waited" -ge "$limit" ]; then
      echo "    sanitize did not report completion of action $act within ${limit}s"
      return 1
    fi
    sleep 5
    waited=$(( waited + 5 ))
  done
}

# Which NVMe CONTROLLER a namespace block device belongs to (plan step 36).
#
# A sanitize is a controller command, so it goes to /dev/nvmeY, not to the
# namespace. This used to be guessed from the name - nvme0n1 -> /dev/nvme0 -
# but the number in a namespace's name is the SUBSYSTEM's instance, not the
# controller's. On a machine with two NVMe drives, or with native multipath,
# they can differ: nvme0n1 can sit on controller nvme1 while /dev/nvme0 is the
# OTHER drive, which then got the sanitize meant for this one.
#
# So ask the kernel, in this order, and accept only ONE answer:
#   1. a per-path name nvmeXcYnZ names its controller: nvmeY;
#   2. a multipath head (/sys/block/<ns>/multipath/ lists its paths
#      nvmeXcYnZ): the controllers of those paths;
#   3. /sys/block/<ns>/device is the controller itself: its "dev" (major:minor
#      of the controller's character device) is matched against every
#      /sys/class/nvme/nvme*/dev - no symlink has to be read;
#   4. /sys/block/<ns>/device is the subsystem: the nvme* controllers in it;
#   5. sysfs said nothing: `nvme list-subsys -o json /dev/<ns>`, every "Name"
#      of a path/controller in it.
# More than one controller, or none, is AMBIGUOUS: no firmware command is sent
# (the caller falls back to an overwrite of the namespace itself, which the
# block device names without doubt). Sets NV_CTRL (/dev/nvmeY) and NV_WHY.
# ALS_SYS_ROOT (tests only) is prefixed to /sys.
als_nvme_ctrl() {
  local d="$1" sys="${ALS_SYS_ROOT:-}/sys" c="" f v x j
  NV_CTRL=""; NV_WHY=""
  case "$d" in
    nvme*c*n*)
      x="${d#nvme*c}"; x="${x%%n*}"
      case "$x" in ''|*[!0-9]*) ;; *) c="nvme$x" ;; esac ;;
  esac
  if [ -z "$c" ] && [ -d "$sys/block/$d/multipath" ]; then
    for f in "$sys/block/$d/multipath"/nvme*c*n*; do
      [ -e "$f" ] || continue
      x="${f##*/}"; x="${x#nvme*c}"; x="${x%%n*}"
      case "$x" in ''|*[!0-9]*) continue ;; esac
      case " $c " in *" nvme$x "*) ;; *) c="$c nvme$x" ;; esac
    done
  fi
  if [ -z "$c" ] && [ -r "$sys/block/$d/device/dev" ]; then
    v=$(cat "$sys/block/$d/device/dev" 2>/dev/null)
    for f in "$sys/class/nvme"/nvme*/dev; do
      [ -r "$f" ] && [ -n "$v" ] || continue
      [ "$(cat "$f" 2>/dev/null)" = "$v" ] || continue
      x="${f%/dev}"; c="$c ${x##*/}"
    done
  fi
  if [ -z "$c" ] && [ -d "$sys/block/$d/device" ]; then
    for f in "$sys/block/$d/device"/nvme*; do
      x="${f##*/}"
      case "$x" in nvme|nvme*[!0-9]*) continue ;; esac
      [ -e "$f" ] && c="$c $x"
    done
  fi
  if [ -z "$c" ]; then
    j=$(nvme list-subsys -o json "/dev/$d" 2>/dev/null)
    for x in $(printf '%s' "$j" | grep -oE '"Name"[[:space:]]*:[[:space:]]*"nvme[0-9]+"' | grep -oE 'nvme[0-9]+'); do
      case " $c " in *" $x "*) ;; *) c="$c $x" ;; esac
    done
  fi
  # shellcheck disable=SC2086
  set -- $c
  case "$#" in
    1) NV_CTRL="/dev/$1"; return 0 ;;
    0) NV_WHY="could not tell which NVMe controller $d belongs to" ;;
    *) NV_WHY="$d is reachable through more than one NVMe controller ($*) - ambiguous" ;;
  esac
  return 1
}

# Firmware crypto / secure erase for ONE drive per AUDIT_WIPE_METHOD
# (auto|crypto|secure|overwrite). Sets M, returns 0 on success (else the caller
# falls back to an overwrite - never TRIM, which is not an erase).
firmware_erase() {
  local dev="$1" d="$2" want="${AUDIT_WIPE_METHOD:-auto}"
  M=""
  case "$want" in overwrite|zero) return 1 ;; esac
  case "$d" in
    nvme*)
      command -v nvme >/dev/null 2>&1 || return 1
      # NVMe (plan step 36). What used to happen: `nvme format` on the
      # namespace FIRST, the sanitize only if format failed, the sanitize sent
      # to a controller guessed from the name, and nobody asked how many
      # namespaces the drive has. A format with FNA bit 1 clear erases only the
      # namespace it is given, so a second namespace kept its data under a
      # "Purge" for the drive. Now:
      #   - the controller comes from the kernel (als_nvme_ctrl), or nothing
      #     firmware-level is sent at all;
      #   - SANITIZE first - crypto erase (-a 4), then block erase (-a 2) - as
      #     the controller's SANICAP says it supports them. A sanitize erases
      #     the whole NVM subsystem, every namespace, ticked or not: owner
      #     decision D36 (reversible) accepts that, and the kiosk says so;
      #   - `nvme format` last, and only when it is known to cover the whole
      #     drive: exactly one namespace, or FNA bit 1 (a secure erase applies
      #     to all namespaces). Otherwise it is not used, and the namespaces it
      #     would have left are named.
      # SANICAP bits: 0 crypto erase, 1 block erase. FNA bits: 1 secure erase
      # covers all namespaces, 2 crypto erase is supported by format. Unreadable
      # id-ctrl: the sanitize is still tried (an unsupported one just fails),
      # FNA is taken as 0.
      local err="" idc sanicap="" fna=0 nsl h own="" nsids="" others="" n=0 fmt_ok=0 onedrive
      if ! als_nvme_ctrl "$d"; then
        echo "    $NV_WHY — no NVMe firmware command is sent to a guessed controller."
        return 1
      fi
      local ctrl="$NV_CTRL"
      idc=$(nvme id-ctrl "$ctrl" -o json 2>/dev/null)
      sanicap=$(printf '%s' "$idc" | grep -oE '"sanicap"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+$' | head -n1)
      h=$(printf '%s' "$idc" | grep -oE '"fna"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+$' | head -n1)
      [ -n "$h" ] && fna="$h"
      # Every namespace the controller has, attached or not ("[   0]:0x1").
      nsl=$(nvme list-ns "$ctrl" --all 2>/dev/null)
      for h in $(printf '%s\n' "$nsl" | sed -n 's/^[[:space:]]*\[[[:space:]]*[0-9]*\][[:space:]]*:[[:space:]]*0x\([0-9a-fA-F][0-9a-fA-F]*\).*/\1/p'); do
        h=$(( 16#$h )); [ "$h" -gt 0 ] || continue
        nsids="$nsids $h"; n=$(( n + 1 ))
      done
      own=$(cat "${ALS_SYS_ROOT:-}/sys/block/$d/nsid" 2>/dev/null)
      case "$own" in ''|*[!0-9]*) own="${d##*n}" ;; esac
      onedrive="${d%n*}"; onedrive="${onedrive%c*}"   # nvme0c1n2 / nvme0n2 -> nvme0
      for h in $nsids; do
        [ "$h" = "$own" ] || others="$others ${onedrive}n$h"
      done
      others="${others# }"
      if [ "$n" -ge 1 ] && [ -z "$others" ]; then fmt_ok=1
      elif [ $(( fna & 2 )) -ne 0 ]; then fmt_ok=1
      fi
      local can4=1 can2=1
      if [ -n "$sanicap" ]; then
        [ $(( sanicap & 1 )) -ne 0 ] || can4=0
        [ $(( sanicap & 2 )) -ne 0 ] || can2=0
      fi
      if [ "$want" = "crypto" ] || [ "$want" = "auto" ]; then
        if [ "$can4" = 1 ]; then
          nvme_sanitize "$ctrl" 4 && { M="NVMe cryptographic erase (sanitize)"; FW_LEVEL=purge; return 0; }
        else
          echo "    the controller does not support a sanitize crypto erase (SANICAP $sanicap)"
        fi
      fi
      if [ "$want" = "secure" ] || [ "$want" = "auto" ]; then
        if [ "$can2" = 1 ]; then
          nvme_sanitize "$ctrl" 2 && { M="NVMe block-erase sanitize"; FW_LEVEL=purge; return 0; }
        else
          echo "    the controller does not support a sanitize block erase (SANICAP $sanicap)"
        fi
      fi
      if [ "$fmt_ok" = 1 ]; then
        if [ "$want" != "secure" ] && [ $(( fna & 4 )) -ne 0 ]; then
          err=$(nvme format "$dev" -s 2 --force 2>&1) && { M="NVMe cryptographic erase (nvme format -s2)"; FW_LEVEL=purge; return 0; }
        fi
        if [ "$want" != "crypto" ]; then
          err=$(nvme format "$dev" -s 1 --force 2>&1) && { M="NVMe secure erase (nvme format -s1)"; FW_LEVEL=purge; return 0; }
        fi
      elif [ -n "$others" ]; then
        echo "    nvme format not used: it would erase only $d, not the drive's other namespace(s) $others (FNA $fna)."
      else
        echo "    nvme format not used: the drive's namespaces could not be listed, so it is not known to cover the whole drive."
      fi
      echo "    NVMe firmware erase unavailable${err:+ — $(printf '%s' "$err" | head -n1)}"
      return 1
      ;;
    *)
      ata_secure_erase "$dev" "$want"
      ;;
  esac
}

# The honest name for an OVERWRITE, by medium.
#
# On a hard disk an overwrite reaches every sector the operating system can
# address: NIST SP 800-88r2 "Clear". On flash it reaches only the
# user-addressable blocks - over-provisioned and retired blocks sit behind the
# controller, and no host write touches them. r2 still calls that Clear (its
# 3.1.1 defines Clear by user-addressable locations), but a certificate must
# say what the method cannot reach. The owner's decision (19 Sep 2026): keep
# such drives sellable, labelled honestly, rather than destroy every SSD whose
# firmware erase is unavailable - which on second-hand SATA SSDs is usually a
# BIOS freeze. Anything not KNOWN to be rotational is treated as flash:
# understating a hard disk costs nothing; overstating an SSD is the defect this
# replaced.
clear_label() {
  if [ "${1:-}" = "1" ]; then echo "NIST Clear"; else echo "NIST Clear; flash: user-addressable blocks only"; fi
}

# The text-mode wipe is RETIRED (owner decision D9, 19 Sep 2026; reversible).
#
# This used to be a second, complete copy of the wipe ladder: it listed every
# internal drive, erased them one after another, and then merged all of them
# into ONE status and ONE method string for the upload. So a machine with a
# wiped NVMe and a failed SATA disk filed a single record, and every later fix
# to the ladder (TRIM, the verify read, the drive's own identity) had to be made
# twice - and was not always. The kiosk's gui_wipe_one does the same job one
# drive at a time, with one result per drive.
#
# It stays as a stub so an old audit.conf with AUDIT_WIPE=1 is told plainly
# what happened instead of being silently ignored. It wipes NOTHING and sets
# nothing that the upload would file as a wipe.
wipe_internal_drives() {
  [ "${AUDIT_WIPE:-0}" = "1" ] || return 0
  echo
  echo "Data wipe: NOT run here. AUDIT_WIPE=1 is set in audit.conf, but wiping"
  echo "is now done from the kiosk screen, one drive at a time, so each drive"
  echo "gets its own record. Nothing has been erased by this run."
  echo
  return 0
}

# ---- GUI single-drive wipe entrypoint --------------------------------------
# Called as:
#   hardware-audit.sh --wipe-drive /dev/sdX [auto|crypto|secure|overwrite|zero] [expected-serial]
# Wipes ONE explicitly named internal drive with the erase helpers above
# (firmware_erase / shred, each read back by verify_erased). This is the only
# wipe path. Emits human-readable progress on stdout and EXACTLY ONE final line
# on every exit path (see wipe_result and contract C1):
#   WIPE_RESULT {"status":"wiped|failed|refused","device":"/dev/sdX","method":"…",
#                "reason":"…","toolVersion":…,"startedAt":…,"finishedAt":…,
#                "drive":{"serialNumber":…},"methodRequested":…,
#                "sanitisationLevel":"purge|clear|none","verification":"clean|found|unverified"}
# "wiped" ALWAYS means the drive was read back afterwards and none of its old
# data was recognisable. There is no status for "the drive said it worked".
# "refused" means NOTHING was written: not a block device, removable, USB, the
# boot disk, a pseudo-device, or not the drive the operator picked (serial
# mismatch). Removable, USB and boot disk are three separate checks, so the
# boot drive is never selected even when it is a fixed-reporting SSD. (This
# comment used to claim USB was refused when only the removable flag was
# checked.)
# --- overwrite with LIVE progress and a captured reason on failure -----------
# A 250GB spinning disk takes hours to overwrite. Running shred silently made the
# GUI look frozen for that whole time, and discarding its output threw away the
# reason whenever it failed. This runs shred in the background, streams its
# progress every few seconds, and keeps the last lines as the failure reason.
# Sets OVR_ERR. Returns shred's real exit status.
OVR_ERR=""
run_overwrite() {
  # $2 = passes: 2 (default) = random pass + zero pass;
  #              1           = zero pass only (NIST 800-88 Clear, half the time)
  local dev="$1" passes="${2:-2}" out rc pid line start now el n
  out="/tmp/als-wipe.$$.out"
  : > "$out"
  OVR_ERR=""
  command -v shred >/dev/null 2>&1 || { OVR_ERR="shred is not installed"; return 127; }
  # shred -n N = N random passes; -z appends the final zero pass.
  [ "$passes" = "1" ] && n=0 || n=1
  start=$(date +%s)
  # -v makes shred report progress; it uses \r, so we translate it to lines.
  shred -v -f -n "$n" -z "$dev" > "$out" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 5
    now=$(date +%s); el=$(( now - start ))
    line=$(tr '\r' '\n' < "$out" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -n1)
    # Always emit a heartbeat, even if shred has printed nothing yet, so the
    # operator can see the wipe is alive and how long it has been going.
    printf '    [%02d:%02d:%02d] %s\n' $(( el/3600 )) $(( (el%3600)/60 )) $(( el%60 )) \
           "${line:-overwriting …}"
  done
  wait "$pid"; rc=$?
  # Prefer a real error line over the trailing progress noise.
  OVR_ERR=$(tr '\r' '\n' < "$out" 2>/dev/null | grep -v '^[[:space:]]*$' \
            | grep -iE 'error|denied|permission|busy|read-only|no space|invalid|cannot|fail' \
            | tail -n1)
  [ -n "$OVR_ERR" ] || OVR_ERR=$(tr '\r' '\n' < "$out" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -n1)
  rm -f "$out"
  return "$rc"
}

# --- the boot drive is never a target, whatever it reports itself as -------
#
# gui_wipe_one's comment has always said it "refuses removable/USB devices", and
# the code only ever checked the removable flag. That held because every stick
# this station has booted from reports removable=1. It stops holding the moment
# the boot drive is a portable SSD, an SSD-class stick, or one of the SanDisk
# models the vendor has since switched to report as a FIXED disk - all of which
# are exactly what someone buys to make the boot faster. Then removable=0, the
# check passes, and nothing between the operator and shred knew the difference.
#
# So two independent questions, each enough on its own:
#   als_disk_is_usb  - is it attached over USB? (transport, not the flag)
#   als_boot_disk    - is it the disk the running system came off?
#
# Defined HERE, not in find-media.sh. That file is loaded behind an [ -r ] guard;
# if it were ever missing, a check living in it would be "command not found",
# which an `if` reads as false - so the refusal would silently PASS. A safety
# check has to fail closed, which means it lives in the file that does the wiping.

# 0 if the disk is attached over USB. $1 = kernel name, e.g. sdb.
als_disk_is_usb() {
  local tran
  tran=$(lsblk -dno TRAN "/dev/$1" 2>/dev/null | tr -d '[:space:]')
  [ "$tran" = "usb" ] && return 0
  # Belt and braces: lsblk can report TRAN empty for some bridges. The sysfs
  # path of a USB-attached disk always runs through the USB controller.
  case "$(readlink -f "/sys/block/$1" 2>/dev/null)" in
    */usb[0-9]*) return 0 ;;
  esac
  return 1
}

# Prints the kernel name of the disk the running system booted from (e.g. sdb),
# or nothing if it cannot be determined.
als_boot_disk() {
  local mp src pk
  for mp in "${ALS_MEDIA:-}" /cdrom /run/archiso/bootmnt /isodevice; do
    [ -n "$mp" ] || continue
    src=$(findmnt -no SOURCE "$mp" 2>/dev/null) || continue
    [ -b "$src" ] || continue
    pk=$(lsblk -no PKNAME "$src" 2>/dev/null | head -n1 | tr -d '[:space:]')
    # A whole-disk mount has no parent; the source IS the disk.
    [ -n "$pk" ] && { printf '%s' "$pk"; return 0; }
    printf '%s' "$(basename "$src")"
    return 0
  done
  return 1
}

# --- the drive's OWN identity, read from the drive -----------------------------
#
# A wipe record used to say which DEVICE PATH was wiped (/dev/sda) and nothing
# about the drive itself. Device names are handed out at boot in probe order;
# they are not an identity. A certificate - and the per-drive records built on
# it - have to name the drive by what it reports: its serial, model and size.
#
# Defined HERE, above the --wipe-drive dispatch, on purpose. The profile code's
# pval() does the same parsing but is defined after the dispatch has already
# exited, so gui_wipe_one cannot see it.
#
# Pull KEY="value" out of one lsblk -P line, without eval, trimmed, with
# lsblk's escapes normalised by als_lsblk_unescape. The profile's storage loop
# uses THIS helper for SERIAL and MODEL too, so the serial the kiosk sends back
# as the expected serial (storage[].serialNumber) is byte-for-byte the text
# DRV_SERIAL holds here. When the two were normalised differently (the profile
# kept lsblk's raw "\x24", this side decoded it to "$"), a drive whose serial
# held any escaped byte was refused as "identity mismatch" on every attempt.
als_lsblk_val() {
  local v
  v=$(printf ' %s' "$1" | grep -oE " $2=\"[^\"]*\"" | head -n1 | sed -e "s/^ $2=\"//" -e 's/"$//')
  als_lsblk_unescape "$v" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}
# lsblk -P writes a quote, backslash, $, backtick and any byte it cannot print
# in the current locale as \xNN (a backslash itself is \x5c), so the only
# backslashes in a value are those escapes. Turn them back into text ONLY where
# that is safe:
#   \x20-\x7e  printable ASCII: decoded (\x24 -> $, \x22 -> ", \x5c -> \)
#   \x00-\x1f, \x7f  control bytes: dropped (JSON cannot carry them raw)
#   \x80-\xff  kept as the literal four characters \xNN
# The last rule is the one that matters. This used to decode everything with
# printf %b, so a stray 0xFF pad byte in a firmware model string came back as
# a raw 0xFF - not UTF-8, so the WIPE_RESULT line was not valid text and the
# kiosk (which reads the engine as strict UTF-8) died decoding it: an erased
# drive with no record. Leaving high bytes as escape text keeps every line
# pure ASCII for what lsblk escaped. A real accented character lsblk printed
# unescaped (a UTF-8 locale) passes through as it was.
als_lsblk_unescape() {
  local s="$1" out="" h c
  while :; do
    case "$s" in *'\x'*) ;; *) break ;; esac
    out="$out${s%%\\x*}"
    s="${s#*\\x}"
    h="${s:0:2}"
    case "$h" in
      [0-9a-fA-F][0-9a-fA-F])
        if [ $((16#$h)) -ge 32 ] && [ $((16#$h)) -le 126 ]; then
          printf -v c '%b' "\\x$h"
          out="$out$c"; s="${s:2}"; continue
        elif [ $((16#$h)) -lt 32 ] || [ $((16#$h)) -eq 127 ]; then
          s="${s:2}"; continue
        fi
        ;;
    esac
    out="$out\\x"
  done
  printf '%s' "$out$s"
}
# Sets DRV_SERIAL DRV_MODEL DRV_SIZE DRV_TRAN DRV_ROTA DRV_WWN for device $1.
# Any of them may be empty: some drives report no serial (owner decision D18:
# allowed, recorded as unknown), and USB bridges often hide it.
als_drive_identity() {
  local line
  DRV_SERIAL=""; DRV_MODEL=""; DRV_SIZE=""; DRV_TRAN=""; DRV_ROTA=""; DRV_WWN=""
  line=$(lsblk -dbnP -o SERIAL,MODEL,SIZE,TRAN,ROTA,WWN "$1" 2>/dev/null | head -n1)
  [ -n "$line" ] || return 1
  DRV_SERIAL=$(als_lsblk_val "$line" SERIAL)
  DRV_MODEL=$(als_lsblk_val "$line" MODEL)
  DRV_SIZE=$(als_lsblk_val "$line" SIZE)
  DRV_TRAN=$(als_lsblk_val "$line" TRAN)
  DRV_ROTA=$(als_lsblk_val "$line" ROTA)
  DRV_WWN=$(als_lsblk_val "$line" WWN)
  return 0
}

# UTC, ISO-8601, second precision: 2026-09-19T10:01:07Z
als_utc_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Print THE result line of a gui_wipe_one run. $1 status, $2 method, $3 reason.
# Reads WR_DEV / WR_WANT / WR_STARTED (set at the top of gui_wipe_one) and the
# DRV_* identity. Built with the o_* helpers, never by hand: a model name or a
# shred error with a quote in it used to be able to break the line, and the
# kiosk then had no result at all for a drive it had just wiped.
# Fields that were not read are left out rather than sent empty.
wipe_result() {
  local drv
  o_begin
  o_s serialNumber "$DRV_SERIAL"
  o_s model "$DRV_MODEL"
  o_n sizeBytes "$DRV_SIZE"
  o_s transport "$DRV_TRAN"
  case "$DRV_ROTA" in 1) o_raw rotational true ;; 0) o_raw rotational false ;; esac
  o_s wwn "$DRV_WWN"
  drv=$(o_end)
  o_begin
  o_s0 status "$1"
  o_s0 device "$WR_DEV"
  o_s0 method "$2"
  o_s0 reason "$3"
  o_s toolVersion "$ALS_TOOL_VERSION"
  o_s startedAt "$WR_STARTED"
  o_s finishedAt "$(als_utc_now)"
  [ "$drv" = "{}" ] || o_raw drive "$drv"
  o_s methodRequested "$WR_WANT"
  # Level by NIST SP 800-88, and only for what was actually achieved AND read
  # back: purge / clear on a verified wipe, none on a failure, left out on a
  # refusal (nothing was written). See gui_wipe_one.
  case "$1" in
    wiped)  o_s sanitisationLevel "$WR_LEVEL" ;;
    failed) o_s sanitisationLevel none ;;
  esac
  o_s verification "$WR_VERIFY"
  echo "WIPE_RESULT $(o_end)"
}

gui_wipe_one() {
  local dev="$1" want="${2:-auto}" expect="${3:-}" d rota m verified fw
  WR_DEV="$dev"; WR_WANT="$want"; WR_STARTED=$(als_utc_now); WR_VERIFY=""; WR_LEVEL=""
  DRV_SERIAL=""; DRV_MODEL=""; DRV_SIZE=""; DRV_TRAN=""; DRV_ROTA=""; DRV_WWN=""
  if [ -z "$dev" ] || [ ! -b "$dev" ]; then
    echo "Refusing: ${dev:-(no device given)} is not a block device."
    wipe_result refused "no such device" "${dev:-(no device given)} is not a block device"
    return 1
  fi
  d="${dev#/dev/}"
  # Read the identity FIRST, so even a refusal says which drive it refused.
  als_drive_identity "$dev"
  if [ "$(cat "/sys/block/$d/removable" 2>/dev/null)" = "1" ]; then
    echo "Refusing: $dev is removable — the boot media is never wiped."
    wipe_result refused "removable device refused" "$dev is removable"
    return 1
  fi
  if als_disk_is_usb "$d"; then
    echo "Refusing: $dev is attached over USB - external drives, including the one"
    echo "this station booted from, are never wiped here."
    wipe_result refused "usb device refused" "$dev is attached over USB"
    return 1
  fi
  local boot
  boot=$(als_boot_disk)
  if [ -n "$boot" ] && [ "$d" = "$boot" ]; then
    echo "Refusing: $dev is the disk this system is running from."
    wipe_result refused "boot disk refused" "$dev is the disk this system is running from"
    return 1
  fi
  # Pseudo-devices are not real disks: /dev/loop* is the boot media's own
  # SquashFS, and wiping it is both pointless and confusing.
  case "$d" in
    loop*|ram*|zram*|sr*|fd*|dm-*)
      echo "Refusing: $dev is not a real disk (it is a $d pseudo-device)."
      wipe_result refused "none" "$dev is not a physical disk"
      return 1
      ;;
  esac
  # Is this still the drive the operator chose? The kiosk passes the serial it
  # showed on screen. Device names are assigned at boot in probe order, so a
  # drive pulled or re-seated between the scan and the wipe - or a second disk
  # that came up first this time - can put a DIFFERENT drive behind the same
  # /dev name. Checked before anything is written; an empty expected serial
  # (an older kiosk, or a drive that reports none) means no check.
  # The kiosk sends the profile's storage[].serialNumber, which is normalised by
  # the same als_lsblk_val as DRV_SERIAL, so an exact match is the normal case.
  # A profile captured by an older engine kept lsblk's raw escape text (e.g.
  # "S3Z\x241234" for S3Z$1234); normalising the expected serial the same way
  # accepts that too. Either form names only the drive lsblk just described, so
  # this cannot match a different drive.
  expect=$(printf '%s' "$expect" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  if [ -n "$expect" ] && [ "$expect" != "$DRV_SERIAL" ] \
     && [ "$(als_lsblk_unescape "$expect" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')" != "$DRV_SERIAL" ]; then
    echo "Refusing: $dev reports serial '${DRV_SERIAL:-none}', not the '$expect' that was selected."
    echo "Nothing has been written. Rescan the drives and choose again."
    wipe_result refused "identity mismatch refused" "drive serial '${DRV_SERIAL:-none}' does not match the selected drive '$expect'"
    return 1
  fi
  export AUDIT_WIPE_METHOD="$want"
  rota=$(cat "/sys/block/$d/queue/rotational" 2>/dev/null)
  m=""; verified=0; fw=0
  local reason="" sz gb p
  sz=$(blockdev --getsize64 "$dev" 2>/dev/null)
  case "$sz" in ''|*[!0-9]*) gb="" ;; *) gb=$(( sz / 1000000000 )) ;; esac
  echo "Erasing $dev  (method: $want) …"
  if [ -n "$gb" ]; then
    echo "  Capacity: ${gb}GB. Firmware erase is quick; a full overwrite on a"
    echo "  spinning disk this size can take several hours — progress is shown below."
  fi

  # Where the partitions were, read BEFORE anything is erased: afterwards the
  # table itself may be gone while the volumes it pointed at are not, and
  # these offsets are where verify_erased looks for them.
  local parts vr
  parts=$(als_part_starts "$dev" "$d")

  FW_LEVEL=""
  if firmware_erase "$dev" "$d"; then m="$M"; fw=1; fi

  # No TRIM here, on purpose. This used to run blkdiscard when the firmware
  # erase failed on an SSD and record it as the wipe - then the zeros check
  # passed it, because a TRIMmed drive reads back zeros by design whether or
  # not the NAND was erased. It produced a certificate saying "unrecoverable"
  # about data that could still be there, for every SSD whose firmware erase
  # failed - including when the operator had explicitly chosen "overwrite". An
  # SSD now falls through to a real overwrite, labelled for what it reaches.

  # A firmware erase is believed only once the drive has been read back. There
  # used to be a third answer here - "confirmed by the controller", taken when the
  # read-back did not show zeros - and it certified a controller that said
  # "done" and changed nothing exactly like a real erase. Now:
  #   clean            -> wiped (Purge, or Clear for a normal ATA erase)
  #   old data found   -> announced, and down the ladder to a real overwrite
  #   could not verify -> failed with the reason (owner decision D31)
  if [ "$fw" = "1" ]; then
    echo "Verifying: reading the drive back …"
    verify_erased "$dev" firmware "$parts"; vr=$?
    case "$vr" in
      0) verified=1; WR_VERIFY=clean; WR_LEVEL="${FW_LEVEL:-clear}"
         m="$m — verified (reads as $VE_LABEL)" ;;
      1) WR_VERIFY=found
         echo "  OLD DATA STILL PRESENT after $m: $VE_WHY."
         echo "  The drive reported success but did not erase. Falling back to a full"
         echo "  overwrite — this is the slow path and can take hours …"
         m="" ;;
      *) WR_VERIFY=unverified
         reason="could not verify the erase: $VE_WHY"
         m="$m — NOT verified" ;;
    esac
  fi

  if [ -z "$m" ] && [ -z "$reason" ]; then
    if [ "$want" = "zero" ]; then
      echo "  Overwriting — single zero pass (NIST 800-88 Clear) …"
      if run_overwrite "$dev" 1; then
        m="Overwrite — single zero pass ($(clear_label "$rota"))"
      else
        reason="${OVR_ERR:-overwrite failed}"
        echo "  Overwrite failed: $reason"
      fi
    else
      echo "  Overwriting (this is the slow path) …"
      if run_overwrite "$dev"; then
        m="Overwrite — shred 1 pass + zero ($(clear_label "$rota"))"
      else
        reason="${OVR_ERR:-overwrite failed}"
        echo "  Overwrite failed: $reason"
      fi
    fi
    # The last pass of every overwrite writes zeros, so zeros are the only
    # acceptable read-back here - and the partition signatures must be gone.
    if [ -n "$m" ] && [ -z "$reason" ]; then
      echo "Verifying: reading the drive back …"
      verify_erased "$dev" overwrite "$parts"; vr=$?
      case "$vr" in
        0) verified=1; WR_VERIFY=clean; WR_LEVEL=clear
           m="$m — verified (reads as zeros)" ;;
        1) WR_VERIFY=found; reason="verification failed: $VE_WHY" ;;
        *) WR_VERIFY=unverified; reason="could not verify the overwrite: $VE_WHY" ;;
      esac
    fi
  fi

  if [ -n "$m" ] && [ "$verified" = "1" ] && [ -z "$reason" ]; then
    echo "✓ $m"
    echo "  Read back ${VE_MIB} MiB across the drive: no old data found."
    echo "  Sanitisation level: $WR_LEVEL (NIST SP 800-88)."
    wipe_result wiped "$m" ""
    return 0
  fi
  [ -n "$reason" ] || reason="no erase method succeeded on this drive"
  echo "✗ FAILED on $dev — $reason"
  wipe_result failed "${m:-none}" "$reason"
  return 1
}

# GUI entrypoints run before the interactive audit flow and exit on their own.
if [ "${1:-}" = "--wipe-drive" ]; then
  gui_wipe_one "${2:-}" "${3:-}" "${4:-}"
  exit $?
fi

# The GUI captures the hardware profile with AUDIT_DEBUG=1, which skips the
# network step below — so the backend brings the network up itself by calling
# this entrypoint before it talks to the server. Handles Ethernet AND Wi-Fi.
# (--connect-wifi is kept as the original name the GUI backend calls.)
if [ "${1:-}" = "--connect-wifi" ] || [ "${1:-}" = "--connect-net" ]; then
  connect_network
  exit $?
fi

# Bootstrap BEFORE the network check, then again after. Ubuntu live already
# has DHCP by the time this runs, so this first pass can fetch curl — which
# the network check itself needs, and which that image does not ship.
ensure_tools

if [ "${AUDIT_DEBUG:-0}" != "1" ]; then
  connect_network || exit 1
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
# /proc/meminfo reports the memory the OS can USE, which is installed capacity
# minus whatever the firmware reserved (integrated graphics, management engine).
# That is why real 16 GB machines report 15, and 8 GB machines report 7. The
# per-module sizes from dmidecode are the actual installed capacity, so prefer
# those and keep the OS reading as the diagnostic value.
MEM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}')
RAM_DETECTED=""; [ -n "$MEM_KB" ] && RAM_DETECTED=$(( (MEM_KB + 512*1024) / (1024*1024) ))
MEMT=$(dmidecode -t memory 2>/dev/null)
# Sum every populated slot. Sizes come through as "8192 MB", "8 GB" or "No Module
# Installed"; anything without a unit we can read is skipped rather than guessed.
RAM_GB=$(printf '%s\n' "$MEMT" | sed -n 's/^[[:space:]]*Size:[[:space:]]*//p' | awk '
  /No Module|Not Installed|Unknown/ { next }
  {
    v = $1 + 0
    if (v <= 0) next
    if      ($2 ~ /^[Tt][Bb]/) mb += v * 1024 * 1024
    else if ($2 ~ /^[Gg][Bb]/) mb += v * 1024
    else if ($2 ~ /^[Mm][Bb]/) mb += v
    else if ($2 ~ /^[Kk][Bb]/) mb += v / 1024
  }
  END { if (mb > 0) printf "%.0f", mb / 1024 }')
# No dmidecode (or it told us nothing): fall back to the OS figure rounded UP to
# the nearest even GB, which recovers every standard size — 7->8, 15->16, 31->32.
if [ -z "$RAM_GB" ] && [ -n "$RAM_DETECTED" ] && [ "$RAM_DETECTED" -gt 0 ]; then
  RAM_GB=$(( (RAM_DETECTED + 1) / 2 * 2 ))
fi
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
  # SERIAL and MODEL go through als_lsblk_val (defined above the --wipe-drive
  # dispatch), the SAME normaliser the wipe uses for the drive's own identity:
  # the kiosk sends this serialNumber back as the expected serial, and the two
  # must be byte-for-byte equal or the right drive is refused as a mismatch.
  D_RM=$(pval "$line" RM); D_SIZE=$(pval "$line" SIZE); D_MODEL=$(als_lsblk_val "$line" MODEL)
  D_SERIAL=$(als_lsblk_val "$line" SERIAL); D_ROTA=$(pval "$line" ROTA)
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

# --- display: the BUILT-IN panel, laptops only ---
# Deliberately placed after the battery check above, because that is what settles
# DEVICE_TYPE on machines whose chassis type is blank — running this any earlier
# would skip real laptops.
#
# Only eDP/LVDS/DSI connectors are read: those are the internal panel. Reading
# every /sys/class/drm/*/edid would pick up whatever monitor happens to be on the
# bench and record its size as the laptop's.
#
# The size comes from EDID directly rather than from edid-decode, which is not
# installed on a minimal live image. Byte 68 of the first detailed timing
# descriptor holds the high nibbles of the physical image size in MILLIMETRES
# (bytes 66/67 hold the low bytes); that is precise enough to identify the
# marketed panel size, where the header's centimetre fields at 21/22 are not.
# Those cm fields are kept as the fallback for panels with no DTD size.
DISP_RES=""; DISP_SIZE=""
if [ "$DEVICE_TYPE" = "Laptop" ]; then
  for e in /sys/class/drm/*-eDP-*/edid /sys/class/drm/*-LVDS-*/edid /sys/class/drm/*-DSI-*/edid; do
    # DELIBERATELY -r, NOT -s. The kernel declares the DRM 'edid' attribute as a
    # binary sysfs attribute with .size = 0, so stat() reports an empty file even
    # though reading it returns a full 128-byte block. An earlier version tested
    # -s here and therefore skipped EVERY panel it found, on every laptop — which
    # is why the screen size was always blank. Judge by what the read returns.
    [ -r "$e" ] || continue
    # One EDID block is 128 bytes; flattened to a single line for awk. A short or
    # empty read is caught by the parser's own `NF < 128 { exit }` guard, so no
    # size test is needed here (or trustworthy).
    EBYTES=$(od -An -v -tu1 -N128 "$e" 2>/dev/null | tr '\n' ' ')
    [ -n "$EBYTES" ] || continue
    EOUT=$(printf '%s\n' "$EBYTES" | awk '
      NF < 128 { exit }
      {
        for (i = 1; i <= NF; i++) b[i-1] = $i + 0   # 0-indexed, as the spec numbers them

        # EDID holds FOUR 18-byte descriptors starting at byte 54. Only a DETAILED
        # TIMING descriptor carries the physical image size (at +12/+13/+14), and a
        # descriptor is a timing one only when its first two bytes - the pixel clock -
        # are non-zero. Reading descriptor 1 blindly fails on panels that put a
        # display descriptor (monitor name, range limits) first, which is what the
        # Latitude 3310 does: its edid is a full 128 bytes yet yielded no size.
        hmm = 0; vmm = 0; hpx = 0; vpx = 0
        for (o = 54; o <= 108; o += 18) {
          if (b[o] == 0 && b[o+1] == 0) continue          # not a timing descriptor
          if (hpx == 0) {
            hpx = (int(b[o+4] / 16) * 256) + b[o+2]
            vpx = (int(b[o+7] / 16) * 256) + b[o+5]
          }
          h = (int(b[o+14] / 16) * 256) + b[o+12]
          v = ((b[o+14] % 16) * 256) + b[o+13]
          if (h >= 100 && v >= 50) { hmm = h; vmm = v; break }
        }
        # Header centimetre fields as the last resort (less precise, hence second).
        if (hmm < 100 || vmm < 50) { hmm = b[21] * 10; vmm = b[22] * 10 }

        size = ""
        if (hmm >= 100 && vmm >= 50) {
          d = sqrt(hmm * hmm + vmm * vmm) / 25.4
          if (d >= 7 && d <= 40) {
            # Snap to a panel size that actually exists: EDID millimetres put a
            # 14" panel at 13.96". Canonical list lives in the API, at
            # apps/api/src/common/spec-normalise.ts - keep the two in step.
            n = split("10.1 11.6 12.0 12.1 12.5 13.0 13.3 13.5 14.0 15.0 15.6 16.0 17.0 17.3 18.4", std, " ")
            best = 0; bd = 999
            for (i = 1; i <= n; i++) {
              x = std[i] + 0
              dd = (x > d) ? x - d : d - x
              if (dd < bd) { bd = dd; best = x }
            }
            if (bd <= 0.4) d = best
            size = (d == int(d)) ? sprintf("%d\"", d) : sprintf("%.1f\"", d)
          }
        }
        res = (hpx > 0 && vpx > 0) ? sprintf("%dx%d", hpx, vpx) : ""
        printf "%s|%s", size, res
      }')
    DISP_SIZE=${EOUT%%|*}
    DISP_RES=${EOUT#*|}
    [ -n "$DISP_SIZE" ] && break
  done
fi

# --- why did the panel size come back empty? ---
# Attached to the audit ONLY when a laptop yields no size, so it can be read back
# out of the database instead of transcribed off a kiosk screen with no terminal.
# It disappears by itself once detection works on a machine.
# NOTE: read $DISPLAY here, not below - line ~848 reuses that name for a JSON
# fragment, which clobbers the X11 variable for anything after it.
DISP_DEBUG=""
if [ -z "$DISP_SIZE" ] && [ "$DEVICE_TYPE" = "Laptop" ]; then
  for f in /sys/class/drm/*/edid; do
    [ -e "$f" ] || continue
    d=${f%/edid}
    # stat= what `test -s` sees, read= what actually comes back. If those disagree
    # (stat0/read128) that is the sysfs size-0 trap, and it is worth recording.
    DISP_DEBUG="$DISP_DEBUG${DISP_DEBUG:+; }$(basename "$d")=stat$(stat -c%s "$f" 2>/dev/null)/read$(wc -c <"$f" 2>/dev/null | tr -d ' ')/$(cat "$d/status" 2>/dev/null)"
  done
  [ -z "$DISP_DEBUG" ] && DISP_DEBUG="no /sys/class/drm/*/edid entries"
  # The internal panel's raw base block, so its layout can be decoded here rather
  # than guessed at across another boot cycle. 128 bytes = 256 hex chars.
  for e2 in /sys/class/drm/*-eDP-*/edid /sys/class/drm/*-LVDS-*/edid /sys/class/drm/*-DSI-*/edid; do
    [ -r "$e2" ] || continue   # -s would skip it — same sysfs size-0 trap as above
    DISP_DEBUG="$DISP_DEBUG | hex:$(od -An -tx1 -N128 "$e2" 2>/dev/null | tr -d ' 
')"
    break
  done
  # DISPLAY is usually unset for a subprocess of the backend, so try :0 too.
  XR=$( { xrandr 2>/dev/null || DISPLAY=:0 xrandr 2>/dev/null; } | grep -m1 ' connected' | sed 's/(.*)//;s/  */ /g')
  [ -n "$XR" ] && DISP_DEBUG="$DISP_DEBUG | xrandr: $XR"
fi

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
# Only when it disagrees with the installed total — the OS-visible figure is a
# diagnostic, not the spec, so it must never be what a label or export shows.
[ -n "$RAM_DETECTED" ] && [ "$RAM_DETECTED" != "$RAM_GB" ] && o_n detectedGb "$RAM_DETECTED"
o_n modules "$RAM_MODULES"; o_n slots "$RAM_SLOTS"; o_n maxGb "$RAM_MAX"
MEMORY=$(o_end)

o_begin
o_s size "$DISP_SIZE"; o_s resolution "$DISP_RES"
o_s detectDebug "$DISP_DEBUG"
DISPLAY_OBJ=$(o_end)

o_begin
o_s health "$BAT_HEALTH"; o_s designCapacity "$BAT_DESIGN"; o_s fullChargeCapacity "$BAT_FULL"
o_n cycleCount "$BAT_CYCLES"; o_s status "$BAT_STATUS"
BATTERY=$(o_end)

o_begin
o_s ethernet "$NET_ETH"; o_s wifi "$NET_WIFI"; o_s bluetooth "$NET_BT"; o_s macAddress "$NET_MAC"
NETWORK=$(o_end)

# --- device locks & management status ---------------------------------------
# Sourced rather than inlined so detectors can be added without touching this
# file, and so the whole thing is testable against fixtures
# (test-lock-checks.sh) — the LOCKED branches cannot be exercised on an
# unlocked bench machine, and those are the branches that matter.
LOCKS_JSON=""
LOCKS_STATUS=""
if [ -r "$SELF_DIR/lock-checks.sh" ]; then
  . "$SELF_DIR/lock-checks.sh"
  run_lock_checks
  LOCKS_JSON=$(lock_json)
  LOCKS_STATUS=$(lock_status)
  BIOS_LOCKED=$(lock_bios_locked)
else
  # Never skip this quietly. Without the detectors there is no Autopilot, MDM,
  # Entra, BIOS-password, Absolute or BitLocker check at all - and the run would
  # otherwise finish, print a full hardware table and upload a record with no
  # security section, which reads exactly like a device that was checked and
  # found clean. UNVERIFIED is the honest value and it is what the rest of the
  # pipeline already understands.
  LOCKS_STATUS="UNVERIFIED"
  echo
  echo "  !!  DEVICE LOCK CHECKS DID NOT RUN"
  echo "      lock-checks.sh was not found next to this script"
  echo "      (looked in: $SELF_DIR)."
  echo "      Nothing below says anything about Autopilot, Intune, Entra, a BIOS"
  echo "      password, Absolute or BitLocker. Do NOT read this run as a device"
  echo "      that came back clear. Re-sync the stick and run it again."
  echo
fi

o_begin
o_s tpm "$TPM_VER"; o_s secureBoot "$SECURE_BOOT"
o_s lockStatus "$LOCKS_STATUS"
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
p_obj display "$DISPLAY_OBJ"
p_obj battery "$BATTERY"
p_obj network "$NETWORK"
p_obj security "$SECURITY"
[ -n "$LOCKS_JSON" ] && p_obj locks "$LOCKS_JSON"
PROFILE="{${PB#,}}"

# ================= summary =================
echo
echo "Detected on this machine:"
printf "  %-14s %s\n" "Device"   "${MFR:-?} ${MODEL:-?} (${DEVICE_TYPE:-?})"
printf "  %-14s %s\n" "Serial"   "${SERIAL:-?}${EXPRESS:+  ·  express $EXPRESS}"
printf "  %-14s %s\n" "CPU"      "${CPU_MODEL:-?} — ${CPU_CORES:-?}C/${CPU_THREADS:-?}T"
printf "  %-14s %s\n" "RAM"      "${RAM_GB:-?} GB ${RAM_TYPE} ${RAM_SPEED}"
# Make the firmware reservation visible to the operator rather than silently
# showing a different number than the machine's own POST screen does.
if [ -n "$RAM_DETECTED" ] && [ "$RAM_DETECTED" != "$RAM_GB" ]; then
  printf "  %-14s %s\n" "" "(OS sees ${RAM_DETECTED} GB — remainder reserved by firmware)"
fi
[ -n "$DISP_SIZE" ] && printf "  %-14s %s\n" "Screen"   "$DISP_SIZE${DISP_RES:+  ·  $DISP_RES}"
printf "  %-14s %s\n" "Storage"  "$(printf '%s' "$STORAGE" | grep -oE '"capacity":"[^"]*"' | sed 's/.*://; s/"//g' | paste -sd', ' -)"
printf "  %-14s %s\n" "Drive health" "${SMART_SUMMARY:-n/a}"
printf "  %-14s %s\n" "Battery"  "${BAT_HEALTH:-n/a}"
printf "  %-14s %s\n" "TPM/Boot" "${TPM_VER:-none} / ${BOOT_MODE} ${SECURE_BOOT:+(SecureBoot $SECURE_BOOT)}"
echo

# The reason someone runs this before buying a machine, so it prints in full
# rather than as a single line in the table above.
command -v print_lock_report >/dev/null 2>&1 && print_lock_report

if [ "${AUDIT_DEBUG:-0}" = "1" ]; then
  echo "--- captured JSON (debug; not uploaded) ---"
  printf '%s\n' "$PROFILE"
  exit 0
fi

# ================= login + target + upload =================
[ -z "${AUDIT_EMAIL:-}" ] && read -rp "Login email: " AUDIT_EMAIL
[ -z "${AUDIT_PASSWORD:-}" ] && { read -rsp "Password: " AUDIT_PASSWORD; echo; }

echo "Signing in…"
LOGIN=$(http_post "$API/auth/login" \
  "{\"email\":\"$(esc "$AUDIT_EMAIL")\",\"password\":\"$(esc "$AUDIT_PASSWORD")\"}" \
  'Content-Type: application/json')
TOKEN=$(jstr "$LOGIN" accessToken)
if [ -z "$TOKEN" ]; then
  # Say which of the two it was. Blaming the credentials for a missing binary
  # is what sent two diagnoses down the wrong path.
  if [ "$(http_client)" = none ]; then
    echo "Sign-in could not even be attempted."
    http_missing
  else
    echo "Sign-in failed — check audit.conf (email/password/URL)."
  fi
  exit 1
fi

# Which lot to file this device into? Pick from the pre-created lots on the
# server. Defaults to the web-set audit target, so a run of machines into one lot
# is just Enter each time — and you can switch lot per machine here without
# touching the web app.
TARGET=$(http_get "$API/devices/audit-target" "Authorization: Bearer $TOKEN")
DEFAULT_ID=$(jstr "$TARGET" batchId); DEFAULT_NUM=$(jstr "$TARGET" batchNumber)

# Parse the compact [{id,batchNumber}] list. Each object has exactly one "id" and
# one "batchNumber", in that order, so pulling each field in document order gives
# two index-aligned arrays (portable — no reliance on sed \n in the replacement).
LOTS=$(http_get "$API/devices/lots" "Authorization: Bearer $TOKEN")
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
SUBS=$(http_get "$API/lots?batchId=$CHOSEN_ID" "Authorization: Bearer $TOKEN")
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

# Retired: with AUDIT_WIPE=1 this only says that wiping is done at the kiosk.
# The body below therefore never carries dataWipeStatus - this flow files an
# audit, never a wipe record.
wipe_internal_drives

BODY="{\"lotId\":\"$CHOSEN_ID\""
[ -n "$CHOSEN_SUB_ID" ] && BODY="$BODY,\"subLotId\":\"$CHOSEN_SUB_ID\""
# Workflow provenance: this text-mode flow always audits INTO a chosen lot,
# which makes it the Goods In workflow by definition (the client's correction:
# lot-attached = goods_in, standalone = amazon; the GUI station offers both).
# AUDIT_OPERATOR (optional, set in audit.conf) names the human at the bench.
BODY="$BODY,\"auditKind\":\"goods_in\""
[ -n "${AUDIT_OPERATOR:-}" ] && BODY="$BODY,\"operatorName\":\"$(esc "$AUDIT_OPERATOR")\""
# biosLocked is the API's existing single boolean. Derived from the same rows
# the report prints, so the flag can never disagree with the detail above it.
[ -n "${BIOS_LOCKED:-}" ] && BODY="$BODY,\"biosLocked\":$BIOS_LOCKED"
BODY="$BODY,\"profile\":$PROFILE}"

RESP=$(http_post "$API/devices/hardware-audit" "$BODY" \
  "Authorization: Bearer $TOKEN" 'Content-Type: application/json')

if [ -n "$(jstr "$RESP" assetId)" ]; then
  VERB=$([ "$(jraw "$RESP" created)" = "true" ] && echo "added to" || echo "re-audited in")
  echo
  echo "✓ $(jstr "$RESP" name) ($(jstr "$RESP" tag)) $VERB $(jstr "$RESP" lot)."
  RESULT=0
else
  echo
  echo "✗ Upload failed: $(jstr "$RESP" message)"
  RESULT=1
fi

# Keep the result (and the wipe verification) on screen until the operator
# acknowledges it — it does NOT auto-clear.
echo
read -rp "Press Enter when you have read the result… " _
exit "$RESULT"
