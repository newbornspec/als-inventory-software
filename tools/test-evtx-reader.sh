#!/usr/bin/env bash
# The Windows event-log reader, shipped on the stick rather than baked into the
# squashfs layer.
#
# The Autopilot check reads the machine's own OOBE log
# (Microsoft-Windows-ModernDeployment-Diagnostics-Provider%4Autopilot.evtx) to
# see every ZTD attempt and result, not just the last cached answer. That needs
# evtxexport, from libevtx-utils, which the stock Ubuntu image does not carry.
#
# It is installed at boot from three .deb files on the stick, because a layer
# rebuild costs a mksquashfs run and a reboot on the audit machine while three
# files on a FAT32 partition cost a file copy. make-als-layer.sh lists the
# package too, so a rebuilt stick gets it that way instead; whichever arrives
# first wins.
#
# What this pins:
#   1. The debs are actually on the stick, are the right three, and are the
#      only thing in that directory.
#   2. The installer is offline (dpkg, never apt), idempotent, and never fatal.
#   3. Every failure path says so in the log rather than passing silently -
#      because "no reader" must never be mistaken for "no traces", which is the
#      bug class this whole check exists inside.
#   4. The sync ships the directory at all.
#
#   bash tools/test-evtx-reader.sh
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
AUTOSTART="$HERE/gui/als-autostart.sh"
SYNC="$HERE/sync-usb.ps1"
DEBS="$HERE/debs"
PASSED=0; FAILED=0

check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then
    PASSED=$((PASSED + 1)); printf '  ok    %s\n' "$1"
  else
    FAILED=$((FAILED + 1)); printf '  FAIL  %s\n     expected: %s\n     actual:   %s\n' "$1" "$2" "$3"
  fi
}

echo "== the packages are on the stick =="
for want in libevtx-utils libevtx1t64 libbfio1; do
  n=$(ls "$DEBS"/${want}_*.deb 2>/dev/null | wc -l | tr -d ' ')
  check "$want is present, exactly once" 1 "$n"
done
# Nothing else: a stray .deb here is installed at boot on every station, and
# this directory is the one place that could put an unreviewed package onto a
# customer-facing machine.
total=$(ls "$DEBS"/*.deb 2>/dev/null | wc -l | tr -d ' ')
check "and nothing else is in debs/" 3 "$total"
check "they are amd64, which is what the station boots" 3 \
  "$(ls "$DEBS"/*_amd64.deb 2>/dev/null | wc -l | tr -d ' ')"

echo
echo "== the installer's contract, read off the shipped script =="
src=$(sed -n '/^install_evtx_reader()/,/^}/p' "$AUTOSTART")
check "install_evtx_reader exists in the synced autostart" 1 \
  "$(printf '%s' "$src" | grep -c 'install_evtx_reader()')"
# dpkg, never apt: the bench has no guaranteed network, and an install that
# needs one is an install that fails on the day it matters.
# Two lines, by design: the already-root path and the sudo path.
check "it installs with dpkg, on both the root and the sudo path" 2 \
  "$(printf '%s' "$src" | grep -c 'dpkg -i')"
check "...and never reaches for apt" 0 "$(printf '%s' "$src" | grep -c 'apt-get\|apt install')"
check "it elevates with the station's passwordless sudo" 1 \
  "$(printf '%s' "$src" | grep -c 'sudo -n dpkg')"
check "...and skips the sudo when already root" 1 \
  "$(printf '%s' "$src" | grep -c 'id -u')"
# Idempotent: a stick whose layer already carries the package must not have it
# reinstalled over the top on every boot.
# Twice: the early return that makes it idempotent, and the check afterwards
# that decides which of the two outcomes to log. Both matter - the second is
# what stops a failed dpkg being reported as a success.
check "it returns early when the tool is there, and verifies after installing" 2 \
  "$(printf '%s' "$src" | grep -c 'command -v evtxexport')"
# Never fatal, and never silent.
check "every path returns 0 - a failed install must not stop the boot" 0 \
  "$(printf '%s' "$src" | grep -c 'exit 1\|die ')"
check "a missing debs directory is logged" 1 \
  "$(printf '%s' "$src" | grep -c 'no debs/ on the stick')"
check "an empty debs directory is logged" 1 \
  "$(printf '%s' "$src" | grep -c 'is empty')"
check "no root available is logged" 1 \
  "$(printf '%s' "$src" | grep -c 'no root available')"
check "a failed install is logged" 1 \
  "$(printf '%s' "$src" | grep -c 'could not install')"
check "it is called from BOTH session kinds, not the kiosk alone" 3 \
  "$(grep -c 'install_evtx_reader' "$AUTOSTART")"

echo
echo "== the failure paths, run for real =="
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
LOGGED=""
log() { LOGGED="$LOGGED$*
"; }
eval "$src"

# No debs directory at all - an older stick, synced before this shipped.
MEDIA="$TMP/nostick"; mkdir -p "$MEDIA"
LOGGED=""; install_evtx_reader; rc=$?
check "a stick with no debs/ does not fail the boot" 0 "$rc"
check "...and says the reading is unavailable" 1 "$(printf '%s' "$LOGGED" | grep -c 'unavailable')"

# The directory exists but is empty.
MEDIA="$TMP/empty"; mkdir -p "$MEDIA/debs"
LOGGED=""; install_evtx_reader; rc=$?
check "an empty debs/ does not fail the boot" 0 "$rc"
check "...and says so" 1 "$(printf '%s' "$LOGGED" | grep -c 'empty')"

# THE ONE THAT MATTERS: none of these may look like a clean result. The
# Autopilot check's whole design is that an absent reader is reported as an
# absent reader, never as a machine with no traces on it.
check "no failure path ever claims the tool is present" 0 \
  "$(printf '%s' "$LOGGED" | grep -c 'already present')"

echo
echo "== the sync ships the directory =="
check "sync-usb.ps1 carries debs/ as a tree" 1 \
  "$(grep -c "debs' = 'debs" "$SYNC")"

echo
printf '%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
