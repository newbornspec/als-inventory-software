#!/usr/bin/env bash
# Tests for the wipe ladder - what gui_wipe_one does, and what it CLAIMS it did.
#
# Why this exists. The remediation spec's D-1: on an SSD whose firmware erase
# failed, the ladder fell through to `blkdiscard` (TRIM), recorded "Block
# discard / TRIM (SSD)" as the wipe method, and then the zeros check "verified" it -
# because a TRIMmed drive reports zeros by design (DRAT/RZAT) while the NAND
# behind it can be untouched. TRIM is a hint to the controller, not an erase.
# That is the one path that produced a confidently wrong certificate.
#
# And D-1/D-3: the zeros check counted the non-zero bytes in what dd read back.
# A read that FAILED returned nothing - zero non-zero bytes - so an unreadable
# drive "verified (reads as zeros)". That is now tools/test-wipe-verify.sh.
#
#   bash tools/test-wipe-ladder.sh
#
# SAFETY. This runs the REAL wipe code on whatever machine runs the test, and
# on Windows Git Bash exposes the real system disk as /dev/sda. So:
#   - the "device" is always a temporary REGULAR FILE, and the harness refuses
#     to run against anything under /dev;
#   - gui_wipe_one's `[ -b "$dev" ]` is relaxed to `[ -e ]` in the extracted copy
#     only, so that file is accepted;
#   - every tool that can write to a disk (shred, dd, blkdiscard, hdparm, nvme,
#     rtcwake, wipefs, sgdisk) is a TRIPWIRE that only logs its arguments, and
#     PATH holds nothing else but wrappers for read-only tools - the real ones
#     are not reachable at all.

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s   (%s)\n' "$1" "$2"; }

extract() {
  awk -v fn="$2" '
    $0 ~ "^"fn"\\(\\) \\{" { on=1 }
    on { print }
    on && /^}/ { exit }
  ' "$1"
}

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
TRIP="$T/trip"; SAFE="$T/safe"; LOG="$T/calls.log"
mkdir -p "$TRIP" "$SAFE"

# Tripwires: log the call, exit with STUB_RC_<name> (default 0 - "it worked").
for t in shred dd blkdiscard hdparm nvme rtcwake wipefs sgdisk; do
  printf '#!/bin/sh\necho "%s $*" >> "%s"\nrc=$(printenv STUB_RC_%s)\nexit ${rc:-0}\n' "$t" "$LOG" "$t" > "$TRIP/$t"
  chmod +x "$TRIP/$t"
done
# dd can hand back data (kept for any read-back a stub does not cover).
# STUB_DD: "zeros" (32 MiB of zeros), "empty" (nothing, read failed), "data".
cat > "$TRIP/dd" <<EOF
#!/bin/sh
echo "dd \$*" >> "$LOG"
case "\$(printenv STUB_DD)" in
  zeros) head -c 33554432 /dev/zero ;;
  data)  printf 'NTFS    customer data still here' ;;
  empty) exit 1 ;;
  short) head -c 1048576 /dev/zero ;;
esac
rc=\$(printenv STUB_RC_dd); exit \${rc:-0}
EOF
chmod +x "$TRIP/dd"

# Read-only tools, reached by absolute path - so PATH needs nothing else.
for t in head tr sed grep basename wc cat printenv cmp date; do
  real=$(command -v "$t") || { echo "missing $t"; exit 1; }
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$real" > "$SAFE/$t"
  chmod +x "$SAFE/$t"
done
for t in lsblk findmnt readlink; do          # identity lookups: nothing, calmly
  printf '#!/bin/sh\nexit 0\n' > "$SAFE/$t"; chmod +x "$SAFE/$t"
done

DEV="$T/fake-drive"
: > "$DEV"
case "$DEV" in /dev/*) echo "REFUSING: the test device must never be under /dev"; exit 1 ;; esac

SRC="$HERE/hardware-audit.sh"
FUNCS="$(grep -E '^(esc|o_begin|o_s|o_s0|o_n|o_raw|o_end|als_utc_now)\(\) \{' "$SRC")
$(grep '^ALS_TOOL_VERSION=' "$SRC")
$(extract "$SRC" als_lsblk_val)
$(extract "$SRC" als_lsblk_unescape)
$(extract "$SRC" als_drive_identity)
$(extract "$SRC" wipe_result)
$(extract "$SRC" clear_label)
$(extract "$SRC" als_disk_is_usb)
$(extract "$SRC" als_boot_disk)
$(extract "$SRC" gui_wipe_one | sed 's/\[ ! -b "\$dev" \]/[ ! -e "$dev" ]/')"
case "$FUNCS" in *'[ ! -e "$dev" ]'*) ;; *) echo "could not relax the -b check - refusing to run"; exit 1 ;; esac

STUBS='
firmware_erase() { echo "firmware_erase $*" >> "$LOG"; if [ "${STUB_FW:-fail}" = "ok" ]; then M="${STUB_FW_M:-NVMe crypto erase}"; return 0; fi; return 1; }
run_overwrite()  { echo "run_overwrite $*" >> "$LOG"; return "${STUB_OVR_RC:-0}"; }
verify_erased()  { echo "verify_erased $*" >> "$LOG"; VE_LABEL="${STUB_VE_LABEL:-zeros}"; VE_WHY="NTFS boot sector at byte 1048576"; VE_MIB=10
                   case "$2" in firmware) return "${STUB_VERIFY_FW_RC:-${STUB_VERIFY_RC:-0}}" ;; esac; return "${STUB_VERIFY_RC:-0}"; }
als_part_starts() { echo "als_part_starts $*" >> "$LOG"; printf "1048576"; }
blockdev()       { echo 512110190592; }
cat() { case "$*" in */queue/rotational) echo "${STUB_ROTA:-0}" ;; */removable) echo 0 ;; *) command cat "$@" ;; esac; }
'

# wipe <env assignments...> -> sets OUT (all output) and RESULT (the WIPE_RESULT json)
wipe() {
  : > "$LOG"
  OUT=$(env -i PATH="$TRIP:$SAFE" LOG="$LOG" DEV="$DEV" "$@" "$BASH" -c "$FUNCS
$STUBS
gui_wipe_one \"\$DEV\" \"\${WANT:-auto}\"" 2>&1)
  RESULT=$(printf '%s\n' "$OUT" | sed -n 's/^WIPE_RESULT //p' | tail -n1)
  CALLS=$(command cat "$LOG")
}
field() { printf '%s' "$RESULT" | sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p"; }

echo "D-1: an SSD whose firmware erase failed is never 'wiped' by TRIM"
for want in auto crypto secure overwrite zero; do
  wipe STUB_ROTA=0 STUB_FW=fail WANT="$want"
  case "$CALLS" in
    *blkdiscard*) bad "SSD, method=$want: blkdiscard was never run" "it was: $(printf '%s' "$CALLS" | grep blkdiscard | head -n1)" ;;
    *) ok "SSD, method=$want: blkdiscard was never run" ;;
  esac
  case "$(field method)" in
    *TRIM*|*discard*) bad "SSD, method=$want: TRIM is never the recorded method" "$(field status): $(field method)" ;;
    *) ok "SSD, method=$want: TRIM is never the recorded method" ;;
  esac
done

echo "the owner's decision: an SSD whose firmware erase failed is OVERWRITTEN, and says what that reaches"
for want in auto crypto secure overwrite; do
  wipe STUB_ROTA=0 STUB_FW=fail WANT="$want"
  case "$CALLS" in *run_overwrite*) ok "SSD, method=$want: a real overwrite runs" ;; *) bad "SSD, method=$want: a real overwrite runs" "$CALLS" ;; esac
  [ "$(field status)" = wiped ] && case "$(field method)" in *"flash: user-addressable blocks only"*) true ;; *) false ;; esac \
    && ok "SSD, method=$want: certified with the flash limitation" \
    || bad "SSD, method=$want: certified with the flash limitation" "$RESULT"
done
wipe STUB_ROTA=0 STUB_FW=fail WANT=zero
case "$(field method)" in *"single zero pass"*"flash: user-addressable blocks only"*) ok "SSD, method=zero: a single zero pass, labelled" ;; *) bad "SSD, method=zero: a single zero pass, labelled" "$RESULT" ;; esac
wipe STUB_ROTA= STUB_FW=fail WANT=auto
case "$(field method)" in *"flash: user-addressable blocks only"*) ok "medium unknown: labelled as flash (never overstated)" ;; *) bad "medium unknown: labelled as flash (never overstated)" "$RESULT" ;; esac
wipe STUB_ROTA=0 STUB_FW=fail WANT=auto STUB_VERIFY_RC=1
[ "$(field status)" = failed ] && ok "SSD, overwrite does not read back clean: FAILED, not wiped" || bad "SSD, overwrite does not read back clean: FAILED, not wiped" "$RESULT"

echo "controls: the paths that were already right stay right"
wipe STUB_ROTA=1 STUB_FW=fail WANT=auto
[ "$(field status)" = wiped ] && case "$(field method)" in *Overwrite*) true ;; *) false ;; esac \
  && ok "HDD, firmware failed: overwrite, verified, wiped" || bad "HDD, firmware failed: overwrite, verified, wiped" "$RESULT"
case "$CALLS" in *blkdiscard*) bad "HDD: no TRIM" "$CALLS" ;; *) ok "HDD: no TRIM" ;; esac
case "$(field method)" in *"(NIST Clear)"*) ok "HDD: plain NIST Clear, no flash caveat" ;; *) bad "HDD: plain NIST Clear, no flash caveat" "$RESULT" ;; esac

wipe STUB_ROTA=0 STUB_FW=ok WANT=auto
[ "$(field status)" = wiped ] && ok "SSD, firmware erase worked and read back clean: wiped" || bad "SSD, firmware erase worked and read back clean: wiped" "$RESULT"
case "$CALLS" in *run_overwrite*) bad "SSD, firmware worked: no hours-long overwrite" "$CALLS" ;; *) ok "SSD, firmware worked: no hours-long overwrite" ;; esac

# D-1/D-3 (an unreadable drive counting as clean) is now tested against the
# real read-back, verify_erased, with real bytes: tools/test-wipe-verify.sh.

echo "the whole engine: TRIM survives nowhere as a wipe, in either copy"
# The text-mode wipe (wipe_internal_drives) had its own copy of the TRIM branch.
# Any line that RUNS blkdiscard - anything that is not a comment - fails this.
live=$(grep -n 'blkdiscard' "$SRC" | grep -v '^[0-9]*:[[:space:]]*#')
[ -z "$live" ] && ok "no executable blkdiscard anywhere in hardware-audit.sh" || bad "no executable blkdiscard anywhere in hardware-audit.sh" "$live"
grep -q 'm="Block discard' "$SRC" && bad "TRIM is never a recorded method" "still assigned" || ok "TRIM is never a recorded method"
unl=$(grep -n 'm="Overwrite' "$SRC" | grep -v 'clear_label')
[ -z "$unl" ] && ok "every overwrite result is labelled by medium" || bad "every overwrite result is labelled by medium" "$unl"

echo "D9: the text-mode wipe is retired - AUDIT_WIPE=1 wipes nothing and files no wipe"
# Runs the REAL text-mode tail of the script: from the wipe_internal_drives call
# to the upload and the final exit. Sign-in, lot choice and the profile are
# replaced by fixed values; http_post only records the body it was handed. The
# operator "types WIPE" on stdin, so the old code would have gone ahead.
# lsblk here reports one internal SATA disk, so a real wipe WOULD have a target;
# the erase helpers are logging stubs and the disk tools are tripwires.
TAIL=$(sed -n '/^wipe_internal_drives$/,$p' "$SRC")
case "$TAIL" in *'exit "$RESULT"'*) ;; *) echo "could not find the text-mode tail - refusing to run"; exit 1 ;; esac
WID="$(extract "$SRC" wipe_internal_drives)
$(grep '^jstr()\|^jraw()\|^pval()' "$SRC")"
BODYF="$T/body.json"
: > "$LOG"; : > "$BODYF"
TXT=$(printf 'WIPE\n\n\n' | env -i PATH="$TRIP:$SAFE" LOG="$LOG" BODYF="$BODYF" AUDIT_WIPE=1 "$BASH" -c "$FUNCS
$WID
$STUBS
lsblk() { case \"\$*\" in *-dP*) echo 'NAME=\"sdz\" TYPE=\"disk\" TRAN=\"sata\" RM=\"0\"' ;; esac; return 0; }
http_post() { printf '%s' \"\$2\" > \"\$BODYF\"; echo '{\"assetId\":\"a1\",\"name\":\"X\",\"tag\":\"T\",\"lot\":\"L\",\"created\":true}'; }
API=http://test.invalid; TOKEN=t; CHOSEN_ID=lot1; CHOSEN_SUB_ID=; PROFILE='{}'
$TAIL" 2>&1)
CALLS=$(command cat "$LOG")
[ -z "$CALLS" ] && ok "text mode, AUDIT_WIPE=1: no erase helper or disk tool was called" \
  || bad "text mode, AUDIT_WIPE=1: no erase helper or disk tool was called" "$(printf '%s' "$CALLS" | head -n3 | tr '\n' ' ')"
BODY=$(command cat "$BODYF")
case "$BODY" in
  '{"lotId":"lot1"'*) ok "text mode: the audit itself was still uploaded" ;;
  *) bad "text mode: the audit itself was still uploaded" "body: $BODY / out: $(printf '%s' "$TXT" | tail -n3 | tr '\n' ' ')" ;;
esac
case "$BODY" in
  *dataWipe*) bad "text mode: the upload carries no dataWipeStatus/Method" "$BODY" ;;
  *) ok "text mode: the upload carries no dataWipeStatus/Method" ;;
esac
case "$TXT" in *"done from the kiosk screen"*) ok "text mode: the operator is told to wipe from the kiosk" ;; *) bad "text mode: the operator is told to wipe from the kiosk" "$TXT" ;; esac
body=$(extract "$SRC" wipe_internal_drives)
case "$body" in *firmware_erase*|*run_overwrite*|*verify_erased*|*shred*|*nvme*|*hdparm*) bad "text mode: the duplicated ladder is gone, not left dead" "$body" ;; *) ok "text mode: the duplicated ladder is gone, not left dead" ;; esac

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
