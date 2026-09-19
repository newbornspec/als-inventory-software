#!/usr/bin/env bash
# Tests for the wipe ladder - what gui_wipe_one does, and what it CLAIMS it did.
#
# Why this exists. The remediation spec's D-1: on an SSD whose firmware erase
# failed, the ladder fell through to `blkdiscard` (TRIM), recorded "Block
# discard / TRIM (SSD)" as the wipe method, and then verify_zero "verified" it -
# because a TRIMmed drive reports zeros by design (DRAT/RZAT) while the NAND
# behind it can be untouched. TRIM is a hint to the controller, not an erase.
# That is the one path that produced a confidently wrong certificate.
#
# And D-1/D-3: verify_zero counted the non-zero bytes in what dd read back. A
# read that FAILED returned nothing - zero non-zero bytes - so an unreadable
# drive "verified (reads as zeros)".
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
# dd needs to be able to HAND BACK data for the verify_zero cases.
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
for t in head tr sed grep basename wc cat printenv cmp; do
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
FUNCS="$(extract "$SRC" esc)
$(extract "$SRC" clear_label)
$(extract "$SRC" als_disk_is_usb)
$(extract "$SRC" als_boot_disk)
$(extract "$SRC" gui_wipe_one | sed 's/\[ ! -b "\$dev" \]/[ ! -e "$dev" ]/')"
case "$FUNCS" in *'[ ! -e "$dev" ]'*) ;; *) echo "could not relax the -b check - refusing to run"; exit 1 ;; esac

STUBS='
firmware_erase() { echo "firmware_erase $*" >> "$LOG"; if [ "${STUB_FW:-fail}" = "ok" ]; then M="${STUB_FW_M:-NVMe crypto erase}"; return 0; fi; return 1; }
run_overwrite()  { echo "run_overwrite $*" >> "$LOG"; return "${STUB_OVR_RC:-0}"; }
verify_zero()    { echo "verify_zero $*" >> "$LOG"; return "${STUB_VERIFY_RC:-0}"; }
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

echo "D-1/D-3: verify_zero must not pass a read that returned nothing"
VZ="$(extract "$SRC" verify_zero)"
vz() {
  env -i PATH="$TRIP:$SAFE" LOG="$LOG" DEV="$DEV" "$@" "$BASH" -c "$VZ
blockdev() { echo \${STUB_SIZE:-512110190592}; }
verify_zero \"\$DEV\"" >/dev/null 2>&1
}
vz STUB_DD=zeros;  [ $? -eq 0 ] && ok "all windows read back zeros: passes" || bad "all windows read back zeros: passes" "returned non-zero"
vz STUB_DD=data;   [ $? -ne 0 ] && ok "old data read back: fails" || bad "old data read back: fails" "returned 0"
vz STUB_DD=empty;  [ $? -ne 0 ] && ok "the read FAILED (nothing came back): fails" || bad "the read FAILED (nothing came back): fails" "returned 0 - an unreadable drive counts as clean"
vz STUB_DD=short;  [ $? -ne 0 ] && ok "a SHORT read (1 MiB of a 32 MiB window): fails" || bad "a SHORT read (1 MiB of a 32 MiB window): fails" "returned 0 - a part-read window counts as clean"
vz STUB_DD=zeros STUB_SIZE=4194304; [ $? -eq 0 ] && ok "a device smaller than one window: whole device read, passes" || bad "a device smaller than one window: whole device read, passes" "returned non-zero"

echo "the whole engine: TRIM survives nowhere as a wipe, in either copy"
# The text-mode wipe (wipe_internal_drives) had its own copy of the TRIM branch.
# Any line that RUNS blkdiscard - anything that is not a comment - fails this.
live=$(grep -n 'blkdiscard' "$SRC" | grep -v '^[0-9]*:[[:space:]]*#')
[ -z "$live" ] && ok "no executable blkdiscard anywhere in hardware-audit.sh" || bad "no executable blkdiscard anywhere in hardware-audit.sh" "$live"
grep -q 'm="Block discard' "$SRC" && bad "TRIM is never a recorded method" "still assigned" || ok "TRIM is never a recorded method"
unl=$(grep -n 'm="Overwrite' "$SRC" | grep -v 'clear_label')
[ -z "$unl" ] && ok "every overwrite result is labelled by medium" || bad "every overwrite result is labelled by medium" "$unl"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
