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

# audit.conf is READ as KEY="value" lines, never sourced as shell code.
#
# It used to be `. <(sed 's/\r$//' "$conf")` - the file ran as bash, as root
# (the kiosk starts this engine with sudo for every capture and every wipe).
# The kiosk's Settings screen writes the Wi-Fi name and password into that
# file, and needs no PIN for Wi-Fi, so anyone at the screen could type
# x"$(any command)" as the network name and have it run as root the next time
# the engine started. Values are now taken literally, the way the kiosk's own
# load_conf (gui/server.py) reads them, so both halves of the station agree on
# what a line says:
#   - blank lines and lines starting with # are skipped, as are lines that are
#     not KEY=value (an `export KEY=...` line is ignored, as the kiosk does);
#   - Windows CRLF endings and a leading UTF-8 BOM are dropped (audit.conf is
#     usually edited in Notepad);
#   - one leading and one trailing double quote are removed, exactly as the
#     kiosk's regex does; a value written in a matching pair of SINGLE quotes
#     loses those too, which is what sourcing did for such a line;
#   - $, backticks and backslashes mean nothing: WIFI_PASSWORD="pa$$word" is
#     now that password (sourcing turned $$ into a process id);
#   - only the station's own settings are taken: AUDIT_*, WIFI_*,
#     IMAGE_SERVER and TIME_SERVER. A PATH=, IFS= or LD_PRELOAD= line in the
#     file sets nothing.
# Returns 1 if the file cannot be read.
als_read_conf() {
  local line key val
  [ -r "$1" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#$'\xef\xbb\xbf'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "$line" in ''|'#'*) continue ;; esac
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
    case "$key" in AUDIT_*|WIFI_*|IMAGE_SERVER|TIME_SERVER) ;; *) continue ;; esac
    if [ "${#val}" -ge 2 ] && [ "${val:0:1}" = "'" ] && [ "${val: -1}" = "'" ]; then
      val="${val:1:${#val}-2}"
    else
      val="${val#\"}"; val="${val%\"}"
    fi
    printf -v "$key" '%s' "$val"
  done < "$1"
  return 0
}

for conf in "$SELF_DIR/audit.conf" "${ALS_MEDIA:-/nonexistent}/audit.conf"             /cdrom/audit.conf /run/archiso/bootmnt/audit.conf ./audit.conf; do
  [ -f "$conf" ] || continue
  als_read_conf "$conf" && break
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
# A JSON array of strings from newline-separated text (empty lines skipped),
# each escaped by esc(). Empty input gives []. Pass the result to o_raw.
als_json_array() {
  local out="" l
  while IFS= read -r l; do
    [ -n "$l" ] && out="$out,\"$(esc "$l")\""
  done <<< "$1"
  printf '[%s]' "${out#,}"
}

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

def waived(data, r, magic):
    # A 4 KiB block that is one uniform fill cannot hold a boot sector or a
    # superblock. Without this a vendor fill of 55 AA 55 AA ... would "hold"
    # the 0x55AA boot signature at byte 510.
    o = r // 4096 * 4096
    k = classify(data[o:o + 4096])
    if k in ("zeros", "0xFF", "pattern"):
        return True
    # A TWO-byte magic (0x55AA, the ext 0xEF53) inside a block of ciphertext
    # can be chance: 1 in 65536 per place looked, so a genuine crypto erase
    # would be sent to an hours-long overwrite now and then for nothing.
    # But "the block reads as random" is NOT enough to call it chance. This
    # used to waive every 2-byte hit in a random-looking block, and a real MBR
    # (0x55AA, a real partition table) followed by seven sectors of compressed
    # boot loader or ciphertext reads as 7.8+ bits/byte - so a controller that
    # said "done" and erased nothing passed as "random" when the partitions
    # were headerless full-disk encryption with no longer magic to catch it.
    # So the hit is waived only when the structure AROUND it is not real:
    #   - 0x55AA: every one of the four MBR partition entries has a status byte
    #     of 0x00 or 0x80. A real MBR always does (an empty table is all
    #     zeros); ciphertext does 1 time in ~270 million.
    #   - ext 0xEF53: s_rev_level (20 bytes after the magic) is 0 or 1. A real
    #     superblock always is; ciphertext 1 time in ~2 billion.
    # Every longer magic (EFI PART, NTFS, -FVE-FS-, LUKS...) always counts.
    if k != "random" or len(magic) > 2:
        return False
    if magic == b"\x55\xaa":
        st = [r - 64 + 16 * i for i in range(4)]
        if st[0] < 0:
            return False
        return not all(data[x] in (0, 0x80) for x in st)
    if magic == b"\x53\xef":
        rev = data[r + 20:r + 24]
        if len(rev) < 4:
            return False
        return u32(rev, 0) not in (0, 1)
    return False

def check(mode, base, want, size, starts, data):
    if len(data) < want:
        return 2, "short read at byte %d: %d of %d bytes came back" % (base, len(data), want)
    data = data[:want]
    end = base + want
    for s in sorted(set(starts)):
        for name, off, magic in SIGS:
            a = s + off
            if base <= a and a + len(magic) <= end and data[a - base:a - base + len(magic)] == magic \
                    and not waived(data, a - base, magic):
                return 1, "%s at byte %d" % (name, a)
    for ss in (512, 4096):
        a = size - ss
        if a > 0 and base <= a and a + 8 <= end and data[a - base:a - base + 8] == b"EFI PART" \
                and not waived(data, a - base, b"EFI PART"):
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

# Why a firmware method was not used, and which ones were (plan step 38).
#
# A requested Purge could quietly become an overwrite - most often on a SATA
# SSD the BIOS left frozen - and the record said only what was achieved, never
# that something stronger had been asked for, nor why it did not happen.
# firmware_erase and ata_secure_erase now set, at every way out:
#   FW_TRIED  comma list, in order, of the firmware methods actually ISSUED to
#             the drive (nvme-sanitize-crypto, nvme-sanitize-block,
#             nvme-format-crypto, nvme-format-secure, ata-secure-erase-enhanced,
#             ata-secure-erase)
#   FW_WHY    the reason the FIRST (strongest) choice was not the result:
#             tool_missing | unsupported | frozen | failed | controller_ambiguous
#             | namespaces (a format would not cover every namespace);
#             gui_wipe_one adds verify_failed (the drive said done, the read-back
#             found the old data). The first reason wins: that is the answer to
#             "why was the stronger method not used".
# Both empty when the operator asked for an overwrite: nothing fell back.
fw_why() {
  [ -n "${FW_WHY:-}" ] || FW_WHY="$1"
}
fw_tried() {
  FW_TRIED="${FW_TRIED:+$FW_TRIED,}$1"
}

# --- suspend-to-unfreeze: when is it safe? (plan step 42, D-2) ---------------
#
# Most BIOSes "freeze" SATA security at boot, which blocks the ATA secure
# erase; a suspend/resume cycle usually unfreezes it. AUDIT_WIPE_UNFREEZE=1
# does that with rtcwake. But a suspend stops the WHOLE machine, and the kiosk
# runs wipes of several drives at the same time: suspending under another
# drive's overwrite or sanitize can abort it, or corrupt it mid-write. And on
# some machines resume simply fails - the station then hangs with drives half
# erased. So a suspend is allowed only when ALL of these hold:
#   - no other wipe is running on this machine: every running gui_wipe_one
#     registers itself as a directory named by its PID under ALS_WIPE_RUN_DIR
#     (default /run/als-wipe, a tmpfs, so a reboot clears it); an entry whose
#     process is gone is stale and ignored. If THIS wipe could not register,
#     other wipes could not have either, so nothing can be ruled out: no.
#   - /sys/power/mem_sleep offers "deep" (S3). s2idle keeps the drives
#     powered, so it cannot unfreeze anything and would only stall the wipe;
#   - the machine (DMI product name) is not one where resume is known to fail:
#     ALS_NO_RESUME_MODELS below, plus AUDIT_WIPE_NO_SUSPEND_MODELS from
#     audit.conf, "|"-separated, compared case-insensitively. The built-in
#     list starts EMPTY: no model has yet been seen to fail on this station,
#     and a guessed entry would be fiction. Add one the day it happens;
#   - this drive's HPA was not removed temporarily (step 34): the suspend
#     resets the drive, which brings the HPA back.
# Still a race: a wipe started during the ~8 seconds of the suspend itself is
# not seen. The kiosk starts wipes only on an operator's click, and the whole
# feature stays OFF (owner decision D42) until tried on the station.
# Returns 0 when a suspend is allowed; else 1 with SUSPEND_WHY.
ALS_NO_RESUME_MODELS=""
als_wipe_lock() {
  local dir="${ALS_WIPE_RUN_DIR:-/run/als-wipe}"
  WR_LOCK=""
  [ -d "${dir%/*}" ] || return 1
  mkdir -p "$dir" 2>/dev/null || return 1
  # A directory already named by our PID is a dead wipe's leftover (PIDs are
  # reused) - it is ours now.
  [ -d "$dir/$$" ] || mkdir "$dir/$$" 2>/dev/null || return 1
  WR_LOCK="$dir/$$"
  return 0
}
als_wipe_unlock() {
  [ -n "${WR_LOCK:-}" ] && rmdir "$WR_LOCK" 2>/dev/null
  WR_LOCK=""
  return 0
}
als_suspend_ok() {
  local dir="${ALS_WIPE_RUN_DIR:-/run/als-wipe}" sys="${ALS_SYS_ROOT:-}/sys" f p model m lc
  SUSPEND_WHY=""
  if [ "${WR_HPA_REMOVED:-0}" = 1 ]; then
    SUSPEND_WHY="this drive's hidden area (HPA) was removed only until the next reset, and a suspend resets the drive"
    return 1
  fi
  if [ -z "${WR_LOCK:-}" ] || [ ! -d "$WR_LOCK" ]; then
    SUSPEND_WHY="this wipe could not register in $dir, so other running wipes cannot be ruled out"
    return 1
  fi
  for f in "$dir"/*; do
    [ -e "$f" ] || continue
    [ "$f" = "$WR_LOCK" ] && continue
    p="${f##*/}"
    case "$p" in
      ''|*[!0-9]*) SUSPEND_WHY="unexpected entry '$p' in $dir"; return 1 ;;
    esac
    if kill -0 "$p" 2>/dev/null || [ -d "/proc/$p" ]; then
      SUSPEND_WHY="another wipe is running on this machine (process $p)"
      return 1
    fi
    rmdir "$f" 2>/dev/null   # stale: that wipe is gone
  done
  if ! grep -qw deep "$sys/power/mem_sleep" 2>/dev/null; then
    SUSPEND_WHY="this machine does not offer deep suspend (S3)"
    return 1
  fi
  model=$(tr -d '\r\n' < "$sys/class/dmi/id/product_name" 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  if [ -z "$model" ]; then
    SUSPEND_WHY="the machine model could not be read, so it cannot be checked against the list where resume fails"
    return 1
  fi
  lc=$(printf '%s' "$model" | tr '[:upper:]' '[:lower:]')
  local IFS='|'
  for m in $ALS_NO_RESUME_MODELS ${AUDIT_WIPE_NO_SUSPEND_MODELS:-}; do
    m=$(printf '%s' "$m" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')
    [ -n "$m" ] || continue
    if [ "$m" = "$lc" ]; then
      SUSPEND_WHY="resume is known to fail on this model ($model)"
      return 1
    fi
  done
  return 0
}

# ATA Secure Erase for one SATA/ATA drive via hdparm, honouring the wanted method
# ("crypto" needs enhanced/SED support). Sets M. Returns 0 on success. Handles the
# BIOS "frozen" state (optional suspend/resume) and clears the temporary password
# if the erase fails so the drive is never left locked.
ata_secure_erase() {
  local dev="$1" want="$2" info enh="" eraseflag="--security-erase" pass="ALSwipe1" label="ATA secure erase" tried
  command -v hdparm >/dev/null 2>&1 || { fw_why tool_missing; return 1; }
  info=$(hdparm -I "$dev" 2>/dev/null | tr '\t' ' ' | tr -s ' ')
  printf '%s\n' "$info" | grep -qi 'Security:' || { fw_why unsupported; echo "    $dev does not offer the ATA security feature set."; return 1; }
  printf '%s\n' "$info" | grep -qi 'supported: enhanced erase' && enh="yes"

  if ! printf '%s\n' "$info" | grep -qi 'not frozen'; then
    # Suspend-to-unfreeze: OFF unless audit.conf sets AUDIT_WIPE_UNFREEZE=1
    # (owner decision D42: the guards exist, the feature stays disabled until
    # it has been proved on the station's machines). als_suspend_ok says when
    # it is safe at all.
    if [ "${AUDIT_WIPE_UNFREEZE:-0}" = "1" ] && command -v rtcwake >/dev/null 2>&1; then
      if als_suspend_ok; then
        echo "    $dev is frozen — suspending ~6s to unfreeze …"
        # "deep" is offered (checked); make it the mode `-m mem` uses, or the
        # suspend is s2idle, which keeps the drive powered - and frozen.
        grep -q '\[deep\]' "${ALS_SYS_ROOT:-}/sys/power/mem_sleep" 2>/dev/null \
          || { echo deep > "${ALS_SYS_ROOT:-}/sys/power/mem_sleep"; } 2>/dev/null
        rtcwake -m mem -s 6 >/dev/null 2>&1; sleep 2
        info=$(hdparm -I "$dev" 2>/dev/null | tr '\t' ' ' | tr -s ' ')
      else
        echo "    $dev is frozen; not suspending to unfreeze it: $SUSPEND_WHY."
      fi
    fi
    printf '%s\n' "$info" | grep -qi 'not frozen' || { fw_why frozen; echo "    $dev still frozen — will overwrite instead."; return 1; }
  fi

  if [ "$want" = "crypto" ]; then
    [ -n "$enh" ] || { fw_why unsupported; echo "    $dev does not support the enhanced erase that 'crypto' needs."; return 1; }
    eraseflag="--security-erase-enhanced"; label="ATA enhanced secure erase (crypto on self-encrypting drives)"
  elif [ -n "$enh" ]; then
    eraseflag="--security-erase-enhanced"; label="ATA enhanced secure erase"
  fi
  if [ "$eraseflag" = "--security-erase-enhanced" ]; then tried=ata-secure-erase-enhanced; else tried=ata-secure-erase; fi
  fw_tried "$tried"

  hdparm --user-master u --security-set-pass "$pass" "$dev" >/dev/null 2>&1 || { fw_why failed; echo "    the drive refused the temporary security password."; return 1; }
  if hdparm --user-master u $eraseflag "$pass" "$dev" >/dev/null 2>&1; then
    # NIST SP 800-88: the ENHANCED erase (which also reaches reallocated and
    # vendor-reserved areas) is a Purge; the normal one writes only the user
    # area, which is a Clear.
    M="$label"
    if [ "$eraseflag" = "--security-erase-enhanced" ]; then FW_LEVEL=purge; else FW_LEVEL=clear; fi
    return 0
  fi
  hdparm --user-master u --security-disable "$pass" "$dev" >/dev/null 2>&1
  fw_why failed
  echo "    ATA secure erase failed on $dev — will overwrite instead."
  return 1
}

# --- hidden areas: HPA and DCO (plan step 34, D-2) ---------------------------
#
# An ATA drive can be told to report FEWER sectors than it has. A Host
# Protected Area (HPA) hides the end of the drive behind a lowered "max
# address"; a Device Configuration Overlay (DCO) lowers the native maximum
# itself. Vendors use them for recovery partitions, and they are also a
# well-known place to leave data. Neither the kernel's size nor an overwrite
# nor (on many drives) a secure erase reaches past them. This engine used to
# wipe up to the visible size and certify the drive - with the hidden sectors
# untouched and never mentioned.
#
# ata_hidden_areas asks the drive, reading only:
#   hdparm -N              " max sectors   = 976771055/976773168, HPA is enabled"
#                          current/native: current < native is an HPA.
#   hdparm -I              whether the drive has the HPA / DCO feature sets at all
#                          (no DCO feature set = no DCO can exist).
#   hdparm --dco-identify  "Real max sectors: N": above the native max is a DCO.
# Sets HA_HPA and HA_DCO (none | present | unknown), HA_CUR / HA_NATIVE /
# HA_REAL (sector counts, when read), HA_AMAX (1 / 0 / "": whether the drive's
# max address can only be changed permanently) and HA_WHY, and sets HA_STATE and prints
# the combined state (call it WITHOUT $(...) when the HA_* values are needed):
#   dco-present > hpa-present > unknown > none
# Anything it cannot parse - a RAID/RST controller that does not pass ATA
# commands through, a driver that answers "HPA setting seems invalid", an
# unexpected layout - is UNKNOWN, never none.
# It never changes anything; --dco-restore / --dco-setmax are never run by this
# engine at all (a DCO restore is permanent and has bricked drives).
ata_hidden_areas() {
  local dev="$1" info n x real std top v
  HA_STATE=unknown; HA_HPA=unknown; HA_DCO=unknown; HA_CUR=""; HA_NATIVE=""; HA_REAL=""; HA_WHY=""; HA_AMAX=""
  if ! command -v hdparm >/dev/null 2>&1; then
    HA_WHY="hdparm is not installed"; echo unknown; return 0
  fi
  info=$(hdparm -I "$dev" 2>/dev/null | tr '\t' ' ' | tr -s ' ')
  n=$(hdparm -N "$dev" 2>/dev/null | tr '\t' ' ')
  x=$(printf '%s\n' "$n" | sed -n 's/.*max sectors *= *\([0-9][0-9]*\)\/\([0-9][0-9]*\).*/\1 \2/p' | head -n1)
  if [ -n "$x" ] && ! printf '%s\n' "$n" | grep -qi 'seems invalid'; then
    HA_CUR="${x% *}"; HA_NATIVE="${x#* }"
    # Which command a later `hdparm -N <n>` would send. hdparm (9.52+, and
    # 9.65 on this stick) decides it by ONE test - ACS-3 with ACCESSIBLE MAX
    # ADDRESS (IDENTIFY word 119 bit 8) - and prints its -N answer by the
    # same test: "ACCESSIBLE MAX ADDRESS enabled/disabled" on such a drive,
    # "HPA is enabled/disabled" otherwise. On an AMA drive the SET is SET
    # ACCESSIBLE MAX ADDRESS EXT, which ACS-3 defines as non-volatile, and
    # hdparm ignores the missing "p": the "temporary" removal would
    # permanently reconfigure the customer's drive. So HA_AMAX: 1 = AMA
    # (permanent only), 0 = the legacy SET MAX ADDRESS whose volatile form
    # the drive forgets at power-off, "" = hdparm did not say (then nothing
    # is ever set - see ata_hpa_remove).
    if printf '%s\n' "$n" | grep -qi 'ACCESSIBLE MAX ADDRESS'; then HA_AMAX=1
    elif printf '%s\n' "$n" | grep -qiE 'HPA is (enabled|disabled)'; then HA_AMAX=0
    fi
    if [ "$HA_NATIVE" -le 0 ]; then HA_WHY="hdparm -N reported a native max of 0"; HA_CUR=""; HA_NATIVE=""
    elif [ "$HA_CUR" -eq "$HA_NATIVE" ]; then HA_HPA=none
    elif [ "$HA_CUR" -lt "$HA_NATIVE" ]; then HA_HPA=present
    else HA_WHY="hdparm -N reported a current max above the native max"
    fi
  elif printf '%s\n' "$info" | grep -q 'Commands/features' \
       && ! printf '%s\n' "$info" | grep -qi 'Host Protected Area'; then
    # No HPA feature set (word 82 bit 10) proves there is no HPA only on a
    # drive older than ACS-3. ACS-3 made that bit obsolete and added
    # ACCESSIBLE MAX ADDRESS, which lowers the capacity just the same and
    # which hdparm -I never prints. So "none" only when -I lists the ATA
    # versions the drive supports and all are below ACS-3 (10); an ACS-3+
    # drive, or one that does not list them, is unknown.
    std=$(printf '%s\n' "$info" | sed -n 's/^ *Supported: *\([0-9][0-9 ]*\)$/\1/p' | head -n1)
    top=""
    for v in $std; do
      case "$v" in *[!0-9]*) continue ;; esac
      if [ -z "$top" ] || [ "$v" -gt "$top" ]; then top="$v"; fi
    done
    if [ -n "$top" ] && [ "$top" -lt 10 ]; then
      HA_HPA=none   # a pre-ACS-3 drive with no HPA feature set
    else
      HA_WHY="the drive's max sectors could not be read (hdparm -N), and a drive of ACS-3 or later can hide sectors without the HPA feature set"
    fi
  else
    HA_WHY="the drive's max sectors could not be read (hdparm -N)"
  fi
  if printf '%s\n' "$info" | grep -q 'Commands/features' \
     && ! printf '%s\n' "$info" | grep -qi 'Device Configuration Overlay'; then
    HA_DCO=none     # the drive has no DCO feature set
  else
    real=$(hdparm --dco-identify "$dev" 2>/dev/null | tr '\t' ' ' \
           | sed -n 's/.*Real max sectors: *\([0-9][0-9]*\).*/\1/p' | head -n1)
    if [ -n "$real" ] && [ -n "$HA_NATIVE" ]; then
      HA_REAL="$real"
      # hdparm prints the DCO maximum as a sector COUNT; accept the max LBA
      # (one less) as well, so a version that prints the address is not read
      # as an overlay of one sector. Only MORE than the native max is hidden.
      if [ "$real" -gt "$HA_NATIVE" ]; then HA_DCO=present
      elif [ "$real" -eq "$HA_NATIVE" ] || [ "$real" -eq $(( HA_NATIVE - 1 )) ]; then HA_DCO=none
      else HA_WHY="${HA_WHY:+$HA_WHY; }the DCO maximum ($real) is below the native maximum ($HA_NATIVE)"
      fi
    else
      HA_WHY="${HA_WHY:+$HA_WHY; }the DCO could not be read (hdparm --dco-identify)"
    fi
  fi
  if [ "$HA_DCO" = present ]; then HA_STATE=dco-present
  elif [ "$HA_HPA" = present ]; then HA_STATE=hpa-present
  elif [ "$HA_HPA" = unknown ] || [ "$HA_DCO" = unknown ]; then HA_STATE=unknown
  else HA_STATE=none
  fi
  echo "$HA_STATE"
}

# Remove an HPA TEMPORARILY: `hdparm -N <native>` with no "p" prefix sets the
# VOLATILE max address, which the drive forgets at its next hardware reset or
# power cycle - the customer's drive is not permanently reconfigured (owner
# decision D34, reversible). Then make the kernel re-read the size and require
# that BOTH the drive (hdparm -N again) and the kernel (the block device's size)
# now report the full native size - an overwrite only reaches what the kernel
# thinks the drive holds. $1 = /dev/sdX, $2 = kernel name. Uses HA_NATIVE and
# HA_AMAX: only a drive whose hdparm -N answer was the legacy "HPA is ..."
# wording gets the SET - on an ACS-3 ACCESSIBLE MAX ADDRESS drive the same
# command is PERMANENT (see ata_hidden_areas), and on an unknown wording it
# might be; either way the drive is left exactly as it is and the wipe fails.
# Returns 0 when the whole drive is visible; else 1 with HR_WHY (and HR_AMA=1
# when it was refused because the change could only be permanent).
ata_hpa_remove() {
  local dev="$1" d="$2" nat="$HA_NATIVE" n x cur
  HR_WHY=""; HR_AMA=""
  case "$nat" in ''|*[!0-9]*) HR_WHY="the native size is not known"; return 1 ;; esac
  if [ "$HA_AMAX" = 1 ]; then
    HR_AMA=1
    HR_WHY="it is an ACS-3 accessible max address, which can only be changed permanently - left as it is (owner decision D34: temporary removal only)"
    return 1
  elif [ "$HA_AMAX" != 0 ]; then
    HR_WHY="hdparm did not say whether the change would be temporary - left as it is"
    return 1
  fi
  # hdparm's own manual: setting the max takes two back-to-back commands the
  # kernel can interleave with others, "so if it fails initially, just try
  # again". Once.
  if ! hdparm -N "$nat" "$dev" >/dev/null 2>&1; then
    sleep 1
    hdparm -N "$nat" "$dev" >/dev/null 2>&1 || { HR_WHY="hdparm -N $nat was rejected by the drive"; return 1; }
  fi
  n=$(hdparm -N "$dev" 2>/dev/null | tr '\t' ' ')
  x=$(printf '%s\n' "$n" | sed -n 's/.*max sectors *= *\([0-9][0-9]*\)\/\([0-9][0-9]*\).*/\1 \2/p' | head -n1)
  cur="${x% *}"
  if [ -z "$x" ] || [ "$cur" != "$nat" ]; then
    HR_WHY="the drive still reports ${cur:-an unreadable} of $nat sectors after the removal"
    return 1
  fi
  ata_kernel_whole "$dev" "$d" "$nat"
}

# Does the KERNEL see the whole drive? $1 = /dev/sdX, $2 = kernel name, $3 =
# the drive's native sector count. The overwrite and the read-back stop at the
# kernel's size, not the drive's, and the kernel keeps the size it read at
# probe time until told to look again - so after a (volatile) HPA removal, and
# also when hdparm -N says the drive is whole: an earlier attempt in the same
# boot may have removed the HPA while libata kept the old, smaller size, and
# then the drive answers current = native while the last sectors are out of
# the wipe's reach. Checked first, then after a rescan, three times.
# Returns 0 when the kernel's size is exactly native x sector size; else 1
# with HR_WHY (an unreadable size is a failure too: nothing is proven).
ata_kernel_whole() {
  local dev="$1" d="$2" nat="$3" ss sz i
  HR_WHY=""
  case "$nat" in ''|*[!0-9]*) HR_WHY="the native size is not known"; return 1 ;; esac
  for i in 0 1 2 3; do
    if [ "$i" -gt 0 ]; then
      { echo 1 > "${ALS_SYS_ROOT:-}/sys/block/$d/device/rescan"; } 2>/dev/null
    fi
    ss=$(blockdev --getss "$dev" 2>/dev/null)
    sz=$(blockdev --getsize64 "$dev" 2>/dev/null)
    case "$ss" in ''|*[!0-9]*) ss="" ;; esac
    case "$sz" in ''|*[!0-9]*) sz="" ;; esac
    [ -n "$ss" ] && [ -n "$sz" ] && [ "$sz" = $(( nat * ss )) ] && return 0
    [ "$i" -gt 0 ] && sleep 1
  done
  if [ -n "$ss" ] && [ -n "$sz" ] && [ "$sz" -lt $(( nat * ss )) ]; then
    HR_WHY="the kernel still sees $sz bytes, $(( nat - sz / ss )) sectors short of the whole drive ($nat sectors of $ss bytes)"
  else
    HR_WHY="the kernel sees ${sz:-an unreadable number of} bytes, not the whole drive ($nat sectors of ${ss:-unknown size})"
  fi
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
# falls back to an overwrite - never TRIM, which is not an erase). Sets FW_TRIED
# and FW_WHY (see fw_why) on every path.
firmware_erase() {
  local dev="$1" d="$2" want="${AUDIT_WIPE_METHOD:-auto}"
  M=""; FW_WHY=""; FW_TRIED=""
  case "$want" in overwrite|zero) return 1 ;; esac
  case "$d" in
    nvme*)
      command -v nvme >/dev/null 2>&1 || { fw_why tool_missing; echo "    nvme-cli is not installed."; return 1; }
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
        fw_why controller_ambiguous
        return 1
      fi
      local ctrl="$NV_CTRL"
      idc=$(nvme id-ctrl "$ctrl" -o json 2>/dev/null)
      sanicap=$(printf '%s' "$idc" | grep -oE '"sanicap"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+$' | head -n1)
      h=$(printf '%s' "$idc" | grep -oE '"fna"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+$' | head -n1)
      [ -n "$h" ] && fna="$h"
      # Every namespace the controller has, attached or not ("[   0]:0x1").
      # `list-ns --all` is Identify CNS 10h, which the spec requires only of
      # controllers with Namespace Management; most single-namespace consumer
      # drives reject it. Taking that as "coverage unknown" dropped every such
      # drive without a sanitize from a format Purge to an hours-long
      # overwrite (Clear). So when it gives nothing:
      #   - without Namespace Management (OACS bit 3 clear) no namespace can
      #     be created or detached, so the mandatory ACTIVE list (CNS 02h) is
      #     every namespace there is - use it;
      #   - with Namespace Management, or OACS unreadable, the active list
      #     could miss a detached namespace - not used;
      #   - id-ctrl NN = 1 (the most namespaces the controller can ever have)
      #     proves there is exactly one - this one - whatever the lists say.
      # A list that DID answer always wins over NN (it names what is there).
      nsl=$(nvme list-ns "$ctrl" --all 2>/dev/null)
      local oacs nn
      oacs=$(printf '%s' "$idc" | grep -oE '"oacs"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+$' | head -n1)
      nn=$(printf '%s' "$idc" | grep -oE '"nn"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+$' | head -n1)
      if ! printf '%s\n' "$nsl" | grep -qE '^[[:space:]]*\[[[:space:]]*[0-9]*\][[:space:]]*:[[:space:]]*0x0*[1-9a-fA-F]' \
          && [ -n "$oacs" ] && [ $(( oacs & 8 )) -eq 0 ]; then
        nsl=$(nvme list-ns "$ctrl" 2>/dev/null)
      fi
      for h in $(printf '%s\n' "$nsl" | sed -n 's/^[[:space:]]*\[[[:space:]]*[0-9]*\][[:space:]]*:[[:space:]]*0x\([0-9a-fA-F][0-9a-fA-F]*\).*/\1/p'); do
        h=$(( 16#$h )); [ "$h" -gt 0 ] || continue
        nsids="$nsids $h"; n=$(( n + 1 ))
      done
      own=$(cat "${ALS_SYS_ROOT:-}/sys/block/$d/nsid" 2>/dev/null)
      case "$own" in ''|*[!0-9]*) own="${d##*n}" ;; esac
      [ "$n" -eq 0 ] && [ "$nn" = 1 ] && { nsids="$own"; n=1; }
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
          fw_tried nvme-sanitize-crypto
          nvme_sanitize "$ctrl" 4 && { M="NVMe cryptographic erase (sanitize)"; FW_LEVEL=purge; return 0; }
          fw_why failed
        else
          fw_why unsupported
          echo "    the controller does not support a sanitize crypto erase (SANICAP $sanicap)"
        fi
      fi
      if [ "$want" = "secure" ] || [ "$want" = "auto" ]; then
        if [ "$can2" = 1 ]; then
          fw_tried nvme-sanitize-block
          nvme_sanitize "$ctrl" 2 && { M="NVMe block-erase sanitize"; FW_LEVEL=purge; return 0; }
          fw_why failed
        else
          fw_why unsupported
          echo "    the controller does not support a sanitize block erase (SANICAP $sanicap)"
        fi
      fi
      if [ "$fmt_ok" = 1 ]; then
        if [ "$want" != "secure" ] && [ $(( fna & 4 )) -ne 0 ]; then
          fw_tried nvme-format-crypto
          err=$(nvme format "$dev" -s 2 --force 2>&1) && { M="NVMe cryptographic erase (nvme format -s2)"; FW_LEVEL=purge; return 0; }
          fw_why failed
        fi
        if [ "$want" != "crypto" ]; then
          fw_tried nvme-format-secure
          err=$(nvme format "$dev" -s 1 --force 2>&1) && { M="NVMe secure erase (nvme format -s1)"; FW_LEVEL=purge; return 0; }
          fw_why failed
        fi
      elif [ -n "$others" ]; then
        fw_why namespaces
        echo "    nvme format not used: it would erase only $d, not the drive's other namespace(s) $others (FNA $fna)."
      else
        fw_why namespaces
        echo "    nvme format not used: the drive's namespaces could not be listed, so it is not known to cover the whole drive."
      fi
      fw_why unsupported
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

# The drive's own count of bad sectors (plan step 38): SMART attribute 5
# (Reallocated_Sector_Ct) and 197 (Current_Pending_Sector). A reallocated
# sector is one the drive retired and replaced from its spares; the OLD sector
# still holds whatever was on it, and no overwrite - nor a NORMAL ATA secure
# erase, which writes only the user area - can address it again. So these
# counts decide what an overwrite or a normal secure erase can honestly claim.
#
# Read with a time limit (a sick drive can hang a SMART read for minutes), and
# never able to fail the wipe: whatever goes wrong, the counts are just empty.
# Sets SC_REALLOC and SC_PENDING (a number, or empty = could not be read).
# Only the RAW_VALUE's leading digits are taken ("0", "8 (0 2)").
smart_counts() {
  local out
  SC_REALLOC=""; SC_PENDING=""
  command -v smartctl >/dev/null 2>&1 || return 0
  if command -v timeout >/dev/null 2>&1; then
    out=$(timeout 30 smartctl -A "$1" 2>/dev/null)
  else
    out=$(smartctl -A "$1" 2>/dev/null)
  fi
  SC_REALLOC=$(printf '%s\n' "$out" | awk '$1 == "5" && NF >= 10 { print $10; exit }' | sed 's/[^0-9].*//')
  SC_PENDING=$(printf '%s\n' "$out" | awk '$1 == "197" && NF >= 10 { print $10; exit }' | sed 's/[^0-9].*//')
  return 0
}

# What a wipe that WORKED and was read back may claim (plan step 38). Pure: no
# I/O, so the rules below are tested on their own.
#   $1 kind      purge      - ENHANCED ATA secure erase, NVMe sanitize / format
#                ata-normal - a NORMAL ATA secure erase (user area only)
#                overwrite  - shred / zero pass
#   $2 rotational (1 = hard disk; anything else is treated as flash)
#   $3..$6 reallocated before, pending before, reallocated after, pending after
#          (empty = not read)
#   $7 smart     1 (default) = the counts apply to this drive; 0 = they do not
#                exist on it (NVMe), so there is nothing to have failed to read
# Prints the NIST SP 800-88 level on the first line, then one limitation per
# line:
#   purge                         -> purge; the enhanced erase and a sanitize
#                                    reach reallocated and spare areas too
#   ata-normal or overwrite with any reallocated/pending sectors
#                                 -> clear, with a limitation naming the counts
#                                    (owner decision D38, reversible: labelled
#                                    Clear rather than failed or destroyed)
#   counts that could not be read -> a limitation saying so
#   overwrite on flash            -> clear, "flash: user-addressable blocks only"
#   anything else                 -> none
# NOTHING here ever turns an overwrite or a normal secure erase into purge.
wipe_assess() {
  local kind="$1" rota="$2" rb="$3" pb="$4" ra="$5" pa="$6" smart="${7:-1}" r="" p="" v
  case "$kind" in
    purge) echo purge; return 0 ;;
    ata-normal|overwrite) echo clear ;;
    *) echo none; return 0 ;;
  esac
  if [ "$kind" = overwrite ] && [ "$rota" != 1 ]; then
    echo "flash: user-addressable blocks only - over-provisioned and retired flash blocks are not reached by an overwrite"
  fi
  [ "$smart" = 1 ] || return 0
  # The larger of before and after, per count: a pending sector the overwrite
  # made the drive reallocate moves from one count to the other.
  for v in $rb $ra; do case "$v" in *[!0-9]*) ;; *) { [ -z "$r" ] || [ "$v" -gt "$r" ]; } && r="$v" ;; esac; done
  for v in $pb $pa; do case "$v" in *[!0-9]*) ;; *) { [ -z "$p" ] || [ "$v" -gt "$p" ]; } && p="$v" ;; esac; done
  if [ -z "$r" ] && [ -z "$p" ]; then
    echo "SMART reallocated and pending sector counts could not be read, so sectors the drive has retired cannot be ruled out"
  elif [ -z "$r" ]; then
    echo "SMART reallocated sector count could not be read, so sectors the drive has retired cannot be ruled out"
  elif [ -z "$p" ]; then
    echo "SMART pending sector count could not be read"
  fi
  if [ "${r:-0}" -gt 0 ] || [ "${p:-0}" -gt 0 ]; then
    echo "the drive reports ${r:-unknown} reallocated and ${p:-unknown} pending sectors (SMART 5/197); a retired sector cannot be addressed by $( [ "$kind" = overwrite ] && echo "an overwrite" || echo "a normal ATA secure erase" ), so its old contents may remain"
  fi
  return 0
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
#                "sanitisationLevel":"purge|clear|none","verification":"clean|found|unverified",
#                "hiddenAreas":…,"limitations":[…],"methodAttempted":"a,b",
#                "fallbackReason":…,"smart":{"reallocatedBefore":…,…}}
# (the fields after "verification" only on wiped/failed, and only when known)
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

# Add one line to WR_LIMITS, the wipe's limitations (WIPE_RESULT "limitations").
# One line of code on purpose: the tests extract functions up to the first line
# that starts with "}", which a multi-line string would produce.
wr_limit() {
  [ -n "$1" ] && WR_LIMITS="${WR_LIMITS}${WR_LIMITS:+$'\n'}$1"
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
  # SMART bad-sector counts before and after (step 38); a count that could not
  # be read is left out, and the object with it when none could.
  local sm
  o_begin
  o_n reallocatedBefore "${WR_SM_RB:-}"
  o_n pendingBefore "${WR_SM_PB:-}"
  o_n reallocatedAfter "${WR_SM_RA:-}"
  o_n pendingAfter "${WR_SM_PA:-}"
  sm=$(o_end)
  # What was found in the drive's hidden areas (step 34) is part of the method:
  # "…; hidden areas: none". Only when the check ran (not on a refusal).
  local meth="$2"
  case "$1" in wiped|failed) [ -n "${WR_HIDDEN_TXT:-}" ] && meth="$meth; hidden areas: $WR_HIDDEN_TXT" ;; esac
  o_begin
  o_s0 status "$1"
  o_s0 device "$WR_DEV"
  o_s0 method "$meth"
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
  # hiddenAreas: none | hpa-removed | unknown | dco-present | hpa-present (the
  # last two only on a failure). limitations: always an array once something
  # was attempted - [] when there is nothing to say.
  case "$1" in
    wiped|failed)
      o_s hiddenAreas "${WR_HIDDEN:-}"
      o_raw limitations "$(als_json_array "${WR_LIMITS:-}")"
      # methodAttempted: every method issued, in order ("nvme-sanitize-crypto,
      # overwrite"); fallbackReason: why the first choice was not the result
      # (frozen | unsupported | tool_missing | failed | verify_failed | ...).
      o_s methodAttempted "${WR_TRIED:-}"
      o_s fallbackReason "${WR_FALLBACK:-}"
      [ "$sm" = "{}" ] || o_raw smart "$sm"
      ;;
  esac
  echo "WIPE_RESULT $(o_end)"
}

gui_wipe_one() {
  local dev="$1" want="${2:-auto}" expect="${3:-}" d rota m verified fw
  WR_DEV="$dev"; WR_WANT="$want"; WR_STARTED=$(als_utc_now); WR_VERIFY=""; WR_LEVEL=""
  WR_HIDDEN=""; WR_HIDDEN_TXT=""; WR_LIMITS=""; WR_HPA_REMOVED=0
  WR_TRIED=""; WR_FALLBACK=""; WR_SM_RB=""; WR_SM_PB=""; WR_SM_RA=""; WR_SM_PA=""
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
  # From here on this drive is being wiped: register it, so a suspend-to-
  # unfreeze in ANOTHER wipe on this machine knows to wait (step 42). Removed
  # when the engine exits - the --wipe-drive entrypoint exits right after this
  # function - and an entry left by a killed engine is recognised as stale by
  # its dead PID. A failure to register only disables suspending.
  als_wipe_lock
  trap 'als_wipe_unlock' EXIT
  export AUDIT_WIPE_METHOD="$want"
  rota=$(cat "/sys/block/$d/queue/rotational" 2>/dev/null)
  m=""; verified=0; fw=0
  local reason="" sz gb p

  # Hidden areas (plan step 34), checked BEFORE anything is written: an HPA or
  # DCO hides sectors from the kernel, so neither the firmware erase on many
  # drives nor an overwrite would reach them - and the drive used to be
  # certified all the same. Owner decision D34 (reversible):
  #   HPA only    -> removed TEMPORARILY and verified, or the wipe fails -
  #                  and on an ACS-3 ACCESSIBLE MAX ADDRESS drive, where only a
  #                  permanent change exists, it fails without touching it
  #   DCO present -> the wipe fails, naming it (never --dco-restore)
  #   unknown     -> the wipe goes ahead, with the limitation recorded - an
  #                  unreadable answer is common behind RAID/RST controllers,
  #                  and blocking would fail every such drive
  # NVMe and eMMC have no HPA/DCO.
  case "${d##*/}" in
    nvme*|mmcblk*) ;;
    *)
      echo "Checking $dev for hidden areas (HPA / DCO) …"
      ata_hidden_areas "$dev" >/dev/null
      # Whenever the drive's native size is known and no removal is due,
      # the kernel must see all of it: hdparm -N compares only the drive's
      # own two numbers, and a drive whose HPA an earlier attempt in this
      # boot removed answers current = native while the kernel still holds
      # the old, smaller size - the overwrite and the read-back would stop
      # there and the drive be certified "hidden areas: none".
      case "$HA_STATE" in
        none|unknown)
          if [ -n "$HA_NATIVE" ] && ! ata_kernel_whole "$dev" "$d" "$HA_NATIVE"; then
            WR_HIDDEN="$HA_STATE"
            WR_HIDDEN_TXT="the kernel sees less than the drive's $HA_NATIVE sectors"
            echo "✗ The kernel does not see the whole of $dev: $HR_WHY. Nothing has been erased."
            wipe_result failed "none" "the end of the drive is out of the wipe's reach: $HR_WHY (usually a hidden area removed earlier in this boot, whose new size the kernel has not taken up)"
            return 1
          fi
          ;;
      esac
      case "$HA_STATE" in
        none)
          WR_HIDDEN=none; WR_HIDDEN_TXT="none" ;;
        dco-present)
          WR_HIDDEN=dco-present
          WR_HIDDEN_TXT="DCO present (drive reports ${HA_REAL} sectors, native max ${HA_NATIVE})"
          echo "✗ $dev has a Device Configuration Overlay hiding sectors ($HA_REAL real, $HA_NATIVE visible)."
          echo "  It is not removed here (a DCO restore is permanent). Nothing has been written."
          wipe_result failed "none" "a hidden area (DCO) hides $(( HA_REAL - HA_NATIVE )) sectors of this drive; the wipe would not reach them"
          return 1
          ;;
        hpa-present)
          echo "  Host Protected Area: $HA_CUR of $HA_NATIVE sectors visible - removing it temporarily …"
          if ata_hpa_remove "$dev" "$d"; then
            WR_HIDDEN=hpa-removed; WR_HPA_REMOVED=1
            WR_HIDDEN_TXT="HPA removed temporarily ($HA_CUR -> $HA_NATIVE sectors)"
            echo "  HPA removed until the next power cycle: the whole drive ($HA_NATIVE sectors) is visible."
            if [ "$HA_DCO" != none ]; then
              wr_limit "hidden areas could not be checked for a DCO (device configuration overlay)"
            fi
          else
            WR_HIDDEN=hpa-present
            if [ "$HR_AMA" = 1 ]; then
              WR_HIDDEN_TXT="accessible max address lowered ($HA_CUR of $HA_NATIVE sectors visible), not changed: only a permanent change is possible"
            else
              WR_HIDDEN_TXT="HPA present ($HA_CUR of $HA_NATIVE sectors visible), could not be removed"
            fi
            echo "✗ The hidden area (HPA) could not be removed: $HR_WHY. Nothing has been erased."
            wipe_result failed "none" "a hidden area (HPA) of $(( HA_NATIVE - HA_CUR )) sectors could not be removed: $HR_WHY"
            return 1
          fi
          ;;
        *)
          WR_HIDDEN=unknown; WR_HIDDEN_TXT="could not be checked"
          wr_limit "hidden areas could not be checked${HA_WHY:+ ($HA_WHY)}"
          echo "  Hidden areas could not be checked (${HA_WHY:-no answer}) - recorded as a limitation."
          ;;
      esac
      ;;
  esac

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

  # The bad-sector counts BEFORE the erase (plan step 38). Not on NVMe/eMMC,
  # which have no attributes 5/197; never able to fail the wipe.
  local smart_ok=1 kind=""
  case "${d##*/}" in nvme*|mmcblk*) smart_ok=0 ;; esac
  if [ "$smart_ok" = 1 ]; then
    smart_counts "$dev"; WR_SM_RB="$SC_REALLOC"; WR_SM_PB="$SC_PENDING"
  fi

  FW_LEVEL=""; FW_WHY=""; FW_TRIED=""
  if firmware_erase "$dev" "$d"; then m="$M"; fw=1; fi
  WR_TRIED="$FW_TRIED"; WR_FALLBACK="$FW_WHY"

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
         if [ "$WR_LEVEL" = purge ]; then kind=purge; else kind=ata-normal; fi
         m="$m — verified (reads as $VE_LABEL)" ;;
      1) WR_VERIFY=found; WR_FALLBACK=verify_failed
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
      WR_TRIED="${WR_TRIED:+$WR_TRIED,}overwrite-zero"
      if run_overwrite "$dev" 1; then
        m="Overwrite — single zero pass ($(clear_label "$rota"))"
      else
        reason="${OVR_ERR:-overwrite failed}"
        echo "  Overwrite failed: $reason"
      fi
    else
      echo "  Overwriting (this is the slow path) …"
      WR_TRIED="${WR_TRIED:+$WR_TRIED,}overwrite"
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
        0) verified=1; WR_VERIFY=clean; WR_LEVEL=clear; kind=overwrite
           m="$m — verified (reads as zeros)" ;;
        1) WR_VERIFY=found; reason="verification failed: $VE_WHY" ;;
        *) WR_VERIFY=unverified; reason="could not verify the overwrite: $VE_WHY" ;;
      esac
    fi
  fi

  # A temporarily removed HPA comes back at the drive's next hardware reset (a
  # bus reset after an error, a suspend). If that happened during the erase,
  # the end of the drive may have been out of reach for part of it - and there
  # is no telling which part. So the drive must STILL show every sector now.
  if [ "$WR_HPA_REMOVED" = 1 ] && [ -n "$m" ] && [ "$verified" = "1" ] && [ -z "$reason" ]; then
    local cur_now
    cur_now=$(hdparm -N "$dev" 2>/dev/null | tr '\t' ' ' | sed -n 's/.*max sectors *= *\([0-9][0-9]*\)\/.*/\1/p' | head -n1)
    if [ "$cur_now" != "$HA_NATIVE" ]; then
      verified=0
      reason="the hidden area (HPA) came back during the wipe (the drive now shows ${cur_now:-an unreadable number of} of $HA_NATIVE sectors) - the end of the drive may not have been erased"
    fi
  fi

  # The counts AFTER the erase: an overwrite can make a pending sector get
  # reallocated. Read on success and failure alike - a failed wipe's record
  # is where a dying drive shows.
  if [ "$smart_ok" = 1 ]; then
    smart_counts "$dev"; WR_SM_RA="$SC_REALLOC"; WR_SM_PA="$SC_PENDING"
  fi

  if [ -n "$m" ] && [ "$verified" = "1" ] && [ -z "$reason" ]; then
    # The level the record may claim, and what it cannot reach (step 38).
    local assess l first=1
    assess=$(wipe_assess "$kind" "$rota" "$WR_SM_RB" "$WR_SM_PB" "$WR_SM_RA" "$WR_SM_PA" "$smart_ok")
    while IFS= read -r l; do
      if [ "$first" = 1 ]; then first=0; WR_LEVEL="$l"; else wr_limit "$l"; fi
    done <<< "$assess"
    echo "✓ $m"
    echo "  Read back ${VE_MIB} MiB across the drive: no old data found."
    echo "  Sanitisation level: $WR_LEVEL (NIST SP 800-88)."
    [ -n "$WR_LIMITS" ] && printf '%s\n' "$WR_LIMITS" | sed 's/^/  Limitation: /'
    [ -n "$WR_FALLBACK" ] && echo "  Requested '$want'; the stronger method was not used: $WR_FALLBACK."
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

# --- drive health (contract C5: a percentage from the drive's own data) ------
# The owner asked for each drive's health as a PERCENTAGE with a status, next
# to battery health, and for it NEVER to say "Unknown". Before this the profile
# carried a text scrape of `smartctl -a` (no timeout, hours misread on drives
# that print "16083h+45m+12.345s" as 345, no attribute 198, no NVMe spare,
# critical warning or media errors), and the kiosk ran its OWN smartctl as the
# desktop user - which the kernel refuses (opening an NVMe or ATA pass-through
# needs root), so every drive on the station read "SMART not available".
#
# Now each drive is read ONCE, here, as root, during the capture:
#   `smartctl -j -x` (JSON; -x adds Device Statistics and the self-test log),
#   or `mmc extcsd read` for an eMMC, which has no SMART at all.
# Every read has a time limit (ALS_SMART_TIMEOUT, 30 s): a sick drive can hang
# a SMART read for minutes, and before this one such drive held the whole
# capture until the kiosk gave up at 900 s. Drives are read one after another.
#
# The number comes from ONE documented formula (DRIVE-HEALTH-CONTRACT C5),
# implemented once, in als_health_py below, and unit-tested against real
# smartctl 7.4 JSON (tools/test-drive-health.py):
#   life remaining (flash: the drive's own wear figure) - capped by an error
#   score (reallocated / pending / uncorrectable sectors, media errors) and by
#   the drive's own failure alarms (SMART FAILED, a failing attribute, an NVMe
#   critical warning, a failed self-test, running hot).
# Bands (the owner's): Good 90-100, Caution 50-89, Bad 0-49; the status is
# only ever derived from the percentage.
#
# When a percentage cannot be measured the object says WHY and WHAT TO DO
# ({"measured":false,"reason":...,"action":...}) - never a guessed number and
# never "unknown". The old flat fields (smartStatus, healthPct, powerOnHours,
# ...) are still written, from the same JSON, for readers that predate this.
#
# The helper is printed by a function (like als_verify_py) so the tests run
# exactly this code. Keep every python line from starting with "}".
als_health_py() {
  cat <<'PYEOF'
import json, os, re, sys

TIMEOUT_RCS = (124, 137)

# (reason, action) - the contract's table, word for word. Never "unknown".
R_RAID = ("behind a RAID/Intel RST controller",
          "set the storage mode to AHCI in the BIOS, then press Rescan")
R_UNSUP = ("the drive does not report health data",
           "none on this machine — test it on another machine or replace")
R_OFF = ("SMART is switched off and would not turn on",
         "enable SMART in the BIOS, then press Rescan")
R_TIMEOUT = ("the drive did not answer the health request in 30 s",
             "press Rescan; if it repeats, the drive may be failing")
R_EMMC_TOOL = ("this build cannot read eMMC health", "update the stick")
R_NO_SMARTCTL = ("this build cannot read drive health (smartctl is missing)",
                 "update the stick")
# Not in the contract's table, and still never "unknown": smartctl ran as root
# and could not open the device (it vanished, or the controller refused it),
# or it printed nothing usable at all.
R_OPEN = ("the drive could not be opened for a health read",
          "press Rescan; if it repeats, reseat the drive or test it on another machine")
R_NO_ANSWER = ("the drive gave no readable health answer",
               "press Rescan; if it repeats, the drive may be failing")

# A logical volume of a hardware RAID card, or a disk smartctl can only reach
# through one: smartctl says which -d option it would need.
RAID_MSG = re.compile(r"megaraid|cciss|aacraid|areca|3ware|hpsa|sssraid|-d\s+[a-z]+,\s*N", re.I)
RAID_PRODUCT = re.compile(r"PERC|MegaRAID|LOGICAL VOLUME|RAID", re.I)

# SATA SSD life-remaining attributes: id AND name must both match (vendors
# reuse ids for unrelated counters). The NORMALISED value is life remaining
# (100 = new); the raw value is vendor-specific and is never used for this.
LIFE_ATTRS = [(231, "ssd_life_left"), (233, "media_wearout_indicator"),
              (177, "wear_leveling_count"), (202, "percent_lifetime_remain"),
              (169, "remaining_lifetime_perc")]

# Error attributes: the id, plus a name guard for the same reason.
ERR_ATTRS = {5: r"realloc|retired", 197: r"pending", 198: r"uncorrect|offline",
             187: r"uncorrect", 10: r"spin.?retry", 199: r"crc"}

# Attributes whose failure flag must NOT be read as "the drive is failing":
# 199 is a cable fault, 190/194 are temperatures. Same id+name guard.
NO_FAIL_CAP = {199: r"crc", 190: r"temperature|airflow", 194: r"temperature|airflow"}

CW_BITS = [(0x01, "available spare below threshold"), (0x02, "temperature out of range"),
           (0x04, "reliability degraded"), (0x08, "media is read-only"),
           (0x10, "volatile memory backup failed"),
           (0x20, "persistent memory region is read-only")]


def out(s):
    sys.stdout.buffer.write((s + "\n").encode("utf-8"))


def plural(n, one, many=None):
    return "%d %s" % (n, one if n == 1 else (many or one + "s"))


def num(v):
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v)
    return None


def raw_count(a):
    """The count an attribute carries: the leading digits of raw.string
    ("0", "8 (0 2)", "16083h+45m+12.345s" -> 16083), else raw.value."""
    raw = a.get("raw") or {}
    m = re.match(r"\s*(\d+)", str(raw.get("string") or ""))
    if m:
        return int(m.group(1))
    return num(raw.get("value"))


def band(p):
    return "good" if p >= 90 else ("caution" if p >= 50 else "bad")


def not_measured(r, source):
    h = {"measured": False, "reason": r[0], "action": r[1]}
    if source:
        h["source"] = source
    return h


def label(h):
    """The one-line summary the capture prints."""
    if not h.get("measured"):
        return "Not measurable — %s — %s" % (h["reason"], h["action"])
    return "%d%% %s (%s)" % (h["percent"], h["status"].capitalize(), h["basis"])


def emit(h, flat=None):
    out("H " + json.dumps(h, ensure_ascii=True, separators=(",", ":")))
    out("L " + label(h))
    for k, v in (flat or []):
        if v is None:
            continue
        out(("N %s %d" if isinstance(v, int) else "S %s %s") % (k, v))


def nothing_of(kinds):
    """"no reallocated, pending or uncorrectable sectors" - built from the
    counters the drive ACTUALLY reported, so the all-clear never covers a
    counter that was never read."""
    if not kinds:
        return None
    if len(kinds) == 1:
        return "no " + kinds[0]
    return "no " + ", ".join(kinds[:-1]) + " or " + kinds[-1]


def finish(source, L, E, deductions, caps, notes, fields, tool, flat_extra, clean=None):
    """Apply the formula's last step and build the object. `clean` is the
    all-clear sentence for THIS drive's readable counters (None when it
    reports none: then the basis says only what was read)."""
    pct = min([L if L is not None else 100, E] + [c for c, _ in caps])
    pct = int(round(max(0, min(100, pct))))
    reasons = list(deductions) + [t for _, t in caps] + list(notes)
    if L is not None:
        basis = "life remaining %d%% reported by the drive" % L
        lowered = (list(deductions) if E < L else []) + [t for c, t in caps if c < L]
        if pct < L and lowered:
            basis += "; reduced by " + ", ".join(lowered)
    else:
        parts = []
        if source != "ata-hdd":
            parts.append("no wear figure reported by the drive")
        if deductions:
            parts.append(", ".join(deductions))
        elif clean:
            parts.append(clean)
        parts += [t for _, t in caps]
        if fields.get("smartPassed") is True:
            parts.append("SMART passed")
        basis = "; ".join(parts)
    h = {"measured": True, "percent": pct, "status": band(pct), "basis": basis,
         "reasons": reasons, "source": source}
    h.update(fields)
    h["tool"] = tool
    flat = [("smartStatus", {True: "PASSED", False: "FAILED"}.get(fields.get("smartPassed"))),
            ("healthPct", pct)] + flat_extra
    emit(h, flat)


def smart(raw, rc, kind, tried):
    if rc in TIMEOUT_RCS:
        return emit(not_measured(R_TIMEOUT, kind))
    try:
        d = json.loads(raw) if raw.strip() else None
    except ValueError:
        d = None
    if not isinstance(d, dict) or not d:
        return emit(not_measured(R_NO_SMARTCTL if rc == 127 else R_NO_ANSWER, kind))
    sc = d.get("smartctl") or {}
    msgs = " ".join(str(m.get("string", "")) for m in (sc.get("messages") or [])
                    if isinstance(m, dict))
    es = num(sc.get("exit_status"))
    es = rc if es is None else es
    dev = d.get("device") or {}
    proto = str(dev.get("protocol") or "")
    product = " ".join(str(d.get(k) or "") for k in ("scsi_vendor", "scsi_product", "model_name"))
    if RAID_MSG.search(msgs) or str(dev.get("type") or "").startswith(("megaraid", "cciss")) \
            or (proto == "SCSI" and RAID_PRODUCT.search(product)):
        return emit(not_measured(R_RAID, kind))
    nv = d.get("nvme_smart_health_information_log")
    nv = nv if isinstance(nv, dict) else None
    table = [a for a in ((d.get("ata_smart_attributes") or {}).get("table") or [])
             if isinstance(a, dict)]
    status = d.get("smart_status") if isinstance(d.get("smart_status"), dict) else {}
    # A SAS/SCSI disk has no attribute table at all: its tallies are in its own
    # logs (see scsi_counters). Reading neither, the first version of this
    # helper graded a SAS disk with 1204 grown defects 100% Good.
    scsi = scsi_counters(d) if (nv is None and not table and proto == "SCSI") else None
    has_data = bool(nv or table or (scsi and any(x is not None for x in scsi))
                    or "passed" in status)
    # exit_status bit 0: smartctl could not even tell what the device is
    # ("Unable to detect device type"); bit 1: the open failed. Either way
    # the drive was never asked, so it is not "does not report health data".
    if es & 3 and not has_data:
        return emit(not_measured(R_OPEN, kind))
    sup = d.get("smart_support") or {}
    if sup.get("available") is False:
        return emit(not_measured(R_UNSUP, kind))
    if sup.get("enabled") is False and not has_data:
        if not tried:
            return out("ENABLE")
        return emit(not_measured(R_OFF, kind))
    if not has_data:
        return emit(not_measured(R_UNSUP, kind))

    if nv is not None or proto == "NVMe":
        source = "nvme"
    else:
        rr = d.get("rotation_rate")
        if isinstance(rr, int) and not isinstance(rr, bool):
            source = "ata-hdd" if rr > 0 else "ata-ssd"
        else:
            source = kind if kind in ("ata-hdd", "ata-ssd") else "ata-ssd"
    ver = sc.get("version") or []
    tool = "smartctl %s" % ".".join(str(x) for x in ver[:2]) if ver else "smartctl"

    passed = status.get("passed")
    passed = passed if isinstance(passed, bool) else None
    temp = num((d.get("temperature") or {}).get("current"))
    poh = num((d.get("power_on_time") or {}).get("hours"))
    pcy = num(d.get("power_cycle_count"))

    L = None
    deductions, caps, notes = [], [], []
    E = 100
    hot_attr = None      # a temperature attribute the drive flags right now
    fields = {"smartPassed": passed, "temperatureC": None, "powerOnHours": None,
              "powerCycles": None, "lifeUsedPct": None, "availableSparePct": None,
              "reallocatedSectors": None, "pendingSectors": None,
              "uncorrectableSectors": None, "mediaErrors": None,
              "criticalWarning": None, "selfTest": "none"}

    if source == "nvme":
        nv = nv or {}
        used = num(nv.get("percentage_used"))
        spare = num(nv.get("available_spare"))
        thr = num(nv.get("available_spare_threshold"))
        media = num(nv.get("media_errors"))
        cw = num(nv.get("critical_warning"))
        temp = temp if temp is not None else num(nv.get("temperature"))
        poh = poh if poh is not None else num(nv.get("power_on_hours"))
        pcy = pcy if pcy is not None else num(nv.get("power_cycles"))
        cands = []
        if used is not None:
            cands.append(100 - used)
        if spare is not None:
            cands.append(spare)
        if cands:
            L = max(0, min(100, min(cands)))
            if spare is not None and spare < 100 and spare <= min(cands):
                notes.append("spare blocks at %d%%%s" % (
                    spare, " (the drive's own threshold is %d%%)" % thr if thr is not None else ""))
        if media:
            E -= min(50, 10 * media)
            deductions.append(plural(media, "media error"))
        if cw:
            bits = [t for b, t in CW_BITS if cw & b] or ["code %d" % cw]
            caps.append((25, "NVMe critical warning: " + ", ".join(bits)))
        # smartctl marks an NVMe FAILED whenever critical_warning is set; that
        # is the same alarm as the cap just above, not a second one.
        if passed is False and not cw:
            caps.append((20, "the drive's own SMART self-check FAILED"))
        limit = num((d.get("temperature") or {}).get("op_limit_max")) or 70
        fields.update(lifeUsedPct=used, availableSparePct=spare, mediaErrors=media,
                      criticalWarning=cw)
        evidence = [x is not None for x in (used, spare, media, cw)]
        clean = "no media errors" if media == 0 else None
        flat = [("powerOnHours", poh), ("powerCycles", pcy), ("ssdLifeUsedPct", used),
                ("temperatureC", temp)]
        st = selftest_nvme(d)
    elif scsi is not None:
        # SAS/SCSI. The contract's `source` names the four kinds the web app
        # knows, so a SAS disk is filed under the media it is (spinning or
        # flash); the basis names the SCSI logs the numbers came from.
        defects, unc = scsi
        if defects:
            E -= min(40, 2 * defects)
            deductions.append("%d grown defect%s (reallocated sector%s)"
                              % (defects, "" if defects == 1 else "s", "" if defects == 1 else "s"))
        if unc:
            E -= min(50, 10 * unc)
            deductions.append(plural(unc, "uncorrected read/write error"))
        if passed is False:
            caps.append((20, "the drive's own SMART self-check FAILED"))
        fields.update(reallocatedSectors=defects, uncorrectableSectors=unc)
        evidence = [defects is not None, unc is not None]
        clean = nothing_of([n for n, v in (("grown defects", defects),
                                           ("uncorrected errors", unc)) if v == 0])
        limit = 55 if source == "ata-hdd" else 70
        flat = [("powerOnHours", poh), ("powerCycles", pcy),
                ("reallocatedSectors", defects), ("temperatureC", temp)]
        st = ("none", "")
    else:
        attrs = {}
        for a in table:
            i = num(a.get("id"))
            if i is not None and i not in attrs:
                attrs[i] = a
        def err(i):
            a = attrs.get(i)
            if a and re.search(ERR_ATTRS[i], str(a.get("name") or ""), re.I):
                return raw_count(a)
            return None
        realloc, pending, off_unc, rep_unc = err(5), err(197), err(198), err(187)
        spin, crc = err(10), err(199)
        unc = None if off_unc is None and rep_unc is None else (off_unc or 0) + (rep_unc or 0)
        if realloc:
            E -= min(40, 2 * realloc)
            deductions.append(plural(realloc, "reallocated sector"))
        if pending:
            E -= min(40, 10 * pending)
            deductions.append(plural(pending, "pending sector"))
        if unc:
            E -= min(50, 10 * unc)
            deductions.append(plural(unc, "uncorrectable sector"))
        if spin:
            E -= 10
            deductions.append("spin retries recorded (%d)" % spin)
        if crc:
            notes.append("%s — a cable or connector fault, not counted against the drive"
                         % plural(crc, "cable/connection (CRC) error"))
        if passed is False:
            caps.append((20, "the drive's own SMART self-check FAILED"))
        # The failure flags are the drive's own alarms - but three attributes
        # must not raise one. 199 is a CABLE fault (the contract says so, and
        # it is already noted as one above), and 190/194 are TEMPERATURE
        # counters: their "In_the_past" flag is set for good by one warm
        # afternoon and never clears, so a drive with zero reallocated, zero
        # pending and zero uncorrectable sectors and SMART PASSED was coming
        # out 49% Bad. Heat is judged from the CURRENT reading below; a
        # temperature attribute failing NOW joins that judgement (cap 89),
        # it does not mean the drive is damaged.
        for a in table:
            i = num(a.get("id"))
            wf = str(a.get("when_failed") or "")
            name = str(a.get("name") or "attribute %s" % a.get("id"))
            if not wf:
                continue
            guard = NO_FAIL_CAP.get(i)
            if guard and re.search(guard, name, re.I):
                if i == 199:
                    continue
                if wf == "now":
                    hot_attr = name
                else:
                    notes.append("%s went over the drive's temperature threshold in the past — "
                                 "a temperature, not damage to the drive" % name)
                continue
            if wf == "now":
                caps.append((20, "%s is below the drive's failure threshold now" % name))
            elif wf == "past":
                caps.append((49, "%s fell below the drive's failure threshold in the past" % name))
        used = None
        if source == "ata-ssd":
            for pg in ((d.get("ata_device_statistics") or {}).get("pages") or []):
                for row in (pg.get("table") or []) if isinstance(pg, dict) else []:
                    if not isinstance(row, dict):
                        continue
                    if str(row.get("name") or "").lower() != "percentage used endurance indicator":
                        continue
                    if (row.get("flags") or {}).get("valid") is False:
                        continue
                    v = num(row.get("value"))
                    if v is not None and used is None:
                        used = v
            if used is not None:
                L = max(0, min(100, 100 - used))
            else:
                for i, nm in LIFE_ATTRS:
                    a = attrs.get(i)
                    if a and str(a.get("name") or "").lower() == nm and num(a.get("value")) is not None:
                        L = max(0, min(100, num(a.get("value"))))
                        used = 100 - L
                        break
        fields.update(lifeUsedPct=used, reallocatedSectors=realloc, pendingSectors=pending,
                      uncorrectableSectors=unc)
        evidence = [L is not None] + [x is not None for x in (realloc, pending, unc, spin)]
        # Only the counters this table actually carries: a drive whose table
        # has no 5/197/198 must not be handed the full all-clear sentence.
        clean = nothing_of([n for n, v in (("reallocated", realloc), ("pending", pending),
                                           ("uncorrectable", unc)) if v == 0])
        clean = clean + " sectors" if clean else None
        limit = 55 if source == "ata-hdd" else 70
        flat = [("powerOnHours", poh), ("powerCycles", pcy), ("reallocatedSectors", realloc),
                ("pendingSectors", pending),
                ("ssdLifeUsedPct", used if source != "ata-hdd" else None), ("temperatureC", temp)]
        st = selftest_ata(d)
    fields.update(temperatureC=temp, powerOnHours=poh, powerCycles=pcy, selfTest=st[0])
    if st[0] == "failed":
        caps.append((25, "the last self-test failed%s" % st[1]))
    # Nothing a percentage could honestly be computed from: the drive answered,
    # but it reports no wear figure, no error counter and no alarm of its own.
    # A bare "SMART passed" is a verdict, not a measurement - and before this
    # it came out as a confident 100% Good.
    if not any(evidence) and not caps:
        return emit(not_measured(R_UNSUP, source))
    if temp is not None and temp >= limit:
        caps.append((89, "running hot: %d °C (the drive's limit is %d °C)" % (temp, limit)))
    elif hot_attr:
        # Over the drive's OWN threshold (often stricter than ours) but below
        # ours: still heat, still the same cap, never counted twice.
        caps.append((89, "%s is over the drive's own temperature threshold now" % hot_attr))

    finish(source, L, E, deductions, caps, notes, fields, tool, flat, clean)


def scsi_counters(d):
    """A SAS/SCSI disk's own tallies, which smartctl reports instead of an ATA
    attribute table: the grown defect list (blocks retired since the factory -
    the SCSI name for reallocated sectors) and the error counter log's
    uncorrected read/write/verify errors. Either is None when the drive did
    not report it, which is NOT the same as zero."""
    defects = num(d.get("scsi_grown_defect_list"))
    unc = None
    log = d.get("scsi_error_counter_log")
    if isinstance(log, dict):
        for key in ("read", "write", "verify"):
            row = log.get(key)
            v = num(row.get("total_uncorrected_errors")) if isinstance(row, dict) else None
            if v is not None:
                unc = v if unc is None else unc + v
    return defects, unc


def selftest_ata(d):
    log = d.get("ata_smart_self_test_log") or {}
    for key in ("extended", "standard"):
        for row in ((log.get(key) or {}).get("table") or []):
            if not isinstance(row, dict):
                continue
            s = row.get("status") or {}
            text = str(s.get("string") or "")
            if re.search(r"abort|interrupt|progress", text, re.I):
                continue
            if s.get("passed") is True:
                return ("passed", "")
            if s.get("passed") is False:
                t = str((row.get("type") or {}).get("string") or "").strip()
                at = num(row.get("lifetime_hours"))
                return ("failed", " (%s%s)" % (t or "self-test", ", at %d h" % at if at is not None else ""))
    return ("none", "")


def selftest_nvme(d):
    log = d.get("nvme_self_test_log") or {}
    for row in (log.get("table") or []):
        if not isinstance(row, dict):
            continue
        v = num((row.get("self_test_result") or {}).get("value"))
        if v == 0:
            return ("passed", "")
        if v in (5, 6, 7):
            t = str((row.get("self_test_code") or {}).get("string") or "").strip()
            at = num(row.get("power_on_hours"))
            return ("failed", " (%s%s)" % (t or "self-test", ", at %d h" % at if at is not None else ""))
    return ("none", "")


def emmc(raw, rc):
    if rc in TIMEOUT_RCS:
        return emit(not_measured(R_TIMEOUT, "emmc"))
    if rc == 127:
        return emit(not_measured(R_EMMC_TOOL, "emmc"))
    def field(key):
        m = re.search(r"\[EXT_CSD_%s\]:\s*0x([0-9a-fA-F]+)" % key, raw)
        return int(m.group(1), 16) if m else None
    a, b, eol = field("DEVICE_LIFE_TIME_EST_TYP_A"), field("DEVICE_LIFE_TIME_EST_TYP_B"), field("PRE_EOL_INFO")
    est = [x for x in (a, b) if x]      # 0x00 = "not defined" by the drive
    if rc != 0 or not est:
        return emit(not_measured(R_UNSUP, "emmc"))
    worst = max(est)
    L = max(0, min(100, 100 - 10 * worst))
    caps = []
    if eol == 2:
        caps.append((89, "the drive reports its reserve blocks are running low (pre-EOL warning)"))
    elif eol == 3:
        caps.append((25, "the drive reports its reserve blocks are nearly used up (pre-EOL urgent)"))
    used = min(100, 10 * worst)
    fields = {"smartPassed": None, "temperatureC": None, "powerOnHours": None,
              "powerCycles": None, "lifeUsedPct": used, "availableSparePct": None,
              "reallocatedSectors": None, "pendingSectors": None,
              "uncorrectableSectors": None, "mediaErrors": None,
              "criticalWarning": None, "selfTest": "none"}
    finish("emmc", L, 100, [], caps, [], fields, "mmc-utils", [("ssdLifeUsedPct", used)])


def hidden(root):
    """Drives the storage controller hides from Linux, so there is no disk to
    read at all: an Intel RST 'RAID On' controller that remaps NVMe drives
    (the kernel counts them in the ahci device's remapped_nvme), or a RAID
    class controller (PCI class 0x0104, which is also how Intel VMD shows)
    with no disk underneath it. One entry per controller; [] when none."""
    base = os.path.join(root, "sys", "bus", "pci", "devices")
    found = []
    try:
        names = sorted(os.listdir(base))
    except OSError:
        names = []
    disk = re.compile(r"^(sd[a-z]+|nvme\d+n\d+|mmcblk\d+|vd[a-z]+|hd[a-z]+)$")
    for n in names:
        p = os.path.join(base, n)
        def rd(f):
            try:
                with open(os.path.join(p, f)) as fh:
                    return fh.read().strip()
            except OSError:
                return ""
        remap = rd("remapped_nvme")
        if remap.isdigit() and int(remap) > 0:
            found.append({"controller": n, "count": int(remap),
                          "health": not_measured(R_RAID, "nvme")})
            continue
        if not rd("class").lower().startswith("0x0104"):
            continue
        has = False
        top = p.rstrip(os.sep).count(os.sep)
        for dp, dns, _fs in os.walk(p):
            if dp.count(os.sep) - top >= 12:
                dns[:] = []
            if any(disk.match(x) for x in dns) or os.path.basename(dp) == "block" and dns:
                has = True
                break
        if not has:
            found.append({"controller": n, "count": 1, "health": not_measured(R_RAID, None)})
    out(json.dumps(found, ensure_ascii=True, separators=(",", ":")))


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "hidden":
        return hidden(sys.argv[2] if len(sys.argv) > 2 else "")
    raw = sys.stdin.buffer.read().decode("utf-8", "replace")
    rc = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].lstrip("-").isdigit() else 0
    if mode == "smart":
        kind = sys.argv[3] if len(sys.argv) > 3 else ""
        tried = len(sys.argv) > 4 and sys.argv[4] == "1"
        return smart(raw, rc, kind, tried)
    if mode == "emmc":
        return emmc(raw, rc)
    sys.exit(2)


main()
PYEOF
}

# Run a command with the health-read time limit (when `timeout` exists).
als_health_to() {
  if command -v timeout >/dev/null 2>&1; then timeout "${ALS_SMART_TIMEOUT:-30}" "$@"; else "$@"; fi
}

# The drive kind the contract names, from lsblk's NAME and ROTA. Used for a
# drive whose own data could not be read (the object still says what it is).
als_health_kind() {
  case "$1" in
    nvme*) echo nvme ;;
    mmcblk*) echo emmc ;;
    *) [ "$2" = "1" ] && echo ata-hdd || echo ata-ssd ;;
  esac
}

# Read ONE drive's health. $1 = kernel name (nvme0n1, sda, mmcblk0), $2 = kind.
# Sets DH_JSON (the contract C5 object), DH_LINE (the summary text) and DH_OUT
# (the helper's full output; its "S"/"N" lines are the old flat fields).
# Never fails the capture, never takes longer than two time limits (a read, and
# a second read only after switching SMART on for a drive that had it off).
als_drive_health() {
  local name="$1" kind="$2" py raw rc dev l
  DH_JSON=""; DH_LINE=""; DH_OUT=""
  py=$(command -v python3 2>/dev/null)
  if [ -z "$py" ]; then
    # No python3, no formula: say so, never a guess.
    DH_JSON="{\"measured\":false,\"reason\":\"this build cannot compute drive health\",\"action\":\"update the stick\",\"source\":\"$kind\"}"
    DH_LINE="Not measurable — this build cannot compute drive health — update the stick"
    return 0
  fi
  case "$name" in
    mmcblk*)
      # boot0/boot1/rpmb are views of the same chip: ask the chip itself.
      dev="/dev/$(printf '%s' "$name" | sed -E 's/(boot[0-9]+|rpmb)$//')"
      if command -v mmc >/dev/null 2>&1; then
        raw=$(als_health_to mmc extcsd read "$dev" 2>&1); rc=$?
      else
        raw=""; rc=127
      fi
      DH_OUT=$(printf '%s' "$raw" | "$py" -c "$(als_health_py)" emmc "$rc" 2>/dev/null)
      ;;
    *)
      if command -v smartctl >/dev/null 2>&1; then
        raw=$(als_health_to smartctl -j -x "/dev/$name" 2>/dev/null); rc=$?
        DH_OUT=$(printf '%s' "$raw" | "$py" -c "$(als_health_py)" smart "$rc" "$kind" 0 2>/dev/null)
        if [ "$DH_OUT" = "ENABLE" ]; then
          # SMART supported but switched off: switch it on once and read again.
          als_health_to smartctl -s on "/dev/$name" >/dev/null 2>&1
          raw=$(als_health_to smartctl -j -x "/dev/$name" 2>/dev/null); rc=$?
          DH_OUT=$(printf '%s' "$raw" | "$py" -c "$(als_health_py)" smart "$rc" "$kind" 1 2>/dev/null)
        fi
      else
        DH_OUT=$(printf '' | "$py" -c "$(als_health_py)" smart 127 "$kind" 0 2>/dev/null)
      fi
      ;;
  esac
  while IFS= read -r l; do
    case "$l" in
      "H "*) DH_JSON="${l#H }" ;;
      "L "*) DH_LINE="${l#L }" ;;
    esac
  done <<< "$DH_OUT"
  if [ -z "$DH_JSON" ]; then
    # The helper itself failed on this drive's answer. Still not a guess.
    DH_JSON="{\"measured\":false,\"reason\":\"the health calculation failed on this drive's answer\",\"action\":\"press Rescan; if it repeats, update the stick\",\"source\":\"$kind\"}"
    DH_LINE="Not measurable — the health calculation failed on this drive's answer — press Rescan; if it repeats, update the stick"
    DH_OUT=""
  fi
  return 0
}

# Add the helper's old flat fields (S key text / N key number) to the object
# being built (o_begin..o_end of one storage entry).
als_health_flat() {
  local tag key val
  while IFS=' ' read -r tag key val; do
    case "$tag" in
      S) o_s "$key" "$val" ;;
      N) o_n "$key" "$val" ;;
    esac
  done <<< "$1"
}

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
  # Drive health (contract C5): one timed smartctl JSON read (or mmc-utils for
  # an eMMC), as root, turned into a percentage by als_health_py. The old flat
  # fields come from the same read - there is no second scrape of the drive.
  als_drive_health "$D_NAME" "$(als_health_kind "$D_NAME" "$D_ROTA")"
  # One line per drive in the on-screen summary, e.g.
  #   nvme0n1: 94% Good (life remaining 94% reported by the drive)
  SMART_SUMMARY="$SMART_SUMMARY$D_NAME: $DH_LINE
"
  o_begin
  o_s model "$D_MODEL"; o_s capacity "$CAP"; o_s type "$DTYPE"
  o_s interface "$IFACE_D"; o_s serialNumber "$D_SERIAL"
  # The kernel name, so the kiosk can find a drive that reports no serial.
  o_s device "$D_NAME"
  als_health_flat "$DH_OUT"
  o_raw health "$DH_JSON"
  STOR_ELEMS="$STOR_ELEMS,$(o_end)"
done <<STOREOF
$(lsblk -bdP -o NAME,TYPE,TRAN,RM,SIZE,MODEL,SERIAL,ROTA 2>/dev/null)
STOREOF
STORAGE="[${STOR_ELEMS#,}]"

# Drives the storage controller hides from Linux (Intel RST "RAID On" with
# remapped NVMe, a RAID-class controller with no disk under it). They have no
# lsblk entry, so no storage[] entry and no health to read - and they are
# deliberately NOT added to storage[]: every storage[] entry is a drive the
# API expects a wipe record for, and one that can never be wiped here would
# hold its machine's certificate forever. They go in hiddenStorage instead,
# each with the contract's not-measurable reason and the fix (switch the BIOS
# to AHCI, then Rescan - after which they are ordinary drives).
HIDDEN_STORAGE="[]"
if command -v python3 >/dev/null 2>&1; then
  HIDDEN_STORAGE=$(python3 -c "$(als_health_py)" hidden "${ALS_SYS_ROOT:-}" 2>/dev/null)
  case "$HIDDEN_STORAGE" in "["*"]") ;; *) HIDDEN_STORAGE="[]" ;; esac
fi
[ "$HIDDEN_STORAGE" != "[]" ] && SMART_SUMMARY="${SMART_SUMMARY}hidden drive: Not measurable — behind a RAID/Intel RST controller — set the storage mode to AHCI in the BIOS, then press Rescan
"

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
p_obj hiddenStorage "$HIDDEN_STORAGE"
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
# One line per drive: "Drive health   nvme0n1: 94% Good (basis)".
if [ -n "$SMART_SUMMARY" ]; then
  while IFS= read -r l; do
    [ -n "$l" ] && printf "  %-14s %s\n" "Drive health" "$l"
  done <<< "$SMART_SUMMARY"
else
  printf "  %-14s %s\n" "Drive health" "no internal drive found"
fi
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
