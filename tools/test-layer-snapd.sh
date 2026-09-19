#!/usr/bin/env bash
# Tests for make-als-layer.sh's snapd mask: it must happen ONLY when the
# firefox-esr binary is really in the layer.
#
# Why. Masking snapd is what saves ~95 s of snap seeding per boot, but the
# stock /usr/bin/firefox is a wrapper that exits "requires the firefox snap".
# A layer that masks snapd without carrying ESR boots to a kiosk with no
# browser. So the condition is the stage's own contents - the real binary,
# not a symlink to it, not "the download returned 0".
#
#   bash tools/test-layer-snapd.sh
#
# Runs entirely in a temp directory. Sources make-als-layer.sh with
# ALS_LAYER_LIB=1, which returns before the root check - nothing that touches
# a stick, grub.cfg or /etc runs.

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s   (%s)\n' "$1" "$2"; }

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

# shellcheck disable=SC1091
ALS_LAYER_LIB=1 . "$HERE/make-als-layer.sh" || { echo "could not source make-als-layer.sh"; exit 1; }

# Git Bash on Windows cannot make a dangling symlink, and its -x is decided by
# file extension rather than mode bits - the two things this test is about.
# It needs Linux (CI is Linux, and so is the station that runs the script).
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) echo "  SKIP  needs Linux symlink and mode semantics - CI runs it"; exit 0 ;;
esac

new_stage() { rm -rf "$T/stage"; mkdir -p "$T/stage"; printf '%s' "$T/stage"; }
put_esr() {
  mkdir -p "$1/usr/lib/firefox-esr" "$1/usr/bin"
  printf '#!/bin/sh\nexit 0\n' > "$1/usr/lib/firefox-esr/firefox"
  chmod 0755 "$1/usr/lib/firefox-esr/firefox"
  ln -s ../lib/firefox-esr/firefox "$1/usr/bin/firefox-esr"
}
count_masks() { find "$1/etc/systemd" -type l 2>/dev/null | wc -l | tr -d ' '; }

echo "no firefox-esr in the stage"
S=$(new_stage)
als_mask_snapd "$S" >/dev/null; rc=$?
[ "$rc" != "0" ] && ok "returns non-zero" || bad "returns non-zero" "rc=$rc"
[ ! -e "$S/etc" ] && ok "writes nothing at all (no /etc in the layer)" || bad "writes nothing" "$(find "$S" | head -3)"

echo "only the /usr/bin/firefox-esr symlink, binary missing (dangling)"
S=$(new_stage)
mkdir -p "$S/usr/bin"; ln -s ../lib/firefox-esr/firefox "$S/usr/bin/firefox-esr"
als_mask_snapd "$S" >/dev/null
[ "$(count_masks "$S")" = "0" ] && ok "a dangling symlink does not count as ESR" || bad "dangling symlink" "$(count_masks "$S") masks"

echo "binary present but NOT executable"
S=$(new_stage)
put_esr "$S"; chmod 0644 "$S/usr/lib/firefox-esr/firefox"
als_mask_snapd "$S" >/dev/null
[ "$(count_masks "$S")" = "0" ] && ok "a non-executable file does not count" || bad "non-executable" "$(count_masks "$S") masks"

echo "firefox-esr really in the stage"
S=$(new_stage)
put_esr "$S"
als_mask_snapd "$S" >/dev/null; rc=$?
[ "$rc" = "0" ] && ok "returns 0" || bad "returns 0" "rc=$rc"
for u in snapd.service snapd.socket snapd.seeded.service snapd.apparmor.service \
         snapd.autoimport.service snapd.core-fixup.service snapd.failure.service \
         snapd.recovery-chooser-trigger.service snapd.snap-repair.service \
         snapd.snap-repair.timer snapd.system-shutdown.service; do
  l="$S/etc/systemd/system/$u"
  if [ -L "$l" ] && [ "$(readlink "$l")" = "/dev/null" ]; then ok "masked $u -> /dev/null"
  else bad "masked $u" "$(ls -l "$l" 2>&1)"; fi
done
for u in snapd.session-agent.service snapd.session-agent.socket; do
  l="$S/etc/systemd/user/$u"
  [ -L "$l" ] && [ "$(readlink "$l")" = "/dev/null" ] && ok "masked user unit $u" || bad "masked user unit $u" "$(ls -l "$l" 2>&1)"
done
# Targets carry no ExecStart and are the kind of unit something else might
# Requires= - masking one is the only way this could fail an unrelated unit.
for u in snapd.mounts.target snapd.mounts-pre.target snapd.gpio-chardev-setup.target; do
  [ ! -e "$S/etc/systemd/system/$u" ] && [ ! -L "$S/etc/systemd/system/$u" ] \
    && ok "target $u left alone" || bad "target $u left alone" "it was masked"
done
# The merged-/usr trap: nothing may appear at a real /lib, /bin, /sbin.
for d in lib bin sbin lib64; do
  [ ! -e "$S/$d" ] && ok "no /$d created" || bad "no /$d created" "exists"
done
n=$(count_masks "$S")
[ "$n" = "13" ] && ok "exactly 13 masks, nothing else linked" || bad "13 masks" "$n"

echo "re-running is idempotent"
als_mask_snapd "$S" >/dev/null
[ "$(count_masks "$S")" = "13" ] && ok "still 13 masks" || bad "idempotent" "$(count_masks "$S")"

echo "do_build wires it the right way round"
# The mask call must come AFTER the packages are unpacked (it inspects the
# stage) and BEFORE the permission pass (it creates /etc/systemd dirs).
L=$HERE/make-als-layer.sh
ln_unpack=$(grep -n 'dpkg -x "\$deb" "\$STAGE"' "$L" | head -1 | cut -d: -f1)
ln_mask=$(grep -n '^  als_mask_snapd "\$STAGE"' "$L" | head -1 | cut -d: -f1)
ln_perm=$(grep -n 'step "Normalising directory permissions"' "$L" | head -1 | cut -d: -f1)
if [ -n "$ln_unpack" ] && [ -n "$ln_mask" ] && [ -n "$ln_perm" ] \
   && [ "$ln_unpack" -lt "$ln_mask" ] && [ "$ln_mask" -lt "$ln_perm" ]; then
  ok "unpack ($ln_unpack) < mask ($ln_mask) < permissions ($ln_perm)"
else
  bad "unpack < mask < permissions" "unpack=$ln_unpack mask=$ln_mask perm=$ln_perm"
fi
grep -q 'snapd is masked but firefox-esr is not in the layer' "$L" \
  && ok "the mounted layer is re-checked for mask-without-ESR" \
  || bad "mount-time re-check" "missing"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
