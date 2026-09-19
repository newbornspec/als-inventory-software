#!/usr/bin/env bash
# Tests for the kiosk's Firefox profile TEMPLATE in make-als-layer.sh
# (als_kiosk_userjs, als_ff_seed_ok, als_stage_ff_seed, als_make_ff_seed) and
# the prefs cleaning in gui/layer/ff-seed.py.
#
# Why. Every boot is a brand-new Firefox profile ($HOME is RAM), and Firefox
# spent ~0.8 s of first-run work before its first request (measured: 1.76 s
# fresh, 0.94 s from a template made by the same build at the same path). What
# must hold:
#   - the template is made with the kiosk's OWN prefs (write_ff_prefs);
#   - only a template that matches the ESR in the layer exactly (version,
#     build id, /usr/lib/firefox-esr) and holds only the known files ships;
#   - no per-install identifier ships in prefs.js (every station would share
#     it), and nothing Marionette or user.js set is kept;
#   - it is staged read-only for everyone: files 0644, directories 0755;
#   - opting out (ALS_FF_SEED=0) or having no complete ESR ships nothing, and
#     no failure is fatal to the build;
#   - do_build stages it before the permission pass and the stamps, only with
#     the autostart, and re-checks it on the mounted layer.
#
#   bash tools/test-layer-ffseed.sh
#
# Runs in a temp directory; sources make-als-layer.sh with ALS_LAYER_LIB=1
# (returns before the root check). Firefox itself is never run here - the
# real build (build-in-container.sh) does that.

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s   (%s)\n' "$1" "$2"; }

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

# shellcheck disable=SC1091
ALS_LAYER_LIB=1 . "$HERE/make-als-layer.sh" || { echo "could not source make-als-layer.sh"; exit 1; }
unset ALS_FF_SEED

for f in als_kiosk_userjs als_ff_seed_ok als_stage_ff_seed als_make_ff_seed; do
  if ! command -v "$f" >/dev/null 2>&1; then
    bad "make-als-layer.sh defines $f" "missing"
    echo; echo "$PASS passed, $FAIL failed"; exit 1
  fi
done

LINUX=1
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) LINUX=0 ;; esac

PY=""
for p in python3 python; do
  command -v "$p" >/dev/null 2>&1 && "$p" -c 'import sys; sys.exit(sys.version_info < (3, 8))' 2>/dev/null \
    && { PY=$p; break; }
done

echo "the template is made with the kiosk's own prefs"
AUTO="$HERE/gui/als-autostart.sh"
als_kiosk_userjs "$AUTO" > "$T/user.js"; rc=$?
n=$(grep -c . "$T/user.js")
want=$(sed 's/\r$//' "$AUTO" | awk '/<<.PREFS.$/{p=1;next} /^PREFS$/{p=0} p' | grep -c '^user_pref(')
[ "$rc" = 0 ] && [ "$n" -gt 10 ] && [ "$n" = "$want" ] && ok "all $n user_pref lines of write_ff_prefs" \
  || bad "als_kiosk_userjs" "rc=$rc n=$n want=$want"
grep -vq '^user_pref(' "$T/user.js" && bad "only user_pref lines" "$(grep -v '^user_pref(' "$T/user.js" | head -3)" \
  || ok "nothing but user_pref lines"
for p in 'signon.rememberSignons", false' 'termsofuse.bypassNotification", true' 'app.normandy.enabled", false'; do
  grep -q "$p" "$T/user.js" && ok "  includes $p" || bad "user.js $p" "missing"
done
printf 'no prefs here\n' > "$T/empty.sh"
als_kiosk_userjs "$T/empty.sh" >/dev/null && bad "no heredoc" "accepted" || ok "a launcher with no prefs -> refused"

# A stage with an ESR's application.ini, and a template made for it.
VER=153.3.0; BID=20260908150240
new_stage() {
  rm -rf "$T/stage"; mkdir -p "$T/stage/usr/lib/firefox-esr"
  printf '[App]\nVendor=Mozilla\nName=Firefox\nVersion=%s\nBuildID=%s\n' "$VER" "$BID" \
    > "$T/stage/usr/lib/firefox-esr/application.ini"
  printf '%s' "$T/stage"
}
new_seed() {
  rm -rf "$T/seed"; mkdir -p "$T/seed/startupCache"
  printf '[Compatibility]\nLastVersion=%s_%s/%s\nLastOSABI=Linux_x86_64-gcc3\nLastPlatformDir=/usr/lib/firefox-esr\nLastAppDir=/usr/lib/firefox-esr/browser\n' \
    "$VER" "$BID" "$BID" > "$T/seed/compatibility.ini"
  printf '// Mozilla User Preferences\nuser_pref("browser.migration.version", 160);\nuser_pref("extensions.lastAppBuildId", "%s");\nuser_pref("extensions.webextensions.uuids", "{\\"a@b\\":\\"x\\"}");\n' "$BID" > "$T/seed/prefs.js"
  printf 'x' > "$T/seed/startupCache/scriptCache.bin"
  printf '{}' > "$T/seed/extensions.json"
  printf '{}' > "$T/seed/times.json"
  printf '%s' "$T/seed"
}

echo "which templates may ship"
S=$(new_stage); D=$(new_seed)
als_ff_seed_ok "$D" "$S" && ok "a matching template is accepted" || bad "good template" "refused"
D=$(new_seed); sed -i "s/^LastVersion=.*/LastVersion=153.2.0_$BID\/$BID/" "$D/compatibility.ini"
als_ff_seed_ok "$D" "$S" && bad "other version" "accepted" || ok "made by another ESR version -> refused"
D=$(new_seed); sed -i "s/^LastVersion=.*/LastVersion=${VER}_20260101000000\/20260101000000/" "$D/compatibility.ini"
als_ff_seed_ok "$D" "$S" && bad "other build" "accepted" || ok "same version, another build -> refused"
D=$(new_seed); sed -i 's#^LastPlatformDir=.*#LastPlatformDir=/tmp/stage/usr/lib/firefox-esr#' "$D/compatibility.ini"
als_ff_seed_ok "$D" "$S" && bad "other path" "accepted" || ok "made at another path (cache would be discarded) -> refused"
D=$(new_seed); rm -f "$D/startupCache/scriptCache.bin"
als_ff_seed_ok "$D" "$S" && bad "empty startupCache" "accepted" || ok "no startup cache -> refused"
D=$(new_seed); rm -f "$D/prefs.js"
als_ff_seed_ok "$D" "$S" && bad "no prefs.js" "accepted" || ok "no prefs.js -> refused"
D=$(new_seed); printf 'x' > "$D/cookies.sqlite"
als_ff_seed_ok "$D" "$S" && bad "extra file" "accepted" || ok "an unexpected file (cookies.sqlite) -> refused"
D=$(new_seed); printf 'x' > "$D/.parentlock"
als_ff_seed_ok "$D" "$S" && bad "lock file" "accepted" || ok "a lock file -> refused"
for idp in 'toolkit.telemetry.cachedClientID' 'app.normandy.user_id' 'nimbus.profileId' \
           'toolkit.telemetry.cachedProfileGroupID' 'dom.push.userAgentID' 'toolkit.profiles.storeID'; do
  D=$(new_seed); printf 'user_pref("%s", "0123abcd");\n' "$idp" >> "$D/prefs.js"
  als_ff_seed_ok "$D" "$S" && bad "identifier $idp" "accepted" || ok "prefs.js with $idp -> refused"
done
S2=$(new_stage); rm -f "$S2/usr/lib/firefox-esr/application.ini"; D=$(new_seed)
als_ff_seed_ok "$D" "$S2" && bad "no application.ini" "accepted" || ok "no ESR application.ini to compare with -> refused"
if [ "$LINUX" = 1 ]; then
  S=$(new_stage); D=$(new_seed); ln -s /etc/shadow "$D/startupCache/evil"
  als_ff_seed_ok "$D" "$S" && bad "symlink" "accepted" || ok "a symlink inside -> refused"
fi

echo "staging"
S=$(new_stage); D=$(new_seed)
als_stage_ff_seed "$S" "$D"; rc=$?
[ "$rc" = 0 ] && [ -f "$S/$FF_SEED_DIR/compatibility.ini" ] && [ -f "$S/$FF_SEED_DIR/startupCache/scriptCache.bin" ] \
  && ok "copied to /$FF_SEED_DIR" || bad "staged" "rc=$rc $(find "$S" | head)"
[ "$FF_SEED_DIR" = "usr/share/als/firefox-profile-esr" ] && ok "under /usr/share (merges with the stock /usr, never /lib)" \
  || bad "FF_SEED_DIR" "$FF_SEED_DIR"
als_ff_seed_ok "$S/$FF_SEED_DIR" "$S" && ok "the staged copy still checks out" || bad "staged copy" "refused"
if [ "$LINUX" = 1 ]; then
  chmod 0600 "$D/prefs.js"; chmod 0700 "$D/startupCache"; S=$(new_stage)
  als_stage_ff_seed "$S" "$D"
  nf=$(find "$S/usr/share/als" -type f ! -perm 0644 | wc -l)
  nd=$(find "$S/usr/share/als" -type d ! -perm 0755 | wc -l)
  [ "$nf" = 0 ] && ok "every file 0644 (Firefox wrote some 0600)" || bad "file modes" "$(find "$S/usr/share/als" -type f ! -perm 0644)"
  [ "$nd" = 0 ] && ok "every directory 0755, /usr/share/als included" || bad "dir modes" "$(find "$S/usr/share/als" -type d ! -perm 0755)"
fi

echo "when nothing ships"
S=$(new_stage); : > "$T/list"
out=$(ALS_FF_SEED=0 als_make_ff_seed "$S" "$T/list" "$AUTO" "$HERE/gui/layer/ff-seed.py"); rc=$?
[ "$rc" = 1 ] && [ ! -e "$S/usr/share/als" ] && printf '%s' "$out" | grep -q 'ALS_FF_SEED=0' \
  && ok "ALS_FF_SEED=0 -> no template, and it says so" || bad "opt-out" "rc=$rc $out"
out=$(als_make_ff_seed "$S" "$T/list" "$AUTO" "$HERE/gui/layer/ff-seed.py"); rc=$?
[ "$rc" = 1 ] && [ ! -e "$S/usr/share/als" ] && printf '%s' "$out" | grep -q 'no complete firefox-esr' \
  && ok "no complete ESR in the layer -> no template (and not fatal)" || bad "no esr" "rc=$rc $out"

echo "ff-seed.py cleans prefs.js"
if [ -n "$PY" ]; then
  "$PY" -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$HERE/gui/layer/ff-seed.py" 2>/dev/null && ok "ff-seed.py compiles ($PY)" || bad "py_compile" "failed"
  cat > "$T/prefs.js" <<'P'
// Mozilla User Preferences
user_pref("app.normandy.user_id", "5b3c1f7e-1111-2222-3333-444455556666");
user_pref("browser.migration.version", 160);
user_pref("dom.push.userAgentID", "63c877b356154372afb998a2648b2282");
user_pref("extensions.lastAppBuildId", "20260908150240");
user_pref("extensions.webextensions.uuids", "{\"a@b\":\"c17883c8-72a1-4f9c-b691-0e80ca9886c9\"}");
user_pref("marionette.port", 0);
user_pref("nimbus.profileId", "abc");
user_pref("remote.prefs.recommended", false);
user_pref("signon.rememberSignons", false);
user_pref("some.other.thing", "{11111111-2222-3333-4444-555555555555}");
user_pref("toolkit.profiles.storeID", "da9cfafd");
user_pref("toolkit.telemetry.cachedClientID", "x");
user_pref("toolkit.telemetry.cachedProfileGroupID", "y");
P
  "$PY" - "$HERE/gui/layer/ff-seed.py" "$T/prefs.js" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("ffseed", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.clean_prefs(sys.argv[2], {"signon.rememberSignons"})
PYEOF
  for keep in 'browser.migration.version' 'extensions.lastAppBuildId' 'extensions.webextensions.uuids' '// Mozilla User Preferences'; do
    grep -q "$keep" "$T/prefs.js" && ok "  kept: $keep" || bad "kept $keep" "$(cat "$T/prefs.js")"
  done
  for gone in app.normandy.user_id dom.push.userAgentID marionette.port nimbus.profileId remote.prefs.recommended \
              signon.rememberSignons some.other.thing toolkit.profiles.storeID cachedClientID cachedProfileGroupID; do
    grep -q "$gone" "$T/prefs.js" && bad "stripped $gone" "still there" || ok "  stripped: $gone"
  done
  if grep -Eqi "$FF_SEED_ID_RE" "$T/prefs.js"; then bad "cleaned prefs pass the build's own check" "$(grep -Ei "$FF_SEED_ID_RE" "$T/prefs.js")"
  else ok "the cleaned prefs.js passes the build's identifier check"; fi
else
  echo "  (no python3 - ff-seed.py checks skipped)"
fi

echo "do_build wiring"
L=$HERE/make-als-layer.sh
ln_seed=$(grep -n '^    als_make_ff_seed "\$STAGE" "\$ESR_LIST"' "$L" | head -1 | cut -d: -f1)
ln_mask=$(grep -n '^  als_mask_snapd "\$STAGE"' "$L" | head -1 | cut -d: -f1)
ln_perm=$(grep -n 'step "Normalising directory permissions"' "$L" | head -1 | cut -d: -f1)
ln_stamp=$(grep -n '^    als_write_update_stamps "\$STAGE"' "$L" | head -1 | cut -d: -f1)
if [ -n "$ln_seed" ] && [ -n "$ln_mask" ] && [ -n "$ln_perm" ] && [ -n "$ln_stamp" ] \
   && [ "$ln_mask" -lt "$ln_seed" ] && [ "$ln_seed" -lt "$ln_perm" ] && [ "$ln_perm" -lt "$ln_stamp" ]; then
  ok "after the ESR/snapd step ($ln_mask), before permissions ($ln_perm) and stamps ($ln_stamp)"
else
  bad "ordering" "mask=$ln_mask seed=$ln_seed perm=$ln_perm stamp=$ln_stamp"
fi
sed -n "$((ln_seed - 4)),$((ln_seed))p" "$L" | grep -q 'WANT_AUTOSTART" != "0"' \
  && ok "only with the autostart (it is what copies the template)" || bad "autostart gate" "$(sed -n "$((ln_seed - 4)),$((ln_seed))p" "$L")"
grep -q 'als_ff_seed_ok "\$MP/\$FF_SEED_DIR" "\$MP"' "$L" && ok "re-checked on the mounted layer" || bad "mount re-check" "missing"
grep -q 'unshare -m --propagation private' "$L" && ok "the bind mount lives in a private mount namespace" || bad "unshare" "missing"
grep -q 'mount -o remount,bind,ro' "$L" && ok "the stage's ESR is mounted read-only for the run" || bad "ro bind" "missing"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
