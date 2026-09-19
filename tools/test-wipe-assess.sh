#!/usr/bin/env bash
# Tests for what a wipe record says it achieved, and why (plan step 38, D-4):
# wipe_assess (the level + limitations), smart_counts (SMART 5 / 197),
# FW_WHY / FW_TRIED in firmware_erase and ata_secure_erase, and the WIPE_RESULT
# fields gui_wipe_one emits from them.
#
# Why this exists. A requested Purge could silently become an overwrite - most
# often on a SATA SSD the BIOS left frozen - and the record said only what was
# achieved, never that something stronger had been asked for, nor why. And a
# drive with reallocated sectors was certified the same as a healthy one after
# an overwrite or a NORMAL ATA secure erase, neither of which can address a
# retired sector. Owner decision D38: that is Clear, with a limitation naming
# the counts - never Purge.
#
#   bash tools/test-wipe-assess.sh        (needs python3, or python on Windows)
#
# SAFETY - the pattern of test-wipe-ladder.sh:
#   - the "device" is a temporary REGULAR FILE; the harness refuses any /dev
#     target, and gui_wipe_one's `[ ! -b ]` is relaxed to `[ ! -e ]` only in
#     the extracted copy;
#   - `hdparm` is a scripted stub that only LOGS: its --security-* calls change
#     nothing, and --dco-restore / --dco-setmax / a permanent -N p<n> / any
#     /dev path trip it (trip.log, asserted empty at the end);
#   - shred, dd, blkdiscard, nvme, rtcwake, wipefs, sgdisk are tripwires that
#     only log; run_overwrite and verify_erased are logging stubs; smartctl is
#     a shell function that prints a fixture table;
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
TRIP="$T/trip"; SAFE="$T/safe"; NOHD="$T/nohd"; LOG="$T/calls.log"; TRIPLOG="$T/trip.log"
mkdir -p "$TRIP" "$SAFE" "$NOHD"
: > "$TRIPLOG"
case "$T" in /dev/*) echo "REFUSING: the temp dir is under /dev"; exit 1 ;; esac

for t in shred dd blkdiscard nvme rtcwake wipefs sgdisk; do
  printf '#!/bin/sh\necho "%s $*" >> "%s"\nexit 0\n' "$t" "$LOG" > "$TRIP/$t"
  chmod +x "$TRIP/$t"
  cp "$TRIP/$t" "$NOHD/$t"
done

# hdparm: a whole, healthy SATA drive with no hidden area.
#   STUB_SEC     unfrozen (default) | frozen | none (no Security section)
#   STUB_ENH     1 (default: enhanced erase supported) | 0
#   STUB_SE      ok (default) | fail (the erase command fails) | nopass (set-pass fails)
cat > "$TRIP/hdparm" <<EOF
#!/bin/sh
echo "hdparm \$*" >> "$LOG"
for a in "\$@"; do
  case "\$a" in
    --dco-restore|--dco-setmax|--dco-freeze|p[0-9]*|/dev/*)
      echo "hdparm \$*" >> "$TRIPLOG"; exit 99 ;;
  esac
done
EOF
cat >> "$TRIP/hdparm" <<'EOF'
case "$1" in
  -I)
    echo "ATA device, with non-removable media"
    echo "Commands/features:"
    echo "	   *	SMART feature set"
    echo "	   *	Host Protected Area feature set"
    if [ "$(printenv STUB_SEC)" != none ]; then
      echo "Security: "
      echo "	Master password revision code = 65534"
      echo "		supported"
      echo "	not	enabled"
      echo "	not	locked"
      if [ "$(printenv STUB_SEC)" = frozen ]; then echo "		frozen"; else echo "	not	frozen"; fi
      echo "	not	expired: security count"
      [ "$(printenv STUB_ENH)" = 0 ] || echo "		supported: enhanced erase"
      echo "	2min for SECURITY ERASE UNIT. 2min for ENHANCED SECURITY ERASE UNIT."
    fi
    ;;
  -N) echo " max sectors   = 976773168/976773168, HPA is disabled" ;;
  --user-master)
    case "$3" in
      --security-set-pass) [ "$(printenv STUB_SE)" = nopass ] && exit 5 ;;
      --security-erase|--security-erase-enhanced) [ "$(printenv STUB_SE)" = fail ] && exit 5 ;;
    esac
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
cat > "$SAFE/lsblk" <<'EOF'
#!/bin/sh
case "$*" in
  *SERIAL,MODEL*) echo 'SERIAL="S3Z9NB0K123456" MODEL="Samsung SSD 860 EVO 500GB" SIZE="500107862016" TRAN="sata" ROTA="0" WWN="0x5002538e40123456"' ;;
esac
exit 0
EOF
chmod +x "$SAFE/lsblk"

SRC="$HERE/hardware-audit.sh"
FUNCS="$(grep -E '^(esc|o_begin|o_s|o_s0|o_n|o_raw|o_end|als_utc_now)\(\) \{' "$SRC")
$(grep '^ALS_TOOL_VERSION=' "$SRC")"
for f in als_json_array wr_limit als_lsblk_val als_lsblk_unescape als_drive_identity wipe_result clear_label \
         als_disk_is_usb als_boot_disk ata_hidden_areas ata_hpa_remove ata_kernel_whole smart_counts wipe_assess \
         fw_why fw_tried ata_secure_erase firmware_erase als_nvme_ctrl als_suspend_ok als_wipe_lock als_wipe_unlock; do
  if grep -q "^$f() {" "$SRC"; then FUNCS="$FUNCS
$(extract "$SRC" "$f")"; fi
done
FUNCS="$FUNCS
$(extract "$SRC" gui_wipe_one | sed 's/\[ ! -b "\$dev" \]/[ ! -e "$dev" ]/')"
case "$FUNCS" in *'smart_counts() {'*'wipe_assess() {'*'fw_why() {'*'ata_secure_erase() {'*'firmware_erase() {'*'[ ! -e "$dev" ]'*) ;;
  *) echo "could not extract wipe_assess / smart_counts / fw_why / the ATA erase / gui_wipe_one - refusing to run"; exit 1 ;; esac

# smartctl: a fixture attribute table. The first call is "before", later ones
# "after". STUB_R1/STUB_P1 before, STUB_R2/STUB_P2 after (default: same as
# before); "none" leaves the attribute out. STUB_SMART=missing: not installed.
STUBS='
if [ "${STUB_SMART:-}" != missing ]; then
smartctl() {
  echo "smartctl $*" >> "$LOG"
  local n r p
  n=$(grep -c "^smartctl" "$LOG")
  if [ "$n" -le 1 ]; then r="${STUB_R1:-0}"; p="${STUB_P1:-0}"; else r="${STUB_R2:-${STUB_R1:-0}}"; p="${STUB_P2:-${STUB_P1:-0}}"; fi
  echo "smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.8.0-41-generic] (local build)"
  echo "=== START OF READ SMART DATA SECTION ==="
  echo "SMART Attributes Data Structure revision number: 1"
  echo "ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE"
  [ "$r" = none ] || echo "  5 Reallocated_Sector_Ct   0x0033   100   100   010    Pre-fail  Always       -       $r"
  echo "  9 Power_On_Hours          0x0032   095   095   000    Old_age   Always       -       21233"
  [ "$p" = none ] || echo "197 Current_Pending_Sector  0x0012   100   100   000    Old_age   Always       -       $p"
  echo "198 Offline_Uncorrectable   0x0010   100   100   000    Old_age   Offline      -       0"
  return 4
}
fi
if [ -n "${STUB_TIMEOUT:-}" ]; then timeout() { echo "timeout $*" >> "$LOG"; shift; "$@"; }; fi
run_overwrite()  { echo "run_overwrite $*" >> "$LOG"; return 0; }
verify_erased()  { echo "verify_erased $*" >> "$LOG"; VE_LABEL=zeros; VE_WHY="NTFS boot sector at byte 0"; VE_MIB=10
                   case "$2" in firmware) return "${STUB_VFW:-0}" ;; esac; return 0; }
als_part_starts() { printf "1048576"; }
blockdev() { case "$1" in --getss) echo 512 ;; --getsize64) echo 500107862016 ;; esac; }
sleep() { :; }
cat() { case "$*" in */queue/rotational) echo "${STUB_ROTA:-0}" ;; */removable) echo 0 ;; *) command cat "$@" ;; esac; }
'

DEV="$T/sdz"
: > "$DEV"
case "$DEV" in /dev/*) echo "REFUSING: the test device must never be under /dev"; exit 1 ;; esac

# assess KIND ROTA RB PB RA PA [SMART] -> LEVEL (first line), LIMS (the rest)
assess() {
  local r
  r=$(env -i PATH="$SAFE" "$BASH" -c "$FUNCS
wipe_assess \"\$@\"" _ "$@" 2>&1)
  LEVEL=$(printf '%s\n' "$r" | head -n1)
  LIMS=$(printf '%s\n' "$r" | sed 1d)
}
# wipe <env...> -> OUT, RESULT, CALLS
wipe() {
  : > "$LOG"
  OUT=$(env -i PATH="${HPATH:-$TRIP:$SAFE}" LOG="$LOG" TRIPLOG="$TRIPLOG" DEV="$DEV" "$@" "$BASH" -c "$FUNCS
$STUBS
gui_wipe_one \"\$DEV\" \"\${WANT:-auto}\"" 2>&1)
  RESULT=$(printf '%s\n' "$OUT" | sed -n 's/^WIPE_RESULT //p' | tail -n1)
  CALLS=$(command cat "$LOG")
}
field() { printf '%s' "$RESULT" | "$PYREAL" -c '
import json, sys
v = json.loads(sys.stdin.read()).get(sys.argv[1])
sys.stdout.write("" if v is None else (json.dumps(v) if isinstance(v, (list, dict)) else str(v)))' "$1" 2>/dev/null; }

echo "wipe_assess: no input with bad sectors on the overwrite or normal-SE path yields purge"
n=0; purge=0; missing=0
for kind in overwrite ata-normal; do
  for rota in 0 1 ""; do
    for rb in "" 0 250000; do
      for pb in "" 0 3; do
        for ra in "" 9; do
          for pa in "" 2; do
            assess "$kind" "$rota" "$rb" "$pb" "$ra" "$pa"
            n=$((n + 1))
            [ "$LEVEL" = purge ] && purge=$((purge + 1))
            # Any count above 0 must be named in a limitation.
            anyb=0
            for v in $rb $pb $ra $pa; do [ "$v" -gt 0 ] && anyb=1; done
            if [ "$anyb" = 1 ]; then
              case "$LIMS" in *"reallocated and"*"pending sectors (SMART 5/197)"*) ;; *) missing=$((missing + 1)) ;; esac
            fi
          done
        done
      done
    done
  done
done
[ "$purge" = 0 ] && ok "all $n combinations of overwrite / normal SE x medium x counts: never purge" || bad "overwrite / normal SE never purge" "$purge of $n were purge"
[ "$missing" = 0 ] && ok "  ... and every one with a reallocated or pending sector names the counts" || bad "  ... every one with bad sectors names the counts" "$missing without"

assess overwrite 1 8 0 8 0
[ "$LEVEL" = clear ] && ok "HDD overwrite, 8 reallocated: clear" || bad "HDD overwrite, 8 reallocated: clear" "$LEVEL"
case "$LIMS" in *"the drive reports 8 reallocated and 0 pending sectors (SMART 5/197)"*"an overwrite"*) ok "  ... the limitation names the counts and the method" ;; *) bad "  ... the limitation names the counts" "$LIMS" ;; esac
assess ata-normal 0 3 1 4 0
[ "$LEVEL" = clear ] && case "$LIMS" in *"4 reallocated and 1 pending"*"a normal ATA secure erase"*) true ;; *) false ;; esac \
  && ok "normal ATA SE with bad sectors (D38): clear, larger of before/after named (4 reallocated, 1 pending)" || bad "normal ATA SE with bad sectors: clear, counts named" "$LEVEL / $LIMS"
assess ata-normal 1 0 0 0 0
[ "$LEVEL" = clear ] && [ -z "$LIMS" ] && ok "normal ATA SE, healthy drive: clear, no limitation" || bad "normal ATA SE, healthy drive: clear, no limitation" "$LEVEL / $LIMS"
assess overwrite 1 0 0 0 0
[ "$LEVEL" = clear ] && [ -z "$LIMS" ] && ok "HDD overwrite, healthy drive: clear, no limitation" || bad "HDD overwrite, healthy drive: clear, no limitation" "$LEVEL / $LIMS"
assess overwrite 0 0 0 0 0
[ "$LEVEL" = clear ] && [ "$LIMS" = "flash: user-addressable blocks only - over-provisioned and retired flash blocks are not reached by an overwrite" ] \
  && ok "flash overwrite: clear with the 'user-addressable blocks only' limitation" || bad "flash overwrite: clear with the flash limitation" "$LEVEL / $LIMS"
assess overwrite "" 0 0 0 0
case "$LIMS" in "flash: user-addressable blocks only"*) ok "medium unknown: treated as flash (never overstated)" ;; *) bad "medium unknown: treated as flash" "$LIMS" ;; esac
assess overwrite 1 "" "" "" ""
[ "$LEVEL" = clear ] && case "$LIMS" in *"counts could not be read"*) true ;; *) false ;; esac \
  && ok "counts unreadable: clear, and a limitation saying they could not be read" || bad "counts unreadable: a limitation" "$LEVEL / $LIMS"
assess ata-normal 1 0 "" 0 ""
case "$LIMS" in *"pending sector count could not be read"*) ok "only the pending count unreadable: said so" ;; *) bad "only the pending count unreadable: said so" "$LIMS" ;; esac
assess ata-normal 1 "" 0 "" 0
case "$LIMS" in *"reallocated sector count could not be read"*) ok "only the reallocated count unreadable: said so" ;; *) bad "only the reallocated count unreadable: said so" "$LIMS" ;; esac
assess overwrite 0 "" "" "" "" 0
[ "$LEVEL" = clear ] && case "$LIMS" in *SMART*) false ;; *) true ;; esac \
  && ok "NVMe overwrite (no attributes 5/197 exist): no 'could not be read' limitation" || bad "NVMe overwrite: no SMART limitation" "$LIMS"
assess purge 1 250 40 250 40
[ "$LEVEL" = purge ] && [ -z "$LIMS" ] && ok "ENHANCED ATA SE or NVMe sanitize: purge (it reaches retired sectors), even with bad sectors" || bad "enhanced SE / sanitize: purge" "$LEVEL / $LIMS"
assess purge 0 "" "" "" ""
[ "$LEVEL" = purge ] && [ -z "$LIMS" ] && ok "purge with unreadable counts: still purge, no limitation" || bad "purge with unreadable counts" "$LEVEL / $LIMS"
assess "" 1 0 0 0 0
[ "$LEVEL" = none ] && ok "nothing achieved: none" || bad "nothing achieved: none" "$LEVEL"
assess overwrite 1 abc 0 0 0
[ "$LEVEL" = clear ] && ok "a non-numeric count is ignored, not an error" || bad "a non-numeric count is ignored" "$LEVEL / $LIMS"

echo "smart_counts: attributes 5 and 197, with a time limit, never failing"
sc() {
  : > "$LOG"
  SC=$(env -i PATH="$SAFE" LOG="$LOG" "$@" "$BASH" -c "$FUNCS
$STUBS
smart_counts \"$DEV\"; echo \"rc=\$? r=\$SC_REALLOC p=\$SC_PENDING\"" 2>&1)
  CALLS=$(command cat "$LOG")
}
sc STUB_R1=8 STUB_P1=2
[ "$SC" = "rc=0 r=8 p=2" ] && ok "RAW_VALUE of 5 and 197 read: 8 reallocated, 2 pending" || bad "RAW_VALUE of 5 and 197 read" "$SC"
sc STUB_R1="16 (0 3)" STUB_P1=0
[ "$SC" = "rc=0 r=16 p=0" ] && ok "a raw value with vendor detail '16 (0 3)': 16" || bad "a raw value with vendor detail" "$SC"
sc STUB_R1=none STUB_P1=none
[ "$SC" = "rc=0 r= p=" ] && ok "an SSD without the attributes: both empty (unread), not 0" || bad "attributes absent: empty" "$SC"
sc STUB_SMART=missing
[ "$SC" = "rc=0 r= p=" ] && ok "smartctl not installed: empty, returns 0 (never fails the wipe)" || bad "smartctl not installed" "$SC"
sc STUB_TIMEOUT=1 STUB_R1=1 STUB_P1=0
case "$CALLS" in "timeout 30 smartctl -A $DEV"*) ok "run under 'timeout 30' when timeout exists" ;; *) bad "run under timeout 30" "$CALLS" ;; esac
[ "$SC" = "rc=0 r=1 p=0" ] && ok "  ... and still parsed" || bad "  ... and still parsed" "$SC"

echo "FW_WHY / FW_TRIED at every firmware way out"
fe() {
  : > "$LOG"
  FE=$(env -i PATH="${HPATH:-$TRIP:$SAFE}" LOG="$LOG" TRIPLOG="$TRIPLOG" DEV="$DEV" "$@" "$BASH" -c "$FUNCS
$STUBS
FW_WHY=x-stale; FW_TRIED=x-stale
firmware_erase \"\$DEV\" \"\${D:-sdz}\" >/dev/null; rc=\$?
echo \"rc=\$rc why=\$FW_WHY tried=\$FW_TRIED\"" 2>&1)
  CALLS=$(command cat "$LOG")
}
fe AUDIT_WIPE_METHOD=auto STUB_SEC=frozen
[ "$FE" = "rc=1 why=frozen tried=" ] && ok "a frozen drive: FW_WHY frozen, nothing issued" || bad "a frozen drive: FW_WHY frozen" "$FE"
case "$CALLS" in *security-set-pass*|*security-erase*) bad "  ... and no security command was sent" "$CALLS" ;; *) ok "  ... and no security command was sent" ;; esac
fe AUDIT_WIPE_METHOD=auto STUB_SEC=none
[ "$FE" = "rc=1 why=unsupported tried=" ] && ok "no ATA security feature set: unsupported" || bad "no ATA security feature set: unsupported" "$FE"
fe AUDIT_WIPE_METHOD=crypto STUB_ENH=0
[ "$FE" = "rc=1 why=unsupported tried=" ] && ok "'crypto' asked, no enhanced erase: unsupported" || bad "'crypto' asked, no enhanced erase: unsupported" "$FE"
HPATH="$NOHD:$SAFE" fe AUDIT_WIPE_METHOD=auto
[ "$FE" = "rc=1 why=tool_missing tried=" ] && ok "hdparm not installed: tool_missing" || bad "hdparm not installed: tool_missing" "$FE"
HPATH="$SAFE" fe AUDIT_WIPE_METHOD=auto D=nvme0n1
[ "$FE" = "rc=1 why=tool_missing tried=" ] && ok "nvme-cli not installed (NVMe drive): tool_missing" || bad "nvme-cli not installed: tool_missing" "$FE"
fe AUDIT_WIPE_METHOD=auto STUB_SE=fail
[ "$FE" = "rc=1 why=failed tried=ata-secure-erase-enhanced" ] && ok "the erase command fails: failed, and it is listed as tried" || bad "the erase command fails: failed + tried" "$FE"
fe AUDIT_WIPE_METHOD=auto STUB_SE=nopass
[ "$FE" = "rc=1 why=failed tried=ata-secure-erase-enhanced" ] && ok "the drive refuses the password: failed" || bad "the drive refuses the password: failed" "$FE"
fe AUDIT_WIPE_METHOD=auto
[ "$FE" = "rc=0 why= tried=ata-secure-erase-enhanced" ] && ok "enhanced erase works: no reason, tried = the enhanced erase" || bad "enhanced erase works" "$FE"
fe AUDIT_WIPE_METHOD=auto STUB_ENH=0
[ "$FE" = "rc=0 why= tried=ata-secure-erase" ] && ok "normal erase works: tried = ata-secure-erase" || bad "normal erase works" "$FE"
fe AUDIT_WIPE_METHOD=overwrite
[ "$FE" = "rc=1 why= tried=" ] && ok "overwrite asked for: nothing fell back, both empty (stale values cleared)" || bad "overwrite asked for: both empty" "$FE"
case "$CALLS" in *hdparm*) bad "  ... and the drive was not even asked" "$CALLS" ;; *) ok "  ... and the drive was not even asked" ;; esac
# Every `return 1` in the two firmware functions sets a reason first (or is
# the overwrite request, which is not a fallback).
body="$(extract "$SRC" ata_secure_erase)
$(extract "$SRC" firmware_erase)"
# A `return 1` on a line of its own counts when an fw_why came after the
# previous `return 1` (the reason is set, then a message, then the return).
unset_ret=""
seen=0
while IFS= read -r line; do
  case "$line" in *fw_why*) seen=1 ;; esac
  case "$line" in
    *'return 1'*)
      case "$line" in *fw_why*|*'overwrite|zero) return 1'*) ;; *) [ "$seen" = 1 ] || unset_ret="$unset_ret | $line" ;; esac
      seen=0 ;;
  esac
done <<< "$body"
[ -z "$unset_ret" ] && ok "every firmware 'return 1' is preceded by an fw_why" || bad "every firmware 'return 1' sets a reason" "$unset_ret"

echo "gui_wipe_one: the record says what was asked, tried, achieved, and why"
wipe STUB_SEC=frozen STUB_ROTA=0
[ "$(field status)" = wiped ] && [ "$(field methodAttempted)" = overwrite ] && [ "$(field fallbackReason)" = frozen ] \
  && ok "frozen SSD: overwrite, methodAttempted 'overwrite', fallbackReason 'frozen'" || bad "frozen SSD: fallbackReason frozen" "$RESULT"
[ "$(field sanitisationLevel)" = clear ] && case "$(field limitations)" in *"flash: user-addressable blocks only"*) true ;; *) false ;; esac \
  && ok "  ... clear, with the flash limitation" || bad "  ... clear with the flash limitation" "$RESULT"
case "$OUT" in *"Requested 'auto'; the stronger method was not used: frozen"*) ok "  ... and the operator is told" ;; *) bad "  ... the operator is told" "$OUT" ;; esac
wipe STUB_SEC=none STUB_ROTA=1
[ "$(field fallbackReason)" = unsupported ] && ok "HDD without ATA security: fallbackReason unsupported" || bad "fallbackReason unsupported" "$RESULT"
HPATH="$NOHD:$SAFE" wipe STUB_ROTA=1
[ "$(field fallbackReason)" = tool_missing ] && ok "hdparm missing: fallbackReason tool_missing" || bad "fallbackReason tool_missing" "$RESULT"
wipe STUB_SE=fail STUB_ROTA=1
[ "$(field methodAttempted)" = "ata-secure-erase-enhanced,overwrite" ] && [ "$(field fallbackReason)" = failed ] \
  && ok "the erase fails: methodAttempted 'ata-secure-erase-enhanced,overwrite', fallbackReason failed" || bad "erase fails: attempted list" "$RESULT"
wipe STUB_VFW=1 STUB_ROTA=1
[ "$(field methodAttempted)" = "ata-secure-erase-enhanced,overwrite" ] && [ "$(field fallbackReason)" = verify_failed ] \
  && ok "the drive said done but the read-back found old data: fallbackReason verify_failed" || bad "fallbackReason verify_failed" "$RESULT"
wipe STUB_ENH=0 STUB_ROTA=1 STUB_R1=8 STUB_P1=0 STUB_R2=9 STUB_P2=0
[ "$(field status)" = wiped ] && [ "$(field sanitisationLevel)" = clear ] && ok "normal ATA SE on a drive with 8 -> 9 reallocated: clear (D38)" || bad "normal SE with bad sectors: clear" "$RESULT"
case "$(field limitations)" in *"9 reallocated and 0 pending sectors"*) ok "  ... limitation names the counts" ;; *) bad "  ... limitation names the counts" "$(field limitations)" ;; esac
[ "$(field smart)" = '{"reallocatedBefore": 8, "pendingBefore": 0, "reallocatedAfter": 9, "pendingAfter": 0}' ] \
  && ok "  ... smart {reallocatedBefore 8, pendingBefore 0, reallocatedAfter 9, pendingAfter 0}" || bad "  ... smart object" "$(field smart)"
[ -z "$(field fallbackReason)" ] && ok "  ... no fallbackReason: the normal erase WAS the drive's best" || bad "  ... no fallbackReason" "$RESULT"
wipe STUB_ROTA=1 STUB_R1=8 STUB_P1=2
[ "$(field sanitisationLevel)" = purge ] && [ "$(field limitations)" = "[]" ] && ok "ENHANCED ATA SE, even with bad sectors: purge, no limitation" || bad "enhanced SE: purge" "$RESULT"
wipe WANT=overwrite STUB_ROTA=1 STUB_R1=3 STUB_P1=1
[ "$(field sanitisationLevel)" = clear ] && case "$(field limitations)" in *"3 reallocated and 1 pending"*"an overwrite"*) true ;; *) false ;; esac \
  && ok "HDD overwrite (asked for) with bad sectors: clear, counts named" || bad "HDD overwrite with bad sectors" "$RESULT"
[ -z "$(field fallbackReason)" ] && [ "$(field methodAttempted)" = overwrite ] && ok "  ... overwrite asked for: no fallbackReason, attempted 'overwrite'" || bad "  ... overwrite asked for: no fallbackReason" "$RESULT"
wipe WANT=zero STUB_ROTA=1
[ "$(field methodAttempted)" = overwrite-zero ] && ok "zero asked for: attempted 'overwrite-zero'" || bad "zero: overwrite-zero" "$RESULT"
wipe STUB_SMART=missing STUB_ROTA=1 STUB_ENH=0
[ "$(field status)" = wiped ] && case "$(field limitations)" in *"could not be read"*) true ;; *) false ;; esac \
  && ok "smartctl missing: still wiped, with a 'could not be read' limitation" || bad "smartctl missing: limitation" "$RESULT"
case "$RESULT" in *'"smart"'*) bad "  ... and no smart object (nothing was read)" "$RESULT" ;; *) ok "  ... and no smart object (nothing was read)" ;; esac

echo "every field appears and parses"
wipe STUB_SEC=frozen STUB_ROTA=1 STUB_R1=4 STUB_P1=1
chk=$(printf '%s' "$RESULT" | "$PYREAL" -c '
import json, sys
r = json.loads(sys.stdin.read())
bad = []
for k, t in (("status", str), ("device", str), ("method", str), ("reason", str), ("toolVersion", str),
             ("startedAt", str), ("finishedAt", str), ("drive", dict), ("methodRequested", str),
             ("methodAttempted", str), ("fallbackReason", str), ("sanitisationLevel", str),
             ("verification", str), ("hiddenAreas", str), ("limitations", list), ("smart", dict)):
    if not isinstance(r.get(k), t):
        bad.append("%s=%r" % (k, r.get(k)))
if not all(isinstance(x, str) and x for x in r.get("limitations", [])):
    bad.append("limitations not all strings")
s = r.get("smart") or {}
for k in ("reallocatedBefore", "pendingBefore", "reallocatedAfter", "pendingAfter"):
    if not (isinstance(s.get(k), int) and not isinstance(s.get(k), bool)):
        bad.append("smart.%s=%r" % (k, s.get(k)))
if r.get("sanitisationLevel") not in ("purge", "clear", "none"):
    bad.append("level")
print(" ".join(bad) or "ok")' 2>&1)
[ "$chk" = ok ] && ok "status..smart: all 16 fields present, typed, JSON-parsable" || bad "all fields present and typed" "$chk / $RESULT"
wipe STUB_SEC=frozen STUB_ROTA=1
lines=$(printf '%s\n' "$OUT" | grep -c '^WIPE_RESULT ')
[ "$lines" = 1 ] && ok "exactly one WIPE_RESULT line" || bad "exactly one WIPE_RESULT line" "$lines"
# A refusal carries none of the new fields: nothing was attempted.
: > "$LOG"
OUT=$(env -i PATH="$TRIP:$SAFE" LOG="$LOG" TRIPLOG="$TRIPLOG" DEV="$DEV" "$BASH" -c "$FUNCS
$STUBS
gui_wipe_one \"\$DEV\" auto SOMEONE-ELSE" 2>&1)
RESULT=$(printf '%s\n' "$OUT" | sed -n 's/^WIPE_RESULT //p' | tail -n1)
[ "$(field status)" = refused ] && [ -z "$(field methodAttempted)$(field fallbackReason)$(field smart)$(field limitations)" ] \
  && ok "refused: no methodAttempted / fallbackReason / smart / limitations" || bad "refused: none of the new fields" "$RESULT"

[ ! -s "$TRIPLOG" ] && ok "the hdparm stub was never tripped" || bad "the hdparm stub was never tripped" "$(command cat "$TRIPLOG")"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
