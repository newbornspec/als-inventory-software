#!/usr/bin/env bash
# Tests for which browser gui/als-autostart.sh opens, and how.
#
# A layer with Firefox ESR masks snapd, so the snap Firefox does not exist
# there: the kiosk has to pick firefox-esr, give it a profile directory of
# its own, and the 'full' mode must not depend on xdg-open's default browser
# (the snap's desktop entry, gone once snapd is masked). On an older layer
# with no firefox-esr, behaviour must be exactly what it was: `firefox`.
#
#   bash tools/test-layer-autostart.sh
#
# The script runs for real, with every outside program stubbed: browsers,
# notify-send, logger, flock, setsid and python3 (the health check) only log.
# HOME is a temp directory. Nothing is started.

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s   (%s)\n' "$1" "$2"; }

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
STUB="$T/stub"; MEDIA="$T/media"; CALLS="$T/calls.log"
mkdir -p "$STUB" "$MEDIA/gui"
: > "$MEDIA/gui/server.py"

mkstub() { printf '#!/bin/sh\necho "%s $*" >> "%s"\n%s\n' "$1" "$CALLS" "${2:-exit 0}" > "$STUB/$1"; chmod +x "$STUB/$1"; }
for s in notify-send zenity logger flock python3 xdg-open; do mkstub "$s"; done
# setsid runs its command in the foreground here so the call is logged before
# the script exits.
printf '#!/bin/sh\n"$@"\n' > "$STUB/setsid"; chmod +x "$STUB/setsid"

# Only these directories on PATH: the stubs, and the basic tools the script
# itself uses (sed, tr, date, mkdir, cat, seq, sleep, id).
BASE="$T/base"; mkdir -p "$BASE"
# Wrappers that exec the real tool by absolute path (a copied or linked binary
# cannot find its DLLs on Git Bash); anything not listed here - notably any
# real firefox on the machine running the test - is unreachable.
REAL_BASH=$(command -v bash)
for t in sed tr date mkdir cat seq sleep id; do
  p=$(command -v "$t") || { echo "missing $t"; exit 1; }
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$p" > "$BASE/$t"; chmod +x "$BASE/$t"
done

run() {  # run <mode> <browsers...>
  local mode="$1"; shift
  rm -f "$CALLS" "$STUB"/firefox "$STUB"/firefox-esr "$STUB"/chromium
  for b in "$@"; do mkstub "$b"; done
  rm -rf "$T/home"; mkdir -p "$T/home"
  echo "$mode" > "$T/home/als-autostart.mode"
  env -i HOME="$T/home" PATH="$STUB:$BASE" ALS_SETTLE=0 \
    "$REAL_BASH" "$HERE/gui/als-autostart.sh" "$MEDIA" >/dev/null 2>&1
  settle
}
# The browser is launched in the background; give it a moment to log.
settle() {
  local i
  touch "$CALLS"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    [ -n "$(browser_line)" ] && return 0
    sleep 0.3
  done
}
browser_line() { grep -E '^(firefox|firefox-esr|chromium|xdg-open) ' "$CALLS" | head -1; }

echo "kiosk, both browsers present (an ESR layer)"
run kiosk firefox firefox-esr
l=$(browser_line)
case "$l" in "firefox-esr "*) ok "firefox-esr is chosen over firefox" ;; *) bad "firefox-esr first" "$l" ;; esac
case "$l" in *"--kiosk"*) ok "in kiosk mode" ;; *) bad "--kiosk" "$l" ;; esac
case "$l" in *"--profile $T/home/als-kiosk-profile-esr "*) ok "with its own profile under \$HOME" ;; *) bad "esr profile" "$l" ;; esac
case "$l" in *"http://127.0.0.1:8800"*) ok "onto the local backend" ;; *) bad "url" "$l" ;; esac
[ -f "$T/home/als-kiosk-profile-esr/user.js" ] && ok "user.js written into that profile" || bad "user.js" "missing"
grep -q 'browser.aboutwelcome.enabled", false' "$T/home/als-kiosk-profile-esr/user.js" 2>/dev/null \
  && ok "first-run welcome suppressed" || bad "prefs" "$(cat "$T/home/als-kiosk-profile-esr/user.js" 2>&1)"


# The browser must never keep or fill an operator's password (sign-in with
# each person's own ALS login, AUDIT_OPERATOR_SIGNIN=1).
nopw() {  # nopw <label> <user.js>
  local f="$2" p miss=""
  for p in 'signon.rememberSignons", false' 'signon.autofillForms", false' \
           'signon.formlessCapture.enabled", false' 'browser.formfill.enable", false'; do
    grep -q "$p" "$f" 2>/dev/null || miss="$miss [$p]"
  done
  [ -z "$miss" ] && ok "$1: password saving and autofill off" || bad "$1: password prefs" "missing$miss"
}
nopw "kiosk firefox-esr" "$T/home/als-kiosk-profile-esr/user.js"

echo "kiosk, only the snap firefox (an older layer, or ALS_ESR=0)"
run kiosk firefox
l=$(browser_line)
case "$l" in "firefox --profile $T/home/als-kiosk-profile --kiosk "*) ok "firefox, same profile and args as before" ;;
  *) bad "snap path unchanged" "$l" ;; esac
nopw "kiosk snap firefox" "$T/home/als-kiosk-profile/user.js"

echo "kiosk, ALS_BROWSER still wins"
rm -f "$CALLS"; for b in firefox firefox-esr chromium; do mkstub "$b"; done
rm -rf "$T/home"; mkdir -p "$T/home"; echo kiosk > "$T/home/als-autostart.mode"
env -i HOME="$T/home" PATH="$STUB:$BASE" ALS_SETTLE=0 ALS_BROWSER=chromium \
  "$REAL_BASH" "$HERE/gui/als-autostart.sh" "$MEDIA" >/dev/null 2>&1
settle
l=$(browser_line)
case "$l" in "chromium "*) ok "ALS_BROWSER=chromium honoured" ;; *) bad "ALS_BROWSER" "$l" ;; esac
CRP="$T/home/als-kiosk-profile/Default/Preferences"
case "$l" in *"--user-data-dir=$T/home/als-kiosk-profile"*) ok "chromium: its own user-data-dir" ;; *) bad "chromium profile" "$l" ;; esac
if grep -q '"credentials_enable_service":false' "$CRP" 2>/dev/null \
   && grep -q '"password_manager_enabled":false' "$CRP" 2>/dev/null; then
  ok "chromium: offer-to-save-passwords off in that profile's Preferences"
else
  bad "chromium password prefs" "$(cat "$CRP" 2>&1)"
fi

echo "full (normal window)"
run full firefox firefox-esr
l=$(browser_line)
case "$l" in "firefox-esr --profile $T/home/als-full-profile-esr --new-window http://127.0.0.1:8800") ok "firefox-esr by name, not xdg-open, in its own profile" ;; *) bad "full with esr" "$l" ;; esac
case "$l" in *--kiosk*) bad "full is not kiosk" "$l" ;; *) ok "not a kiosk window" ;; esac
nopw "full firefox-esr" "$T/home/als-full-profile-esr/user.js"
run full firefox
l=$(browser_line)
case "$l" in "xdg-open http://127.0.0.1:8800") ok "without ESR: xdg-open, as before" ;; *) bad "full without esr" "$l" ;; esac

echo "start-gui.sh (the older launcher) writes the same password prefs"
# kiosk_args writes the profile and prints the flags; run just that function
# (and the Chromium prefs writer it calls) against a temp HOME.
SG="$T/sg.sh"
awk '/^write_chromium_prefs\(\) \{/{p=1} /^kiosk_args\(\) \{/{p=1} p{print} p&&/^}/{p=0}' \
  "$HERE/gui/start-gui.sh" > "$SG"
if grep -q '^kiosk_args()' "$SG" && grep -q '^write_chromium_prefs()' "$SG"; then
  rm -rf "$T/sghome"; mkdir -p "$T/sghome"
  fa=$(HOME="$T/sghome" "$REAL_BASH" -c '. "$1"; kiosk_args firefox' _ "$SG")
  case "$fa" in *"--profile $T/sghome/als-ff-profile --kiosk"*) ok "start-gui firefox: its own profile" ;; *) bad "start-gui firefox args" "$fa" ;; esac
  nopw "start-gui firefox" "$T/sghome/als-ff-profile/user.js"
  ca=$(HOME="$T/sghome" "$REAL_BASH" -c '. "$1"; kiosk_args chromium' _ "$SG")
  SGP="$T/sghome/als-cr-profile/Default/Preferences"
  if case "$ca" in *"--user-data-dir=$T/sghome/als-cr-profile"*) true ;; *) false ;; esac \
     && grep -q '"credentials_enable_service":false' "$SGP" 2>/dev/null; then
    ok "start-gui chromium: offer-to-save-passwords off in its user-data-dir"
  else
    bad "start-gui chromium prefs" "$ca / $(cat "$SGP" 2>&1)"
  fi
else
  bad "start-gui.sh: kiosk_args and write_chromium_prefs found" "both functions" "$(head -3 "$SG")"
fi
grep -q 'write_chromium_prefs /tmp/als-cr-profile' "$HERE/gui/start-gui.sh" \
  && ok "start-gui under cage: the chromium profile it uses gets the prefs too" \
  || bad "cage chromium prefs" "write_chromium_prefs /tmp/als-cr-profile before cage"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
