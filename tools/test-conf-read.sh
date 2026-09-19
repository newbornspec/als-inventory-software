#!/usr/bin/env bash
#
# audit.conf is read by the engine as data, never run as code.
#
# WHY THIS EXISTS
# hardware-audit.sh used to load audit.conf with `. <(sed 's/\r$//' "$conf")`:
# the file ran as bash, as root (the kiosk starts the engine with sudo for
# every capture and every wipe). The kiosk's Settings screen writes the Wi-Fi
# name and password into that file with no PIN, so a network name typed as
#     x"$(any command)"
# ran that command as root the next time the engine started. The engine now
# reads KEY="value" lines literally (als_read_conf), the way the kiosk's
# load_conf does. This extracts that function and feeds it hostile and
# ordinary files. Nothing here touches a disk other than temp files.
#
#   bash tools/test-conf-read.sh

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
SRC="$DIR/hardware-audit.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  ok    $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL  $1"; echo "     expected: $2"; echo "     actual:   $3"; }
check() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

awk '/^als_read_conf\(\) \{/{p=1} p{print} p&&/^}/{exit}' "$SRC" > "$WORK/conf.sh"
if ! grep -q '^als_read_conf()' "$WORK/conf.sh"; then
  bad "hardware-audit.sh defines als_read_conf" "the function" "not found"
  echo; echo "$PASS passed, $FAIL failed"; exit 1
fi
# shellcheck disable=SC1090
. "$WORK/conf.sh"

echo
echo "== the engine no longer sources audit.conf =="
if grep -nE '^[^#]*(\.|source)[[:space:]]+<\(.*conf' "$SRC" >/dev/null \
   || grep -nE '^[^#]*(\.|source)[[:space:]]+"?\$conf' "$SRC" >/dev/null; then
  bad "no '. <(... audit.conf)' left in hardware-audit.sh" "none" "$(grep -nE '(\.|source)[[:space:]]+(<\(|"?\$conf)' "$SRC")"
else
  ok "no '. <(... audit.conf)' left in hardware-audit.sh"
fi
grep -q 'als_read_conf "\$conf"' "$SRC" && ok "the config loop calls als_read_conf" \
  || bad "the config loop calls als_read_conf" "als_read_conf \"\$conf\"" "$(grep -n 'audit.conf; do' -A3 "$SRC")"

echo
echo "== hostile values are data, not commands =="
PWN="$WORK/pwned"
# Exactly what the kiosk's save_conf writes for an SSID typed on the screen as
#   x"$(touch <file>)"      and    `touch <file>2`
printf '%s\n' \
  "WIFI_SSID=\"x\"\$(touch $PWN)\"\"" \
  "WIFI_PASSWORD=\"\`touch ${PWN}2\`\"" \
  "AUDIT_OPERATOR=\"a; touch ${PWN}3\"" > "$WORK/evil.conf"
( unset WIFI_SSID WIFI_PASSWORD AUDIT_OPERATOR
  als_read_conf "$WORK/evil.conf"
  printf '%s\n%s\n%s\n' "$WIFI_SSID" "$WIFI_PASSWORD" "$AUDIT_OPERATOR" > "$WORK/vals" )
[ -e "$PWN" ] || [ -e "${PWN}2" ] || [ -e "${PWN}3" ] \
  && bad "no command in a value ran" "no file" "$(ls "$WORK")" \
  || ok "no command in a value ran"
check "\$( ) kept literally"  "x\"\$(touch $PWN)\"" "$(sed -n 1p "$WORK/vals")"
check "backticks kept literally" "\`touch ${PWN}2\`" "$(sed -n 2p "$WORK/vals")"
check "a ; kept literally" "a; touch ${PWN}3" "$(sed -n 3p "$WORK/vals")"

# A second line smuggled into the file (the other half of the kiosk bug: a
# newline in the SSID) may still ADD a station setting - the kiosk refuses
# such a value now (test-settings-lock.py) - but it can never set anything
# outside the station's own keys.
printf '%s\n' 'PATH="/nonexistent-evil"' 'IFS="x"' 'LD_PRELOAD="/tmp/evil.so"' \
  'SELF_DIR="/evil"' 'API_DEFAULT="https://evil.example"' 'AUDIT_URL="https://ok.example"' > "$WORK/keys.conf"
( als_read_conf "$WORK/keys.conf"
  printf '%s|%s|%s|%s|%s|%s\n' "$PATH" "$IFS" "${LD_PRELOAD:-}" "${SELF_DIR:-}" "${API_DEFAULT:-}" "$AUDIT_URL" > "$WORK/keys" )
case "$(cat "$WORK/keys")" in
  *nonexistent-evil*|*evil.so*|*"/evil|"*|*evil.example*) bad "only station keys are set" "PATH/IFS/LD_PRELOAD/SELF_DIR/API_DEFAULT untouched" "$(cat "$WORK/keys")" ;;
  *"|https://ok.example") ok "only station keys are set (PATH, IFS, LD_PRELOAD, SELF_DIR, API_DEFAULT ignored)" ;;
  *) bad "AUDIT_URL still read" "https://ok.example" "$(cat "$WORK/keys")" ;;
esac

echo
echo "== ordinary files read as before =="
printf '\xef\xbb\xbf# comment\r\n\r\nAUDIT_URL="https://a.example"\r\n  WIFI_SSID = "Ware house"  \r\nWIFI_PASSWORD=pa$$word\r\nAUDIT_EMAIL='"'"'st@x.example'"'"'\r\nexport AUDIT_ADMIN_PIN="9"\r\nAUDIT_WIPE_METHOD="auto"' > "$WORK/win.conf"
( unset AUDIT_ADMIN_PIN
  als_read_conf "$WORK/win.conf"
  printf '%s|%s|%s|%s|%s|%s\n' "$AUDIT_URL" "$WIFI_SSID" "$WIFI_PASSWORD" "$AUDIT_EMAIL" "${AUDIT_ADMIN_PIN:-unset}" "$AUDIT_WIPE_METHOD" > "$WORK/win" )
check "CRLF, BOM, spaces, quotes, no final newline" \
  'https://a.example|Ware house|pa$$word|st@x.example|unset|auto' "$(cat "$WORK/win")"

( als_read_conf "$DIR/audit.conf.example"
  printf '%s|%s|%s|%s\n' "$AUDIT_URL" "$AUDIT_WIPE_METHOD" "$AUDIT_WIPE_UNFREEZE" "$WIFI_SSID" > "$WORK/ex" )
check "audit.conf.example reads as written" \
  'https://als-inventory-software-production.up.railway.app|auto|0|' "$(cat "$WORK/ex")"

# The same file through the kiosk's own reader gives the same values.
# (A python that actually runs: Windows has a python3 that only opens the Store.)
PY=""
for p in python3 python; do
  command -v "$p" >/dev/null 2>&1 && "$p" -c 'import sys' >/dev/null 2>&1 && { PY=$(command -v "$p"); break; }
done
if [ -n "$PY" ]; then
  printf 'WIFI_SSID="a\"b"\nWIFI_PASSWORD=""quoted"\nAUDIT_URL=https://u.example\nTIME_SERVER="t"\n' > "$WORK/same.conf"
  ( als_read_conf "$WORK/same.conf"; printf '%s|%s|%s|%s' "$WIFI_SSID" "$WIFI_PASSWORD" "$AUDIT_URL" "$TIME_SERVER" > "$WORK/b" )
  "$PY" - "$DIR/gui/server.py" "$WORK/same.conf" > "$WORK/p" 2>"$WORK/perr" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("als_server", sys.argv[1])
srv = importlib.util.module_from_spec(spec); spec.loader.exec_module(srv)
srv.CONF_PATH = sys.argv[2]
c = srv.load_conf()
sys.stdout.write("|".join(c.get(k, "") for k in ("WIFI_SSID", "WIFI_PASSWORD", "AUDIT_URL", "TIME_SERVER")))
PYEOF
  check "engine and kiosk read the same values" "$(cat "$WORK/p")" "$(cat "$WORK/b")"
else
  echo "  SKIP  no python: engine/kiosk agreement not compared"
fi

( als_read_conf "$WORK/does-not-exist" ); check "an unreadable file returns 1" "1" "$?"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
