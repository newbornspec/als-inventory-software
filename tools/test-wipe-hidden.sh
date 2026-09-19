#!/usr/bin/env bash
# Tests for the hidden-area check before a wipe (plan step 34, D-2):
# ata_hidden_areas, ata_hpa_remove, and what gui_wipe_one does with each answer.
#
# Why this exists. An ATA drive can hide its last sectors behind a Host
# Protected Area (HPA: a lowered max address) or a Device Configuration Overlay
# (DCO: a lowered NATIVE max). The kernel sizes the drive by what it reports,
# so the overwrite - and on many drives the secure erase - stopped at the
# visible end, and the drive was certified with the hidden sectors untouched.
# Owner decision D34: an HPA alone is removed TEMPORARILY (volatile, hdparm -N
# without the "p" prefix) and verified, else the wipe fails; a DCO fails the
# wipe (never --dco-restore); an unreadable answer does not block, it is
# recorded as a limitation.
#
#   bash tools/test-wipe-hidden.sh        (needs python3, or python on Windows)
#
# SAFETY - the pattern of test-wipe-ladder.sh:
#   - the "device" is a temporary REGULAR FILE; the harness refuses any /dev
#     target, and gui_wipe_one's `[ ! -b ]` is relaxed to `[ ! -e ]` only in
#     the extracted copy;
#   - `hdparm` is a SCRIPTED STUB: it answers -I / -N / --dco-identify from
#     fixtures and records a volatile -N <n> in a state file. Anything else -
#     --dco-restore, --dco-setmax, --dco-freeze, a permanent -N p<n>, any
#     --security-* - is a TRIPWIRE: logged to trip.log, exit 99. The last test
#     asserts trip.log is empty;
#   - every other tool that can write to a disk (shred, dd, blkdiscard, nvme,
#     rtcwake, wipefs, sgdisk) is a tripwire that only logs; the erase helpers
#     (firmware_erase, run_overwrite, verify_erased) are logging stubs;
#   - PATH holds nothing else but wrappers for read-only tools.

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s   (%s)\n' "$1" "$2"; }

PYREAL=""
for c in python3 python; do
  p=$(command -v "$c" 2>/dev/null) || continue
  if "$p" -c 'import sys' >/dev/null 2>&1; then PYREAL="$p"; break; fi
done
[ -n "$PYREAL" ] || { echo "needs python3 (or python)"; exit 1; }

extract() {
  awk -v fn="$2" '
    $0 ~ "^"fn"\\(\\) \\{" { on=1 }
    on { print }
    on && /^}/ { exit }
  ' "$1"
}

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
TRIP="$T/trip"; SAFE="$T/safe"; NOHD="$T/nohd"; LOG="$T/calls.log"; TRIPLOG="$T/trip.log"; ST="$T/hpa.state"
mkdir -p "$TRIP" "$SAFE" "$NOHD"
: > "$TRIPLOG"
case "$T" in /dev/*) echo "REFUSING: the temp dir is under /dev"; exit 1 ;; esac

for t in shred dd blkdiscard nvme rtcwake wipefs sgdisk; do
  printf '#!/bin/sh\necho "%s $*" >> "%s"\nexit 0\n' "$t" "$LOG" > "$TRIP/$t"
  chmod +x "$TRIP/$t"
  cp "$TRIP/$t" "$NOHD/$t"
done

# The hdparm stub. State: $ST holds "CUR NATIVE" (what -N reports).
#   STUB_N      ok (default) | invalid ("HPA setting seems invalid") | garbage | fail
#   STUB_I      both (default: HPA + DCO feature sets) | nodco | nohpa | empty
#               (neither feature set) | fail (no answer at all, e.g. behind RAID)
#   STUB_REAL   the DCO "Real max sectors" (unset: --dco-identify fails)
#   STUB_SET    ok (default) | fail (rejected) | ignore (accepted, nothing changes)
#   STUB_AMAX   1: an ACS-3 drive with ACCESSIBLE MAX ADDRESS (IDENTIFY word 119
#               bit 8). hdparm 9.65 then prints the AMA wording for -N (two
#               lines when lowered, exactly as hdparm.c prints them) and turns
#               ANY -N <n> - "p" or not - into SET ACCESSIBLE MAX ADDRESS EXT,
#               which ACS-3 defines as non-volatile: a PERMANENT change to the
#               customer's drive, so on such a drive a SET is a TRIPWIRE too.
#   STUB_STD    the ATA major versions -I lists under "Standards: Supported:"
#               (e.g. "8 7 6 5"; unset: no Standards section). 10 = ACS-3.
cat > "$TRIP/hdparm" <<EOF
#!/bin/sh
echo "hdparm \$*" >> "$LOG"
for a in "\$@"; do
  case "\$a" in
    --dco-restore|--dco-setmax|--dco-freeze|--security-*|--yes-i-know-what-i-am-doing|p[0-9]*)
      echo "hdparm \$*" >> "$TRIPLOG"; echo "TRIPWIRE: hdparm \$*" >&2; exit 99 ;;
    /dev/*) echo "hdparm REFUSED \$*" >> "$TRIPLOG"; exit 99 ;;
  esac
done
EOF
cat >> "$TRIP/hdparm" <<'EOF'
op="$1"
case "$op" in
  -I)
    [ "$(printenv STUB_I)" = fail ] && { echo " HDIO_DRIVE_CMD(identify) failed: Invalid argument" >&2; exit 5; }
    echo ""
    echo "ATA device, with non-removable media"
    if [ -n "$(printenv STUB_STD)" ]; then
      echo "Standards:"
      echo "	Used: unknown (minor revision code 0x011b) "
      echo "	Supported: $(printenv STUB_STD) "
      echo "	Likely used: 9"
    fi
    echo "Commands/features:"
    echo "	Enabled	Supported:"
    echo "	   *	SMART feature set"
    case "$(printenv STUB_I)" in
      nodco) echo "	   *	Host Protected Area feature set" ;;
      nohpa) echo "	   *	Device Configuration Overlay feature set" ;;
      empty) ;;
      *) echo "	   *	Host Protected Area feature set"
         echo "	   *	Device Configuration Overlay feature set" ;;
    esac
    ;;
  -N)
    if [ "$#" -ge 3 ]; then
      # a SET: -N <count> <dev>
      if [ "$(printenv STUB_AMAX)" = 1 ]; then
        echo "hdparm $* (SET ACCESSIBLE MAX ADDRESS EXT: permanent)" >> "$(printenv TRIPLOG)"
        echo "TRIPWIRE: a permanent max-address change" >&2; exit 99
      fi
      case "$(printenv STUB_SET)" in
        fail) echo " SET_MAX_ADDRESS failed" >&2; exit 5 ;;
        ignore) ;;
        *) echo "$2 $(cut -d' ' -f2 < "$(printenv ST)")" > "$(printenv ST)" ;;
      esac
      echo " setting max visible sectors to $2 (temporary)"
      exit 0
    fi
    set -- $(cat "$(printenv ST)")
    case "$(printenv STUB_N)" in
      fail) echo " READ_NATIVE_MAX_ADDRESS_EXT failed" >&2; exit 5 ;;
      garbage) echo "SG_IO: bad/missing sense data, sb[]:  70 00 05"; exit 0 ;;
      invalid) echo " max sectors   = $1/$2, HPA setting seems invalid (buggy kernel device driver?)"; exit 0 ;;
    esac
    if [ "$(printenv STUB_AMAX)" = 1 ]; then
      if [ "$1" = "$2" ]; then echo " max sectors   = $1/$2, ACCESSIBLE MAX ADDRESS disabled"
      else echo " max sectors   = $1/$2, ACCESSIBLE MAX ADDRESS enabled"
           echo "Power cycle your device after every ACCESSIBLE MAX ADDRESS"; fi
      exit 0
    fi
    if [ "$1" = "$2" ]; then echo " max sectors   = $1/$2, HPA is disabled"
    else echo " max sectors   = $1/$2, HPA is enabled"; fi
    ;;
  --dco-identify)
    r="$(printenv STUB_REAL)"
    [ -n "$r" ] || { echo " HDIO_DRIVE_CMD(dco_identify) failed: Input/output error" >&2; exit 5; }
    echo "DCO Revision: 0x0002"
    echo "The following features can be selectively disabled via DCO:"
    echo "	Transfer modes:"
    echo "		 udma0 udma1 udma2 udma3 udma4 udma5 udma6"
    echo "	Real max sectors: $r"
    echo "	ATA command/feature sets:"
    ;;
  *) echo "UNEXPECTED hdparm $*" >> "$(printenv TRIPLOG)"; exit 99 ;;
esac
exit 0
EOF
chmod +x "$TRIP/hdparm"

for t in head tr sed grep basename wc cat printenv cmp date cut awk; do
  real=$(command -v "$t") || { echo "missing $t"; exit 1; }
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$real" > "$SAFE/$t"
  chmod +x "$SAFE/$t"
done
for t in findmnt readlink; do
  printf '#!/bin/sh\nexit 0\n' > "$SAFE/$t"; chmod +x "$SAFE/$t"
done
# lsblk: one internal SATA disk (the identity), nothing else.
cat > "$SAFE/lsblk" <<'EOF'
#!/bin/sh
case "$*" in
  *SERIAL,MODEL*) echo 'SERIAL="WD-WCC4E1234567" MODEL="WDC WD5000AAKX" SIZE="500107862016" TRAN="sata" ROTA="1" WWN="0x50014ee2b1234567"' ;;
esac
exit 0
EOF
chmod +x "$SAFE/lsblk"

SRC="$HERE/hardware-audit.sh"
FUNCS="$(grep -E '^(esc|o_begin|o_s|o_s0|o_n|o_raw|o_end|als_utc_now)\(\) \{' "$SRC")
$(grep '^ALS_TOOL_VERSION=' "$SRC")
$(extract "$SRC" als_json_array)
$(extract "$SRC" wr_limit)
$(extract "$SRC" als_lsblk_val)
$(extract "$SRC" als_lsblk_unescape)
$(extract "$SRC" als_drive_identity)
$(extract "$SRC" wipe_result)
$(extract "$SRC" clear_label)
$(extract "$SRC" als_disk_is_usb)
$(extract "$SRC" als_boot_disk)
$(extract "$SRC" ata_hidden_areas)
$(extract "$SRC" ata_hpa_remove)
$(extract "$SRC" gui_wipe_one | sed 's/\[ ! -b "\$dev" \]/[ ! -e "$dev" ]/')"
case "$FUNCS" in *'ata_hidden_areas() {'*'[ ! -e "$dev" ]'*) ;; *) echo "could not extract gui_wipe_one / ata_hidden_areas - refusing to run"; exit 1 ;; esac
# Every function gui_wipe_one needs that this harness does not stub must be here.
for f in ata_kernel_whole smart_counts wipe_assess als_wipe_lock als_wipe_unlock; do
  if grep -q "^$f() {" "$SRC"; then FUNCS="$FUNCS
$(extract "$SRC" "$f")"; fi
done

# STUB_KSIZE: follow (default: the kernel's size follows the drive after a
# rescan) | stale (the kernel keeps the old, smaller size).
# STUB_KSEC=<n>: the kernel sees exactly n sectors, whatever the drive says.
# STUB_RESET=1: the drive is reset during the erase, and its HPA comes back.
STUBS='
firmware_erase() { echo "firmware_erase $*" >> "$LOG"
  [ "${STUB_RESET:-0}" = 1 ] && echo "$INITIAL" > "$ST"
  if [ "${STUB_FW:-fail}" = "ok" ]; then M="ATA enhanced secure erase"; FW_LEVEL=purge; return 0; fi; return 1; }
run_overwrite()  { echo "run_overwrite $*" >> "$LOG"; return 0; }
verify_erased()  { echo "verify_erased $*" >> "$LOG"; VE_LABEL=zeros; VE_WHY=""; VE_MIB=10; return 0; }
als_part_starts() { printf "1048576"; }
blockdev() {
  case "$1" in
    --getss) echo 512 ;;
    --getsize64)
      if [ -n "${STUB_KSEC:-}" ]; then set -- "$STUB_KSEC"
      elif [ "${STUB_KSIZE:-follow}" = stale ]; then set -- $INITIAL; else set -- $(command cat "$ST"); fi
      echo $(( $1 * 512 )) ;;
  esac
}
sleep() { :; }
smartctl() { echo "  5 Reallocated_Sector_Ct   0x0033   100   100   010    Pre-fail  Always       -       0"
             echo "197 Current_Pending_Sector  0x0012   100   100   000    Old_age   Always       -       0"; }
cat() { case "$*" in */queue/rotational) echo 1 ;; */removable) echo 0 ;; *) command cat "$@" ;; esac; }
'

DEV="$T/sdz"
: > "$DEV"
case "$DEV" in /dev/*) echo "REFUSING: the test device must never be under /dev"; exit 1 ;; esac

# wipe "CUR NATIVE" <env...> -> OUT, RESULT, CALLS
wipe() {
  local initial="$1"; shift
  echo "$initial" > "$ST"
  : > "$LOG"
  OUT=$(env -i PATH="${HPATH:-$TRIP:$SAFE}" LOG="$LOG" TRIPLOG="$TRIPLOG" ST="$ST" INITIAL="$initial" \
        DEV="${WDEV:-$DEV}" ALS_SYS_ROOT="$T/root" "$@" "$BASH" -c "$FUNCS
$STUBS
gui_wipe_one \"\$DEV\" \"\${WANT:-auto}\"" 2>&1)
  RESULT=$(printf '%s\n' "$OUT" | sed -n 's/^WIPE_RESULT //p' | tail -n1)
  CALLS=$(command cat "$LOG")
}
field() { printf '%s' "$RESULT" | "$PYREAL" -c '
import json, sys
v = json.loads(sys.stdin.read()).get(sys.argv[1])
sys.stdout.write("" if v is None else (json.dumps(v) if isinstance(v, (list, dict)) else str(v)))' "$1" 2>/dev/null; }
parses() { printf '%s' "$RESULT" | "$PYREAL" -c 'import json,sys; json.loads(sys.stdin.read())' 2>/dev/null; }
# ha "CUR NATIVE" <env...> -> HA (the printed state) and HAV (HA_HPA HA_DCO HA_CUR HA_NATIVE)
ha() {
  local initial="$1"; shift
  echo "$initial" > "$ST"
  : > "$LOG"
  local r
  r=$(env -i PATH="${HPATH:-$TRIP:$SAFE}" LOG="$LOG" TRIPLOG="$TRIPLOG" ST="$ST" DEV="$DEV" "$@" "$BASH" -c "$FUNCS
p=\$(ata_hidden_areas \"\$DEV\")
ata_hidden_areas \"\$DEV\" >/dev/null
printf '%s|%s %s %s %s|%s' \"\$p\" \"\$HA_HPA\" \"\$HA_DCO\" \"\$HA_CUR\" \"\$HA_NATIVE\" \"\$HA_STATE\"" 2>&1)
  HA=${r%%|*}; r=${r#*|}; HAV=${r%%|*}; HAS=${r#*|}
  CALLS=$(command cat "$LOG")
}

echo "the tripwire works"
echo "976773168 976773168" > "$ST"
env -i PATH="$TRIP:$SAFE" ST="$ST" "$TRIP/hdparm" --dco-restore "$DEV" >/dev/null 2>&1
rc=$?
[ "$rc" = 99 ] && grep -q -- '--dco-restore' "$TRIPLOG" && ok "self-test: a --dco-restore call trips the stub (exit 99, logged)" || bad "self-test: a --dco-restore call trips the stub" "rc=$rc"
env -i PATH="$TRIP:$SAFE" ST="$ST" "$TRIP/hdparm" -N p976773168 "$DEV" >/dev/null 2>&1
rc=$?
[ "$rc" = 99 ] && grep -q -- '-N p976773168' "$TRIPLOG" && ok "self-test: a permanent -N p<n> trips the stub" || bad "self-test: a permanent -N p<n> trips the stub" "rc=$rc"
: > "$TRIPLOG"

echo "ata_hidden_areas reads the drive's answer"
ha "976771055 976773168" STUB_REAL=976773168
[ "$HA" = hpa-present ] && [ "$HAS" = hpa-present ] && ok "'max sectors = 976771055/976773168, HPA is enabled': hpa-present" || bad "'max sectors = 976771055/976773168, HPA is enabled': hpa-present" "$HA / $HAV"
[ "$HAV" = "present none 976771055 976773168" ] && ok "  ... HPA present, DCO none, current and native counts kept" || bad "  ... HPA present, DCO none, current and native counts kept" "$HAV"
printf '%s\n' "$CALLS" | grep -qE 'hdparm -N p?[0-9]' && bad "  ... reading never sets anything" "$CALLS" || ok "  ... reading never sets anything"
ha "976773168 976773168" STUB_REAL=976773168
[ "$HA" = none ] && ok "current = native, DCO real max = native: none" || bad "current = native, DCO real max = native: none" "$HA / $HAV"
ha "976773168 976773168" STUB_REAL=976773167
[ "$HA" = none ] && ok "DCO real max printed as the max LBA (native - 1): none, not an overlay" || bad "DCO real max printed as the max LBA (native - 1): none" "$HA / $HAV"
ha "976773168 976773168" STUB_REAL=1000215216
[ "$HA" = dco-present ] && ok "DCO real max above the native max: dco-present" || bad "DCO real max above the native max: dco-present" "$HA / $HAV"
ha "976771055 976773168" STUB_REAL=1000215216
[ "$HA" = dco-present ] && ok "an HPA AND a DCO: dco-present wins" || bad "an HPA AND a DCO: dco-present wins" "$HA / $HAV"
ha "976773168 976773168" STUB_I=nodco
[ "$HA" = none ] && ok "no DCO feature set in hdparm -I: no DCO can exist - none" || bad "no DCO feature set in hdparm -I: none" "$HA / $HAV"
case "$CALLS" in *dco-identify*) bad "  ... and --dco-identify is not even asked" "$CALLS" ;; *) ok "  ... and --dco-identify is not even asked" ;; esac
ha "976773168 976773168"
[ "$HA" = unknown ] && ok "DCO feature set present but --dco-identify fails: unknown" || bad "DCO feature set present but --dco-identify fails: unknown" "$HA / $HAV"
ha "976773168 976773168" STUB_N=garbage STUB_REAL=976773168
[ "$HA" = unknown ] && ok "hdparm -N answers something unparsable: unknown" || bad "hdparm -N answers something unparsable: unknown" "$HA / $HAV"
ha "976771055 976773168" STUB_N=invalid STUB_REAL=976773168
[ "$HA" = unknown ] && ok "'HPA setting seems invalid' (buggy driver): unknown, not trusted" || bad "'HPA setting seems invalid': unknown" "$HA / $HAV"
ha "976773168 976773168" STUB_N=fail STUB_I=fail
[ "$HA" = unknown ] && ok "nothing answers at all (RAID/RST): unknown" || bad "nothing answers at all (RAID/RST): unknown" "$HA / $HAV"
ha "976773168 976773168" STUB_N=fail STUB_I=empty STUB_STD="8 7 6 5"
[ "$HA" = none ] && ok "-N fails, -I lists neither the HPA nor the DCO feature set, pre-ACS-3 drive: none" || bad "-N fails, -I lists neither feature set, pre-ACS-3: none" "$HA / $HAV"
# ACS-3 made the HPA feature-set bit (word 82 bit 10) obsolete: such a drive
# can have a lowered capacity (ACCESSIBLE MAX ADDRESS) that -I never prints.
ha "976773168 976773168" STUB_N=fail STUB_I=empty STUB_STD="11 10 9 8"
[ "$HA" = unknown ] && ok "-N fails, no HPA feature set, but an ACS-3+ drive (AMA possible): unknown, not none" || bad "-N fails, no HPA feature set, ACS-3+ drive: unknown" "$HA / $HAV"
ha "976773168 976773168" STUB_N=fail STUB_I=empty
[ "$HA" = unknown ] && ok "-N fails, no HPA feature set, standard not listed: unknown" || bad "-N fails, no HPA feature set, standard not listed: unknown" "$HA / $HAV"
ha "976771055 976773168" STUB_AMAX=1 STUB_REAL=976773168
[ "$HA" = hpa-present ] && ok "'ACCESSIBLE MAX ADDRESS enabled' (ACS-3 AMA wording, two lines): the lowered capacity is seen" || bad "AMA wording: hpa-present" "$HA / $HAV"
ha "976773168 976773168" STUB_N=fail STUB_I=nodco
[ "$HA" = unknown ] && ok "HPA feature set present but -N unreadable: unknown" || bad "HPA feature set present but -N unreadable: unknown" "$HA / $HAV"
ha "976773168 976773170" STUB_REAL=976773168
[ "$HA" = hpa-present ] && ok "a 2-sector HPA is still an HPA" || bad "a 2-sector HPA is still an HPA" "$HA / $HAV"
ha "976775000 976773168" STUB_REAL=976773168
[ "$HA" = unknown ] && ok "current above native (nonsense): unknown" || bad "current above native (nonsense): unknown" "$HA / $HAV"
HPATH="$NOHD:$SAFE" ha "976773168 976773168"
[ "$HA" = unknown ] && ok "hdparm not installed: unknown" || bad "hdparm not installed: unknown" "$HA / $HAV"

echo "an HPA alone is removed TEMPORARILY, verified, and the drive wiped whole"
wipe "976771055 976773168" STUB_REAL=976773168
case "$CALLS" in *"hdparm -N 976773168 $DEV"*) ok "hdparm -N 976773168 (no 'p': the volatile setting)" ;; *) bad "hdparm -N 976773168 (no 'p': the volatile setting)" "$CALLS" ;; esac
printf '%s\n' "$CALLS" | grep -q 'hdparm -N p' && bad "never a permanent -N p<n>" "$CALLS" || ok "never a permanent -N p<n>"
first_set=$(printf '%s\n' "$CALLS" | grep -n "hdparm -N 976773168 " | head -n1 | cut -d: -f1)
first_erase=$(printf '%s\n' "$CALLS" | grep -nE '^(firmware_erase|run_overwrite)' | head -n1 | cut -d: -f1)
[ -n "$first_set" ] && [ -n "$first_erase" ] && [ "$first_set" -lt "$first_erase" ] && ok "  ... removed BEFORE the firmware erase or the overwrite" || bad "  ... removed BEFORE the erase" "$CALLS"
[ "$(field status)" = wiped ] && ok "  ... status wiped" || bad "  ... status wiped" "$RESULT"
[ "$(field hiddenAreas)" = hpa-removed ] && ok "  ... hiddenAreas: hpa-removed" || bad "  ... hiddenAreas: hpa-removed" "$RESULT"
case "$(field method)" in *"; hidden areas: HPA removed temporarily (976771055 -> 976773168 sectors)") ok "  ... the method ends '; hidden areas: HPA removed temporarily (...)'" ;; *) bad "  ... the method names the removal" "$(field method)" ;; esac
[ "$(field limitations)" = "[]" ] && ok "  ... no limitation (the whole drive was reached)" || bad "  ... no limitation" "$(field limitations)"

echo "a removal that does not take: failed, and NOTHING is erased"
wipe "976771055 976773168" STUB_REAL=976773168 STUB_SET=fail
[ "$(field status)" = failed ] && ok "the drive rejects hdparm -N: failed" || bad "the drive rejects hdparm -N: failed" "$RESULT"
case "$CALLS" in *firmware_erase*|*run_overwrite*|*shred*) bad "  ... no firmware erase and no overwrite" "$CALLS" ;; *) ok "  ... no firmware erase and no overwrite" ;; esac
[ "$(printf '%s\n' "$CALLS" | grep -c 'hdparm -N 976773168 ')" = 2 ] && ok "  ... tried twice (hdparm's manual: 'just try again')" || bad "  ... tried twice" "$CALLS"
[ "$(field hiddenAreas)" = hpa-present ] && ok "  ... hiddenAreas: hpa-present" || bad "  ... hiddenAreas: hpa-present" "$RESULT"
case "$(field reason)" in *"hidden area (HPA) of 2113 sectors could not be removed"*) ok "  ... the reason names the area ($(field reason))" ;; *) bad "  ... the reason names the area" "$(field reason)" ;; esac
[ "$(field sanitisationLevel)" = none ] && ok "  ... sanitisationLevel none" || bad "  ... sanitisationLevel none" "$RESULT"
wipe "976771055 976773168" STUB_REAL=976773168 STUB_SET=ignore
[ "$(field status)" = failed ] && case "$CALLS" in *firmware_erase*|*run_overwrite*) false ;; *) true ;; esac \
  && ok "accepted but the drive still shows 976771055: failed, nothing erased" || bad "accepted but the drive still shows 976771055: failed" "$RESULT"
wipe "976771055 976773168" STUB_REAL=976773168 STUB_KSIZE=stale
[ "$(field status)" = failed ] && case "$CALLS" in *firmware_erase*|*run_overwrite*) false ;; *) true ;; esac \
  && ok "the drive is whole but the KERNEL still sees the old size: failed, nothing erased" || bad "the kernel still sees the old size: failed" "$RESULT"
case "$(field reason)" in *kernel*) ok "  ... the reason says it is the kernel's size" ;; *) bad "  ... the reason says it is the kernel's size" "$(field reason)" ;; esac
wipe "976771055 976773168" STUB_REAL=976773168 STUB_RESET=1
[ "$(field status)" = failed ] && case "$(field reason)" in *"came back during the wipe"*) true ;; *) false ;; esac \
  && ok "the HPA comes back during the erase (a drive reset): failed, not certified" || bad "the HPA comes back during the erase: failed" "$RESULT"

echo "an ACS-3 ACCESSIBLE MAX ADDRESS cannot be lowered back temporarily: failed, drive untouched"
# hdparm 9.65 (Ubuntu 24.04) sends SET ACCESSIBLE MAX ADDRESS EXT for ANY -N <n>
# on such a drive, and ACS-3 has no volatile form of it - the "temporary"
# removal would permanently reconfigure the customer's drive.
wipe "976771055 976773168" STUB_AMAX=1 STUB_REAL=976773168
[ "$(field status)" = failed ] && ok "AMA-lowered drive: failed" || bad "AMA-lowered drive: failed" "$RESULT"
case "$CALLS" in *"-N 976773168 "*) bad "  ... no max-address change is even attempted" "$CALLS" ;; *) ok "  ... no max-address change is even attempted" ;; esac
case "$CALLS" in *firmware_erase*|*run_overwrite*) bad "  ... nothing erased" "$CALLS" ;; *) ok "  ... nothing erased" ;; esac
[ "$(field hiddenAreas)" = hpa-present ] && ok "  ... hiddenAreas: hpa-present" || bad "  ... hiddenAreas: hpa-present" "$RESULT"
case "$(field reason)" in *"2113 sectors"*permanent*) ok "  ... the reason names the area and why it was left alone" ;; *) bad "  ... the reason names the area and why" "$(field reason)" ;; esac
case "$(field method)" in *"; hidden areas: "*"accessible max address"*) ok "  ... and so does the method" ;; *) bad "  ... and so does the method" "$(field method)" ;; esac
wipe "976773168 976773168" STUB_AMAX=1 STUB_REAL=976773168
[ "$(field status)" = wiped ] && [ "$(field hiddenAreas)" = none ] && ok "AMA drive at its full size ('ACCESSIBLE MAX ADDRESS disabled'): wiped, none" || bad "AMA drive at full size: wiped, none" "$RESULT"
# The same process-level rule for any -N wording hdparm might print: only the
# legacy "HPA is enabled" answer promises the volatile SET MAX ADDRESS path.
wipe "976771055 976773168" STUB_N=invalid STUB_REAL=976773168
case "$CALLS" in *"-N 976773168 "*) bad "an untrusted -N answer: nothing is set" "$CALLS" ;; *) ok "an untrusted -N answer: nothing is set" ;; esac

echo "the drive is whole but the KERNEL sees less: failed, nothing erased"
# A previous attempt in this boot removed the HPA (volatile) but libata kept its
# probe-time size: the drive now says current = native, the kernel does not.
wipe "976773168 976773168" STUB_REAL=976773168 STUB_KSEC=976771055
[ "$(field status)" = failed ] && ok "drive current = native, kernel 2113 sectors short: failed (was 'wiped, hidden areas: none')" || bad "drive whole, kernel short: failed" "$RESULT"
case "$CALLS" in *firmware_erase*|*run_overwrite*) bad "  ... nothing erased" "$CALLS" ;; *) ok "  ... nothing erased" ;; esac
case "$(field reason)" in *kernel*) ok "  ... the reason says it is the kernel's size ($(field reason))" ;; *) bad "  ... the reason says it is the kernel's size" "$(field reason)" ;; esac
wipe "976773168 976773168" STUB_KSEC=976771055
[ "$(field status)" = failed ] && case "$CALLS" in *firmware_erase*|*run_overwrite*) false ;; *) true ;; esac \
  && ok "the same with the DCO unreadable (state unknown, native known): failed, nothing erased" || bad "unknown state, kernel short: failed" "$RESULT"
wipe "976773168 976773168" STUB_N=garbage STUB_REAL=976773168 STUB_KSEC=976771055
[ "$(field status)" = wiped ] && ok "native size unreadable: nothing to compare with, the unknown limitation stands (wiped)" || bad "native unreadable: wiped with limitation" "$RESULT"

echo "a DCO: failed, named, never restored"
wipe "976773168 976773168" STUB_REAL=1000215216
[ "$(field status)" = failed ] && ok "DCO present: failed" || bad "DCO present: failed" "$RESULT"
[ "$(field hiddenAreas)" = dco-present ] && ok "  ... hiddenAreas: dco-present" || bad "  ... hiddenAreas: dco-present" "$RESULT"
case "$(field reason)" in *"hidden area (DCO) hides 23442048 sectors"*) ok "  ... the reason names the area" ;; *) bad "  ... the reason names the area" "$(field reason)" ;; esac
case "$(field method)" in *"; hidden areas: DCO present"*) ok "  ... and so does the method" ;; *) bad "  ... and so does the method" "$(field method)" ;; esac
case "$CALLS" in *firmware_erase*|*run_overwrite*) bad "  ... nothing erased" "$CALLS" ;; *) ok "  ... nothing erased" ;; esac
case "$CALLS" in *dco-restore*|*dco-setmax*|*"-N 1000215216"*) bad "  ... and the DCO is left alone" "$CALLS" ;; *) ok "  ... and the DCO is left alone" ;; esac
wipe "976771055 976773168" STUB_REAL=1000215216
[ "$(field status)" = failed ] && case "$CALLS" in *"-N 976773168 "*) false ;; *) true ;; esac \
  && ok "HPA and DCO: failed on the DCO, and the HPA is not touched either" || bad "HPA and DCO: failed, HPA untouched" "$RESULT / $CALLS"

echo "unknown does NOT block (owner decision D34) - it is recorded"
wipe "976773168 976773168" STUB_N=garbage STUB_I=fail
[ "$(field status)" = wiped ] && ok "unreadable hidden areas: the wipe goes ahead" || bad "unreadable hidden areas: the wipe goes ahead" "$RESULT"
[ "$(field hiddenAreas)" = unknown ] && ok "  ... hiddenAreas: unknown" || bad "  ... hiddenAreas: unknown" "$RESULT"
case "$(field limitations)" in *'"hidden areas could not be checked'*) ok "  ... limitation: hidden areas could not be checked" ;; *) bad "  ... limitation: hidden areas could not be checked" "$(field limitations)" ;; esac
case "$(field method)" in *"; hidden areas: could not be checked") ok "  ... the method says so" ;; *) bad "  ... the method says so" "$(field method)" ;; esac
wipe "976771055 976773168"
[ "$(field status)" = wiped ] && [ "$(field hiddenAreas)" = hpa-removed ] && case "$(field limitations)" in *DCO*) true ;; *) false ;; esac \
  && ok "HPA removed but the DCO unreadable: wiped, hpa-removed, with a DCO limitation" || bad "HPA removed but the DCO unreadable" "$RESULT"
wipe "976773168 976773168" STUB_REAL=976773168
[ "$(field status)" = wiped ] && [ "$(field hiddenAreas)" = none ] && ok "no hidden area: wiped, hiddenAreas none" || bad "no hidden area: wiped, hiddenAreas none" "$RESULT"
case "$(field method)" in *"; hidden areas: none") ok "  ... method ends '; hidden areas: none'" ;; *) bad "  ... method ends '; hidden areas: none'" "$(field method)" ;; esac
case "$CALLS" in *"-N 976773168 "*) bad "  ... nothing is set on a drive with no HPA" "$CALLS" ;; *) ok "  ... nothing is set on a drive with no HPA" ;; esac
parses && ok "  ... the WIPE_RESULT line parses as JSON" || bad "  ... the WIPE_RESULT line parses as JSON" "$RESULT"

echo "NVMe has no HPA/DCO: not asked"
mkdir -p "$T/n"; : > "$T/n/nvme0n1"
WDEV="$T/n/nvme0n1" wipe "976773168 976773168"
case "$CALLS" in *hdparm*) bad "an NVMe drive: hdparm never runs" "$CALLS" ;; *) ok "an NVMe drive: hdparm never runs" ;; esac
[ -z "$(field hiddenAreas)" ] && ok "  ... and hiddenAreas is left out (not applicable), not 'unknown'" || bad "  ... hiddenAreas left out" "$RESULT"

echo "a refusal says nothing about hidden areas (nothing was looked at)"
wipe "976771055 976773168" STUB_REAL=976773168
OUT=$(env -i PATH="$TRIP:$SAFE" LOG="$LOG" TRIPLOG="$TRIPLOG" ST="$ST" DEV="$DEV" "$BASH" -c "$FUNCS
$STUBS
gui_wipe_one \"\$DEV\" auto NOT-THIS-SERIAL" 2>&1)
RESULT=$(printf '%s\n' "$OUT" | sed -n 's/^WIPE_RESULT //p' | tail -n1)
[ "$(field status)" = refused ] && [ -z "$(field hiddenAreas)" ] && [ -z "$(field limitations)" ] \
  && ok "identity mismatch: refused, no hiddenAreas, no limitations" || bad "identity mismatch: refused, no hiddenAreas" "$RESULT"

echo "the engine never trips the hdparm stub"
live=$(grep -n -- '--dco-restore\|--dco-setmax\|--dco-freeze' "$SRC" | grep -v '^[0-9]*:[[:space:]]*#')
[ -z "$live" ] && ok "no executable --dco-restore / --dco-setmax / --dco-freeze in hardware-audit.sh" || bad "no executable DCO-changing call in hardware-audit.sh" "$live"
live=$(grep -nE 'hdparm[^#]*-N[[:space:]]+"?p' "$SRC")
[ -z "$live" ] && ok "no permanent hdparm -N p<n> in hardware-audit.sh" || bad "no permanent hdparm -N p<n>" "$live"
[ ! -s "$TRIPLOG" ] && ok "no test run tripped the hdparm stub (no DCO change, no permanent -N, no /dev path)" || bad "no test run tripped the hdparm stub" "$(command cat "$TRIPLOG")"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
