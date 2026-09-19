#!/usr/bin/env bash
# Tests for the ConditionNeedsUpdate stamps make-als-layer.sh writes.
#
# Why. ldconfig.service (8.3 s, on the critical path) and its siblings ran on
# EVERY boot, because the layer's /usr is newer than the stock image's
# /etc/.updated and systemd reads that as "/usr was updated, rebuild caches".
# The fix ships /etc/.updated and /var/.updated that are never older than the
# layer's /usr. Getting the ordering wrong by one second brings the 8 s back
# silently, so this pins it down - including a model of systemd's own
# comparison (v255 condition_test_needs_update) applied to the result.
#
#   bash tools/test-layer-stamps.sh
#
# Runs entirely in a temp directory; sources make-als-layer.sh with
# ALS_LAYER_LIB=1 (returns before the root check).

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s   (%s)\n' "$1" "$2"; }

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

# shellcheck disable=SC1091
ALS_LAYER_LIB=1 . "$HERE/make-als-layer.sh" || { echo "could not source make-als-layer.sh"; exit 1; }

# A host root whose ld.so.conf is the stock noble one, so the test does not
# depend on the machine running it.
HOST="$T/host"
mkdir -p "$HOST/etc/ld.so.conf.d"
printf 'include /etc/ld.so.conf.d/*.conf\n\n' > "$HOST/etc/ld.so.conf"
printf '# libc default configuration\n/usr/local/lib\n' > "$HOST/etc/ld.so.conf.d/libc.conf"
printf '# Multiarch support\n/usr/local/lib/x86_64-linux-gnu\n/lib/x86_64-linux-gnu\n/usr/lib/x86_64-linux-gnu\n' \
  > "$HOST/etc/ld.so.conf.d/x86_64-linux-gnu.conf"
export ALS_HOST_ROOT="$HOST"

mtime() { stat -c %Y "$1"; }
new_stage() {
  rm -rf "$T/stage"; mkdir -p "$T/stage/usr/bin" "$T/stage/usr/lib/x86_64-linux-gnu"
  printf 'x' > "$T/stage/usr/bin/tool"
  printf '%s' "$T/stage"
}

# systemd v255 condition_test_needs_update, for a squashfs (whole seconds, so
# nsec is 0 on both sides and the TIMESTAMP_NSEC branch is never reached).
# Echoes "update" or "no-update".
needs_update() {
  local stamp="$1" usr="$2"
  [ -e "$stamp" ] || { echo update; return; }
  [ "$(mtime "$usr")" -gt "$(mtime "$stamp")" ] && echo update || echo no-update
}

T0=1790000000   # a fixed second, so the assertions are exact

echo "stamp format and times"
S=$(new_stage)
als_write_update_stamps "$S" "$T0" >/dev/null
for f in etc/.updated var/.updated; do
  if [ -f "$S/$f" ]; then ok "/$f written"; else bad "/$f written" "missing"; continue; fi
  [ "$(grep -c '^TIMESTAMP_NSEC=' "$S/$f")" = "1" ] && ok "/$f has one TIMESTAMP_NSEC line" || bad "/$f TIMESTAMP_NSEC" "$(cat "$S/$f")"
  v=$(sed -n 's/^TIMESTAMP_NSEC=//p' "$S/$f")
  [ "$v" = "${T0}000000000" ] && ok "/$f TIMESTAMP_NSEC is T in nanoseconds ($v)" || bad "/$f value" "$v"
  head -1 "$S/$f" | grep -q '^# This file was created by systemd-update-done' \
    && ok "/$f uses systemd-update-done's header" || bad "/$f header" "$(head -1 "$S/$f")"
  [ "$(grep -vc '^#' "$S/$f")" = "1" ] && ok "/$f has no other data lines" || bad "/$f data lines" "$(cat "$S/$f")"
  [ "$(mtime "$S/$f")" = "$T0" ] && ok "/$f mtime is T" || bad "/$f mtime" "$(mtime "$S/$f")"
  perm=$(stat -c %a "$S/$f")
  [ "$perm" = "644" ] && ok "/$f is 0644" || bad "/$f mode" "$perm"
done
[ "$(mtime "$S/usr")" = "$T0" ] && ok "/usr pinned to T" || bad "/usr mtime" "$(mtime "$S/usr")"
[ "$(needs_update "$S/etc/.updated" "$S/usr")" = "no-update" ] && ok "systemd model: /etc needs no update" || bad "model /etc" "update"
[ "$(needs_update "$S/var/.updated" "$S/usr")" = "no-update" ] && ok "systemd model: /var needs no update" || bad "model /var" "update"
for d in etc var usr; do
  p=$(stat -c %a "$S/$d")
  [ "$p" = "755" ] && ok "/$d is 0755 (overlay takes the mode from our layer)" || bad "/$d mode" "$p"
done

echo "group-writable /usr, /etc, /var in the stage (built under umask 002)"
# The default umask for a normal Ubuntu user is 002, and a CI runner's could be
# too. The stamping function must SET 0755 on the directories it pins, not
# inherit whatever the stage happened to be made with - our layer's mode is the
# booted system's mode for these three.
S=$(new_stage)
mkdir -p "$S/etc" "$S/var"
chmod 0775 "$S/usr" "$S/etc" "$S/var"
( umask 0002; als_write_update_stamps "$S" "$T0" >/dev/null )
for d in etc var usr; do
  p=$(stat -c %a "$S/$d")
  [ "$p" = "755" ] && ok "0775 /$d is made 0755" || bad "0775 /$d made 0755" "$p"
done

echo "/usr NEWER than T before stamping (clock behind, or a late write)"
S=$(new_stage)
touch -d "@$((T0 + 5000))" "$S/usr"
als_write_update_stamps "$S" "$T0" >/dev/null
[ "$(mtime "$S/usr")" -le "$(mtime "$S/etc/.updated")" ] && ok "stamp is never older than /usr" \
  || bad "stamp >= /usr" "usr=$(mtime "$S/usr") stamp=$(mtime "$S/etc/.updated")"
[ "$(needs_update "$S/etc/.updated" "$S/usr")" = "no-update" ] && ok "systemd model: no update" || bad "model" "update"

echo "a stage with no /usr at all"
rm -rf "$T/stage"; mkdir -p "$T/stage"
als_write_update_stamps "$T/stage" "$T0" >/dev/null
[ -d "$T/stage/usr" ] && [ "$(mtime "$T/stage/usr")" = "$T0" ] \
  && ok "/usr created and pinned, so the merged /usr is ours, not a lower layer's" \
  || bad "/usr created" "$(ls -la "$T/stage")"

echo "the model itself: a stale stamp DOES trigger (so the test can fail)"
S=$(new_stage)
als_write_update_stamps "$S" "$T0" >/dev/null
touch -d "@$((T0 + 1))" "$S/usr"
[ "$(needs_update "$S/etc/.updated" "$S/usr")" = "update" ] && ok "one second newer /usr -> update" || bad "model sanity" "no-update"
[ "$(needs_update "$S/nonexistent" "$S/usr")" = "update" ] && ok "missing stamp -> update" || bad "model sanity 2" "no-update"

echo "the stamps step aside when a skipped job would have had work"
S=$(new_stage); mkdir -p "$S/etc/ld.so.conf.d"; echo /opt/x > "$S/etc/ld.so.conf.d/x.conf"
als_write_update_stamps "$S" "$T0" >/dev/null
[ ! -e "$S/etc/.updated" ] && ok "ld.so.conf.d entry -> no /etc stamp (ldconfig runs)" || bad "ld.so.conf.d" "stamp written"
[ -e "$S/var/.updated" ] && ok "... /var stamp still written" || bad "var stamp" "missing"

S=$(new_stage); mkdir -p "$S/usr/lib/udev/hwdb.d"; echo x > "$S/usr/lib/udev/hwdb.d/60-x.hwdb"
als_write_update_stamps "$S" "$T0" >/dev/null
[ ! -e "$S/etc/.updated" ] && ok "hwdb.d file -> no /etc stamp (hwdb-update runs)" || bad "hwdb" "stamp written"

S=$(new_stage); mkdir -p "$S/usr/lib/sysusers.d"; echo 'u x - -' > "$S/usr/lib/sysusers.d/x.conf"
als_write_update_stamps "$S" "$T0" >/dev/null
[ ! -e "$S/etc/.updated" ] && ok "sysusers.d file -> no /etc stamp (sysusers runs)" || bad "sysusers" "stamp written"

S=$(new_stage); mkdir -p "$S/usr/lib/systemd/catalog"; echo x > "$S/usr/lib/systemd/catalog/x.catalog"
als_write_update_stamps "$S" "$T0" >/dev/null
[ ! -e "$S/var/.updated" ] && ok "journal catalog -> no /var stamp" || bad "catalog" "stamp written"
[ -e "$S/etc/.updated" ] && ok "... /etc stamp still written" || bad "etc stamp" "missing"

S=$(new_stage); mkdir -p "$S/usr/local/lib"; echo x > "$S/usr/local/lib/libfoo.so.1"
als_write_update_stamps "$S" "$T0" >/dev/null
[ ! -e "$S/etc/.updated" ] && ok "library in /usr/local/lib (cache-only dir) -> no /etc stamp" || bad "local lib" "stamp written"

S=$(new_stage); echo x > "$S/usr/lib/x86_64-linux-gnu/libbar.so.2"
als_write_update_stamps "$S" "$T0" >/dev/null
[ -e "$S/etc/.updated" ] && ok "library in /usr/lib/x86_64-linux-gnu (ld.so default path) -> stamp written" \
  || bad "multiarch lib" "stamp withheld"

S=$(new_stage); mkdir -p "$S/usr/lib/firefox-esr"; echo x > "$S/usr/lib/firefox-esr/libxul.so"
als_write_update_stamps "$S" "$T0" >/dev/null
[ -e "$S/etc/.updated" ] && ok "firefox-esr's private libs (RPATH, never cached) -> stamp written" \
  || bad "esr libs" "stamp withheld"

echo "do_build calls it LAST"
# Anything written into the stage after the stamps could move /usr's mtime.
L=$HERE/make-als-layer.sh
ln_stamp=$(grep -n '^    als_write_update_stamps "\$STAGE"' "$L" | head -1 | cut -d: -f1)
ln_mask=$(grep -n '^  als_mask_snapd "\$STAGE"' "$L" | head -1 | cut -d: -f1)
ln_perm=$(grep -n 'step "Normalising directory permissions"' "$L" | head -1 | cut -d: -f1)
ln_ocs=$(grep -n 'step "Offline OS restore"' "$L" | head -1 | cut -d: -f1)
ln_manifest=$(grep -n '^  MANIFEST="\$STAGE.manifest"' "$L" | head -1 | cut -d: -f1)
ln_squash=$(grep -n '^  mksquashfs "\$STAGE"' "$L" | head -1 | cut -d: -f1)
if [ -n "$ln_stamp" ] && [ -n "$ln_mask" ] && [ -n "$ln_perm" ] && [ -n "$ln_ocs" ] && [ -n "$ln_squash" ] \
   && [ "$ln_mask" -lt "$ln_stamp" ] && [ "$ln_perm" -lt "$ln_stamp" ] && [ "$ln_ocs" -lt "$ln_stamp" ] \
   && [ "$ln_stamp" -lt "$ln_manifest" ] && [ "$ln_manifest" -lt "$ln_squash" ]; then
  ok "mask ($ln_mask), perms ($ln_perm), checks ($ln_ocs) < stamps ($ln_stamp) < manifest < mksquashfs ($ln_squash)"
else
  bad "stamp ordering" "mask=$ln_mask perm=$ln_perm ocs=$ln_ocs stamp=$ln_stamp manifest=$ln_manifest squash=$ln_squash"
fi
# Nothing between the stamp call and mksquashfs may write into $STAGE.
between=$(sed -n "$((ln_stamp + 1)),$((ln_squash - 1))p" "$L" | grep -v '^[[:space:]]*#' \
          | grep -E '(>|cp |mkdir|touch|ln |dpkg|chmod)[^|]*"\$STAGE/' || true)
[ -z "$between" ] && ok "nothing writes into the stage after the stamps" || bad "writes after stamps" "$between"
grep -q 'is older than the layer' "$L" && ok "the mounted layer is re-checked (stamp >= /usr)" || bad "mount re-check" "missing"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
