#!/usr/bin/env bash
# Tests for make-als-layer.sh switching cloud-init off with its own marker file,
# /etc/cloud/cloud-init.disabled.
#
# Why. On the station cloud-init.service sat on the chain the display manager
# waited for (after NetworkManager-wait-online, Before=systemd-user-sessions),
# and cloud-init-local took 5.45 s - for a service the kiosk never uses. Its
# generator (via ds-identify's is_disabled) and every one of its units check
# only that the marker EXISTS as a regular file. So what must hold is:
#   - by default the stage gets exactly that file, 0644, under a 0755
#     /etc/cloud DIRECTORY (overlayfs merges it with the stock /etc/cloud and
#     takes the directory's mode from our layer);
#   - ALS_CLOUD_INIT=1 stages nothing at all;
#   - a system whose /etc/cloud is a symlink or a file, or absent, gets nothing
#     (a directory in our layer would REPLACE a lower symlink - the /lib trap);
#   - the file is only a comment (content is never read).
#
#   bash tools/test-layer-cloudinit.sh
#
# Runs entirely in a temp directory; sources make-als-layer.sh with
# ALS_LAYER_LIB=1 (returns before the root check - nothing touches a stick).

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s   (%s)\n' "$1" "$2"; }

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

# shellcheck disable=SC1091
ALS_LAYER_LIB=1 . "$HERE/make-als-layer.sh" || { echo "could not source make-als-layer.sh"; exit 1; }
unset ALS_CLOUD_INIT

# Git Bash reports every file as 0644/0755 by extension, not by chmod, and
# cannot make a real symlink by default - mode and symlink checks need Linux
# (CI is Linux, and so is the station that runs the script).
LINUX=1
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) LINUX=0 ;; esac

# A host root laid out like noble with cloud-init installed: /etc/cloud is a
# real 0755 directory holding cloud.cfg and cloud.cfg.d/ (read out of the
# cloud-init .debs 24.1.3, 24.4~24.04.2 and 26.1~24.04.1).
new_host() {
  rm -rf "$T/host"; mkdir -p "$T/host/etc/cloud/cloud.cfg.d"
  printf 'x\n' > "$T/host/etc/cloud/cloud.cfg"
  printf '%s' "$T/host"
}
new_stage() { rm -rf "$T/stage"; mkdir -p "$T/stage"; printf '%s' "$T/stage"; }
M=etc/cloud/cloud-init.disabled

echo "default build"
H=$(new_host); S=$(new_stage)
out=$(als_disable_cloud_init "$S" "$H"); rc=$?
[ "$rc" = "0" ] && ok "returns 0" || bad "returns 0" "rc=$rc"
[ -f "$S/$M" ] && [ ! -L "$S/$M" ] && ok "stages /$M as a regular file" || bad "marker staged" "$(find "$S" | head)"
[ -d "$S/etc/cloud" ] && [ ! -L "$S/etc/cloud" ] && ok "/etc/cloud is a real directory (merges, not replaces)" \
  || bad "etc/cloud dir" "$(ls -la "$S/etc" 2>&1)"
printf '%s\n' "$out" | grep -qx '  cloud-init: switched off (/etc/cloud/cloud-init.disabled)' \
  && ok "prints the switched-off line" || bad "build output" "$out"
extra=$(cd "$S" && find . -mindepth 1 | LC_ALL=C sort | tr '\n' ' ')
[ "$extra" = "./etc ./etc/cloud ./etc/cloud/cloud-init.disabled " ] \
  && ok "stages nothing else (no cloud.cfg, no cloud.cfg.d shadowed)" || bad "only the marker" "$extra"
if [ -s "$S/$M" ] && [ -z "$(grep -v '^#' "$S/$M")" ]; then
  ok "the file is only comments (the generator checks existence alone)"
else
  bad "comment-only" "$(cat "$S/$M")"
fi
grep -q 'ALS' "$S/$M" && grep -q 'ALS_CLOUD_INIT=1' "$S/$M" \
  && ok "the comment says the ALS layer put it there and how to undo it" || bad "comment text" "$(cat "$S/$M")"
if [ "$LINUX" = "1" ]; then
  p=$(stat -c %a "$S/$M"); [ "$p" = "644" ] && ok "marker is 0644" || bad "marker mode" "$p"
  for d in etc etc/cloud; do
    p=$(stat -c %a "$S/$d"); [ "$p" = "755" ] && ok "/$d is 0755" || bad "/$d mode" "$p"
  done
fi

if [ "$LINUX" = "1" ]; then
  echo "under a hostile umask (077 and 002)"
  for um in 0077 0002; do
    H=$(new_host); S=$(new_stage)
    ( umask "$um"; als_disable_cloud_init "$S" "$H" >/dev/null )
    m=$(stat -c %a "$S/$M" 2>/dev/null); d=$(stat -c %a "$S/etc/cloud" 2>/dev/null); e=$(stat -c %a "$S/etc" 2>/dev/null)
    [ "$m/$d/$e" = "644/755/755" ] && ok "umask $um: marker 0644, etc/cloud 0755, etc 0755" \
      || bad "umask $um modes" "$m/$d/$e"
  done

  echo "a stage that already has a group-writable /etc/cloud"
  H=$(new_host); S=$(new_stage); mkdir -p "$S/etc/cloud"; chmod 0775 "$S/etc" "$S/etc/cloud"
  als_disable_cloud_init "$S" "$H" >/dev/null
  [ "$(stat -c %a "$S/etc/cloud")/$(stat -c %a "$S/etc")" = "755/755" ] \
    && ok "made 0755" || bad "0775 fixed" "$(stat -c %a "$S/etc/cloud")"
fi

echo "ALS_CLOUD_INIT=1 (opt-out)"
H=$(new_host); S=$(new_stage)
out=$(ALS_CLOUD_INIT=1 als_disable_cloud_init "$S" "$H"); rc=$?
[ "$rc" != "0" ] && ok "returns non-zero" || bad "opt-out rc" "rc=$rc"
[ ! -e "$S/etc" ] && ok "stages nothing at all (no /etc in the layer)" || bad "opt-out stages nothing" "$(find "$S")"
printf '%s\n' "$out" | grep -q 'cloud-init: left as it is (ALS_CLOUD_INIT=1)' \
  && ok "prints the opt-out line" || bad "opt-out output" "$out"

echo "ALS_CLOUD_INIT=0 is the same as the default"
H=$(new_host); S=$(new_stage)
ALS_CLOUD_INIT=0 als_disable_cloud_init "$S" "$H" >/dev/null
[ -f "$S/$M" ] && ok "marker staged" || bad "ALS_CLOUD_INIT=0" "missing"

echo "cloud-init not installed (no /etc/cloud on the system)"
rm -rf "$T/host"; mkdir -p "$T/host/etc"; S=$(new_stage)
als_disable_cloud_init "$S" "$T/host" >/dev/null; rc=$?
[ "$rc" != "0" ] && [ ! -e "$S/etc" ] && ok "stages nothing" || bad "not installed" "rc=$rc $(find "$S")"

echo "/etc/cloud on the system is a FILE"
rm -rf "$T/host"; mkdir -p "$T/host/etc"; echo x > "$T/host/etc/cloud"; S=$(new_stage)
als_disable_cloud_init "$S" "$T/host" >/dev/null; rc=$?
[ "$rc" != "0" ] && [ ! -e "$S/etc" ] && ok "stages nothing (a directory would replace the file)" || bad "file" "rc=$rc"

if [ "$LINUX" = "1" ]; then
  echo "/etc/cloud on the system is a SYMLINK (even to a directory)"
  rm -rf "$T/host"; mkdir -p "$T/host/etc" "$T/host/usr/share/cloud"
  ln -s ../usr/share/cloud "$T/host/etc/cloud"; S=$(new_stage)
  als_disable_cloud_init "$S" "$T/host" >/dev/null; rc=$?
  [ "$rc" != "0" ] && [ ! -e "$S/etc" ] && ok "stages nothing (a directory would replace the symlink)" || bad "symlink" "rc=$rc"

  echo "the stage itself has a non-directory at etc/cloud"
  H=$(new_host); S=$(new_stage); mkdir -p "$S/etc"; echo x > "$S/etc/cloud"
  ( als_disable_cloud_init "$S" "$H" >/dev/null 2>&1 ); rc=$?
  [ "$rc" != "0" ] && [ -f "$S/etc/cloud" ] && ok "refuses (dies), leaves it alone" || bad "stage file" "rc=$rc"
fi

echo "do_build wiring"
L=$HERE/make-als-layer.sh
ln_call=$(grep -n 'als_disable_cloud_init "\$STAGE"' "$L" | head -1 | cut -d: -f1)
ln_perm=$(grep -n 'step "Normalising directory permissions"' "$L" | head -1 | cut -d: -f1)
ln_stamp=$(grep -n '^    als_write_update_stamps "\$STAGE"' "$L" | head -1 | cut -d: -f1)
if [ -n "$ln_call" ] && [ -n "$ln_perm" ] && [ -n "$ln_stamp" ] \
   && [ "$ln_call" -lt "$ln_perm" ] && [ "$ln_call" -lt "$ln_stamp" ]; then
  ok "staged ($ln_call) before the permission pass ($ln_perm) and the stamps ($ln_stamp)"
else
  bad "ordering" "call=$ln_call perm=$ln_perm stamp=$ln_stamp"
fi
grep -q 'is not a regular file in the layer - cloud-init would still run' "$L" \
  && ok "the mounted layer is re-checked for the marker" || bad "mount re-check" "missing"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
