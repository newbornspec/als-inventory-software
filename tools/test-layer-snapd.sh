#!/usr/bin/env bash
# Tests for make-als-layer.sh's snapd mask: it must happen ONLY when the
# WHOLE firefox-esr package is really in the layer.
#
# Why. Masking snapd is what saves ~95 s of snap seeding per boot, but the
# stock /usr/bin/firefox is a wrapper that exits "requires the firefox snap".
# A layer that masks snapd without carrying ESR boots to a kiosk with no
# browser. So the condition is the stage's own contents - every file of the
# .deb at its packaged size, not just the binary (a partial unpack leaves the
# binary next to a truncated libxul.so), not a symlink to it, not "the
# download returned 0".
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
# A stand-in ESR: the binary, a 64 KiB "libxul.so", the symlink - and LIST,
# the entry list in als_deb_entries' format that als_unpack_esr would have
# written from the .deb. The mask gate checks the stage against it.
LIST="$T/esr.list"
put_esr() {
  mkdir -p "$1/usr/lib/firefox-esr" "$1/usr/bin"
  printf '#!/bin/sh\nexit 0\n' > "$1/usr/lib/firefox-esr/firefox"
  chmod 0755 "$1/usr/lib/firefox-esr/firefox"
  head -c 65536 /dev/zero > "$1/usr/lib/firefox-esr/libxul.so"
  ln -s ../lib/firefox-esr/firefox "$1/usr/bin/firefox-esr"
  {
    echo "d 0 usr/lib/firefox-esr"
    echo "- $(stat -c %s "$1/usr/lib/firefox-esr/firefox") usr/lib/firefox-esr/firefox"
    echo "- 65536 usr/lib/firefox-esr/libxul.so"
    echo "l 0 usr/bin/firefox-esr"
  } > "$LIST"
}
count_masks() { find "$1/etc/systemd" -type l 2>/dev/null | wc -l | tr -d ' '; }

echo "no firefox-esr in the stage"
S=$(new_stage)
als_mask_snapd "$S" "$LIST" >/dev/null; rc=$?
[ "$rc" != "0" ] && ok "returns non-zero" || bad "returns non-zero" "rc=$rc"
[ ! -e "$S/etc" ] && ok "writes nothing at all (no /etc in the layer)" || bad "writes nothing" "$(find "$S" | head -3)"

echo "only the /usr/bin/firefox-esr symlink, binary missing (dangling)"
S=$(new_stage)
mkdir -p "$S/usr/bin"; ln -s ../lib/firefox-esr/firefox "$S/usr/bin/firefox-esr"
als_mask_snapd "$S" "$LIST" >/dev/null
[ "$(count_masks "$S")" = "0" ] && ok "a dangling symlink does not count as ESR" || bad "dangling symlink" "$(count_masks "$S") masks"

echo "binary present but NOT executable"
S=$(new_stage)
put_esr "$S"; chmod 0644 "$S/usr/lib/firefox-esr/firefox"
als_mask_snapd "$S" "$LIST" >/dev/null
[ "$(count_masks "$S")" = "0" ] && ok "a non-executable file does not count" || bad "non-executable" "$(count_masks "$S") masks"

echo "firefox-esr really in the stage"
S=$(new_stage)
put_esr "$S"
als_mask_snapd "$S" "$LIST" >/dev/null; rc=$?
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
als_mask_snapd "$S" "$LIST" >/dev/null
[ "$(count_masks "$S")" = "13" ] && ok "still 13 masks" || bad "idempotent" "$(count_masks "$S")"

# ---------------------------------------------------------------------------
# A HALF-UNPACKED ESR. The real failure: the build stage is on the station's
# RAM overlay, the ESR .deb unpacks to ~311 MB, and the tar puts the firefox
# binary (entry 31) long before the 185 MB libxul.so (entry 90). Out of space
# mid-unpack = an executable binary next to a truncated libxul. The old gate
# (`-x firefox`) masked snapd on that, and the station had no browser at all.
echo "binary executable but libxul.so TRUNCATED (partial unpack)"
S=$(new_stage)
put_esr "$S"; truncate -s 100 "$S/usr/lib/firefox-esr/libxul.so"
als_mask_snapd "$S" "$LIST" >/dev/null; rc=$?
[ "$rc" != "0" ] && [ "$(count_masks "$S")" = "0" ] && ok "a truncated libxul.so is not a browser: no mask" \
  || bad "truncated libxul" "rc=$rc, $(count_masks "$S") masks"

echo "binary executable but libxul.so MISSING"
S=$(new_stage)
put_esr "$S"; rm -f "$S/usr/lib/firefox-esr/libxul.so"
als_mask_snapd "$S" "$LIST" >/dev/null
[ "$(count_masks "$S")" = "0" ] && ok "a missing libxul.so: no mask" || bad "missing libxul" "$(count_masks "$S") masks"

echo "binary executable but NO file list to prove the rest"
S=$(new_stage)
put_esr "$S"
als_mask_snapd "$S" >/dev/null
[ "$(count_masks "$S")" = "0" ] && ok "no list: no mask (never guess)" || bad "no list" "$(count_masks "$S") masks"
als_mask_snapd "$S" "$T/does-not-exist" >/dev/null
[ "$(count_masks "$S")" = "0" ] && ok "missing list file: no mask" || bad "missing list file" "$(count_masks "$S") masks"

echo "a list that does not name the binary"
S=$(new_stage)
put_esr "$S"; grep -v ' usr/lib/firefox-esr/firefox$' "$LIST" > "$T/l2"
als_mask_snapd "$S" "$T/l2" >/dev/null
[ "$(count_masks "$S")" = "0" ] && ok "list without ESR_BIN: no mask" || bad "list without bin" "$(count_masks "$S") masks"

# ---------------------------------------------------------------------------
# The same, through the REAL unpack path: a real .deb, real dpkg-deb -c and
# dpkg -x, and a dpkg stand-in that fails the way a full overlay does.
if ! command -v dpkg-deb >/dev/null 2>&1 || ! command -v dpkg >/dev/null 2>&1; then
  echo "  SKIP  the .deb unpack cases need dpkg/dpkg-deb (Ubuntu CI has them)"
else
  REAL_DPKG=$(command -v dpkg)
  P="$T/pkg"
  mkdir -p "$P/DEBIAN" "$P/usr/lib/firefox-esr" "$P/usr/bin" "$P/usr/share/applications"
  printf 'Package: firefox-esr\nVersion: 1.0\nArchitecture: all\nMaintainer: test <t@example.invalid>\nDescription: test stand-in\n' > "$P/DEBIAN/control"
  printf '#!/bin/sh\nexit 0\n' > "$P/usr/lib/firefox-esr/firefox"; chmod 0755 "$P/usr/lib/firefox-esr/firefox"
  head -c 300000 /dev/urandom > "$P/usr/lib/firefox-esr/libxul.so"
  printf 'omni\n' > "$P/usr/lib/firefox-esr/omni ja with space"
  printf '#!/bin/sh\nexec firefox-esr "$@"\n' > "$P/usr/bin/firefox"; chmod 0755 "$P/usr/bin/firefox"
  ln -s ../lib/firefox-esr/firefox "$P/usr/bin/firefox-esr"
  ln "$P/usr/lib/firefox-esr/firefox" "$P/usr/lib/firefox-esr/firefox-hardlink"
  printf '[Desktop Entry]\nName=Firefox ESR\n' > "$P/usr/share/applications/firefox-esr.desktop"
  DEB="$T/firefox-esr_1.0_all.deb"
  dpkg-deb --root-owner-group --build "$P" "$DEB" >/dev/null 2>&1 || dpkg-deb --build "$P" "$DEB" >/dev/null 2>&1

  echo "als_deb_entries reads a real .deb"
  E=$(als_deb_entries "$DEB")
  printf '%s\n' "$E" | grep -qx -e '- 300000 usr/lib/firefox-esr/libxul.so' && ok "regular file with its size" || bad "libxul entry" "$E"
  printf '%s\n' "$E" | grep -qx 'l 0 usr/bin/firefox-esr' && ok "symlink listed without ' -> target'" || bad "symlink entry" "$E"
  printf '%s\n' "$E" | grep -q -e '^- [0-9]* usr/lib/firefox-esr/omni ja with space$' && ok "a path with spaces survives" || bad "space path" "$E"
  printf '%s\n' "$E" | grep -q '^d 0 usr/lib/firefox-esr$' && ok "directories typed d, no trailing /" || bad "dir entry" "$E"

  unpack_case() {   # $1 = dpkg stand-in behaviour: real | fail-partial | ok-but-truncated | fail-early
    S=$(new_stage)
    mkdir -p "$S/usr/bin"; printf 'x' > "$S/usr/bin/hivexget"   # another package's file
    rm -rf "$T/bin"; mkdir -p "$T/bin"
    case "$1" in
      real) ;;
      fail-partial|ok-but-truncated)
        rc=2; [ "$1" = "ok-but-truncated" ] && rc=0
        printf '#!/bin/sh\n"%s" "$@"\ntruncate -s 1000 "$3/usr/lib/firefox-esr/libxul.so"\nexit %s\n' "$REAL_DPKG" "$rc" > "$T/bin/dpkg" ;;
      fail-early)
        printf '#!/bin/sh\nexit 2\n' > "$T/bin/dpkg" ;;
    esac
    [ -f "$T/bin/dpkg" ] && chmod 0755 "$T/bin/dpkg"
    PATH="$T/bin:$PATH" als_unpack_esr "$DEB" "$S" "$T/esr.files" >/dev/null 2>&1; urc=$?
    als_mask_snapd "$S" "$T/esr.files" >/dev/null
  }
  no_esr_left() {
    local left="" f
    for f in usr/lib/firefox-esr usr/bin/firefox-esr usr/bin/firefox usr/share/applications/firefox-esr.desktop; do
      { [ -e "$S/$f" ] || [ -L "$S/$f" ]; } && left="$left /$f"
    done
    printf '%s' "$left"
  }

  echo "real .deb, clean unpack"
  unpack_case real
  [ "$urc" = "0" ] && ok "als_unpack_esr returns 0" || bad "clean unpack rc" "$urc"
  als_esr_complete "$S" "$T/esr.files" && ok "complete" || bad "complete" "not complete"
  [ "$(count_masks "$S")" = "13" ] && ok "snapd masked" || bad "masked after clean unpack" "$(count_masks "$S")"

  echo "dpkg -x FAILS partway (ENOSPC on the live overlay), libxul truncated"
  unpack_case fail-partial
  [ "$urc" != "0" ] && ok "als_unpack_esr reports the failure (rc=$urc)" || bad "partial unpack rc" "0"
  [ -z "$(no_esr_left)" ] && ok "every ESR file removed again" || bad "partial ESR left in the stage" "$(no_esr_left)"
  [ "$(count_masks "$S")" = "0" ] && ok "snapd NOT masked" || bad "masked after partial unpack" "$(count_masks "$S")"
  [ -f "$S/usr/bin/hivexget" ] && ok "other packages' files untouched" || bad "collateral" "hivexget gone"
  [ ! -e "$T/esr.files" ] && ok "the list is dropped, so the mount check cannot pass on it" || bad "list dropped" "still there"

  echo "dpkg -x says 0 but a file came out the wrong size"
  unpack_case ok-but-truncated
  [ "$urc" != "0" ] && [ -z "$(no_esr_left)" ] && [ "$(count_masks "$S")" = "0" ] \
    && ok "caught by the size check, removed, no mask" || bad "silent truncation" "rc=$urc left=$(no_esr_left) masks=$(count_masks "$S")"

  echo "dpkg -x fails before writing anything"
  unpack_case fail-early
  [ "$urc" != "0" ] && [ -z "$(no_esr_left)" ] && [ "$(count_masks "$S")" = "0" ] \
    && ok "nothing staged, no mask" || bad "early failure" "rc=$urc left=$(no_esr_left) masks=$(count_masks "$S")"
fi

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
grep -q '&& ! als_esr_complete "\$MP" "\$ESR_LIST"' "$L" \
  && ok "the mount-time re-check proves completeness, not just the binary" \
  || bad "mount-time completeness" "als_esr_complete \$MP not used"
grep -q '^  als_mask_snapd "\$STAGE" "\$ESR_LIST"' "$L" \
  && ok "do_build hands the mask its file list" || bad "mask gets the list" "missing"
# firefox-esr must go through als_unpack_esr (exit status checked), never the
# generic `dpkg -x ... 2>/dev/null &&` that swallowed the failure.
awk '/firefox-esr_\*\.deb\)/{c=1} c&&/als_unpack_esr "\$deb" "\$STAGE" "\$ESR_LIST"/{f=1} c&&/continue ;;/{exit} END{exit !f}' "$L" \
  && ok "firefox-esr .debs take the checked unpack path" || bad "checked unpack path" "not wired"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
