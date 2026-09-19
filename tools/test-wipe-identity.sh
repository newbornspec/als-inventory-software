#!/usr/bin/env bash
# Tests for the WIPE_RESULT line and the drive-identity check (plan step 17,
# contract C1; plan step 41's esc()).
#
# Every exit path of gui_wipe_one must print EXACTLY ONE `WIPE_RESULT {json}`
# line that a real JSON parser accepts, carrying the drive's own identity, the
# UTC start/finish times, the tool version and the method asked for. A result
# the kiosk cannot parse is a drive with no record. And when the kiosk says
# which drive it meant (expected serial) and the device now holds a different
# one, the result is "refused" and NOTHING is written.
#
#   bash tools/test-wipe-identity.sh        (needs python3 or python for json)
#
# SAFETY - the same pattern as test-wipe-ladder.sh:
#   - the "device" is a temporary REGULAR FILE; the harness refuses any /dev
#     target, and gui_wipe_one's `[ ! -b ]` is relaxed to `[ ! -e ]` only in
#     the extracted copy;
#   - every tool that can write to a disk is a TRIPWIRE that only logs, and the
#     erase helpers (firmware_erase, run_overwrite, verify_zero) are stubs that
#     only log; PATH holds nothing but wrappers for read-only tools.

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s   (%s)\n' "$1" "$2"; }

# A python that actually runs (on Windows `python3` can be a Store stub).
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import json' >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "needs python3 or python to parse JSON"; exit 1; }

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
for t in shred dd blkdiscard hdparm nvme rtcwake wipefs sgdisk; do
  printf '#!/bin/sh\necho "%s $*" >> "%s"\nexit 0\n' "$t" "$LOG" > "$TRIP/$t"
  chmod +x "$TRIP/$t"
done
for t in head tr sed grep basename cat date; do
  real=$(command -v "$t") || { echo "missing $t"; exit 1; }
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$real" > "$SAFE/$t"
  chmod +x "$SAFE/$t"
done
for t in findmnt readlink; do
  printf '#!/bin/sh\nexit 0\n' > "$SAFE/$t"; chmod +x "$SAFE/$t"
done

# The checker: reads one JSON document on stdin, checks the C1 shape.
#   args: status=... want=... serial=...|serial=-  (- = no drive object)
cat > "$T/chk.py" <<'PYEOF'
import json, re, sys
raw = sys.stdin.buffer.read().decode("utf-8")
try:
    r = json.loads(raw)
except Exception as e:
    print("does not parse: %s: %r" % (e, raw[:200])); sys.exit(1)
want = dict(a.split("=", 1) for a in sys.argv[2:])
ver = sys.argv[1]
errs = []
iso = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
if r.get("status") != want["status"]: errs.append("status %r" % r.get("status"))
for k in ("device", "method", "reason"):
    if not isinstance(r.get(k), str): errs.append("%s missing" % k)
if r.get("toolVersion") != ver: errs.append("toolVersion %r" % r.get("toolVersion"))
if r.get("methodRequested") != want["want"]: errs.append("methodRequested %r" % r.get("methodRequested"))
for k in ("startedAt", "finishedAt"):
    if not iso.match(r.get(k) or ""): errs.append("%s %r" % (k, r.get(k)))
if (r.get("startedAt") or "") > (r.get("finishedAt") or ""): errs.append("finished before started")
if want["serial"] == "-":
    if "drive" in r: errs.append("drive present though nothing was read: %r" % r["drive"])
else:
    d = r.get("drive") or {}
    if d.get("serialNumber") != want["serial"]: errs.append("drive.serialNumber %r" % d.get("serialNumber"))
    if d.get("model") != "Samsung SSD 980 \"PRO\"": errs.append("drive.model %r" % d.get("model"))
    if d.get("sizeBytes") != 512110190592: errs.append("drive.sizeBytes %r" % d.get("sizeBytes"))
    if d.get("transport") != "nvme": errs.append("drive.transport %r" % d.get("transport"))
    if d.get("rotational") is not False: errs.append("drive.rotational %r" % d.get("rotational"))
    if d.get("wwn") != "eui.0025388b01234567": errs.append("drive.wwn %r" % d.get("wwn"))
if want["status"] == "failed" and not r.get("reason"): errs.append("a failure with no reason")
print("; ".join(errs) if errs else "OK")
sys.exit(1 if errs else 0)
PYEOF

SRC="$HERE/hardware-audit.sh"
VER=$(sed -n 's/^ALS_TOOL_VERSION="\(.*\)"$/\1/p' "$SRC")
[ -n "$VER" ] || { echo "ALS_TOOL_VERSION not found"; exit 1; }
FUNCS="$(grep -E '^(esc|o_begin|o_s|o_s0|o_n|o_raw|o_end|als_utc_now)\(\) \{' "$SRC")
$(grep '^ALS_TOOL_VERSION=' "$SRC")
$(extract "$SRC" als_lsblk_val)
$(extract "$SRC" als_drive_identity)
$(extract "$SRC" wipe_result)
$(extract "$SRC" clear_label)
$(extract "$SRC" als_disk_is_usb)
$(extract "$SRC" als_boot_disk)
$(extract "$SRC" gui_wipe_one | sed 's/\[ ! -b "\$dev" \]/[ ! -e "$dev" ]/')"
case "$FUNCS" in *'[ ! -e "$dev" ]'*) ;; *) echo "could not relax the -b check - refusing to run"; exit 1 ;; esac

# The model carries a quote on purpose - lsblk -P escapes it as \x22, and
# that must survive into valid JSON. STUB_ID=none: the drive reports nothing.
STUBS='
firmware_erase() { echo "firmware_erase $*" >> "$LOG"; if [ "${STUB_FW:-fail}" = "ok" ]; then M="NVMe cryptographic erase (sanitize)"; return 0; fi; return 1; }
run_overwrite()  { echo "run_overwrite $*" >> "$LOG"; OVR_ERR="${STUB_OVR_ERR:-}"; return "${STUB_OVR_RC:-0}"; }
verify_zero()    { echo "verify_zero $*" >> "$LOG"; return "${STUB_VERIFY_RC:-0}"; }
blockdev()       { echo 512110190592; }
cat() { case "$*" in */queue/rotational) echo 0 ;; */removable) echo "${STUB_RM:-0}" ;; *) command cat "$@" ;; esac; }
lsblk() {
  case "$*" in
    *SERIAL,MODEL*)
      [ "${STUB_ID:-}" = none ] && return 0
      printf "%s\n" "SERIAL=\"${STUB_SERIAL:-S5H2NS0N123456}  \" MODEL=\"Samsung SSD 980 \\x22PRO\\x22\" SIZE=\"512110190592\" TRAN=\"nvme\" ROTA=\"0\" WWN=\"eui.0025388b01234567\"" ;;
    *TRAN*) echo "${STUB_TRAN:-nvme}" ;;
  esac
  return 0
}
als_boot_disk() { printf "%s" "${STUB_BOOT:-}"; }
'

# run DEV WANT EXPECT <env...> -> OUT, LINES (count of WIPE_RESULT lines), RESULT, CALLS, RC
run() {
  local dev="$1" want="$2" expect="$3"; shift 3
  case "$dev" in /dev/*) echo "REFUSING: a /dev target in the harness"; exit 1 ;; esac
  : > "$LOG"
  OUT=$(cd "$T" && env -i PATH="$TRIP:$SAFE" LOG="$LOG" D="$dev" W="$want" E="$expect" "$@" "$BASH" -c "$FUNCS
$STUBS
gui_wipe_one \"\$D\" \"\$W\" \"\$E\"" 2>&1)
  RC=$?
  LINES=$(printf '%s\n' "$OUT" | grep -c '^WIPE_RESULT ')
  RESULT=$(printf '%s\n' "$OUT" | sed -n 's/^WIPE_RESULT //p' | tail -n1)
  CALLS=$(command cat "$LOG")
}
# check NAME STATUS WANT SERIAL
check() {
  local r
  [ "$LINES" = 1 ] || { bad "$1: exactly one WIPE_RESULT line" "$LINES lines: $(printf '%s' "$OUT" | tail -n2 | tr '\n' ' ')"; return; }
  r=$(printf '%s' "$RESULT" | PYTHONIOENCODING=utf-8 "$PY" "$T/chk.py" "$VER" status="$2" want="$3" serial="$4" 2>&1)
  [ "$r" = OK ] && ok "$1" || bad "$1" "$r"
}
nowrite() {
  case "$CALLS" in
    '') ok "$1: nothing was written (no erase helper, no disk tool)" ;;
    *) bad "$1: nothing was written (no erase helper, no disk tool)" "$(printf '%s' "$CALLS" | tr '\n' ' ')" ;;
  esac
}

DEV="$T/fake-drive"; : > "$DEV"
: > "$T/loop7"
SER=S5H2NS0N123456

echo "every exit path: one WIPE_RESULT, valid JSON, with identity and times"
run "" auto ""
check "no device given: refused" refused auto -;                nowrite "no device given"
run "$T/not-there" auto ""
check "not a block device: refused" refused auto -;             nowrite "not a block device"
run "$DEV" auto "" STUB_RM=1
check "removable: refused, identity recorded" refused auto "$SER"; nowrite "removable"
run "$DEV" auto "" STUB_TRAN=usb
check "USB-attached: refused" refused auto "$SER";              nowrite "USB-attached"
run "$DEV" auto "" STUB_BOOT="$DEV"
check "the boot disk: refused" refused auto "$SER";             nowrite "the boot disk"
run loop7 auto ""
check "a loop pseudo-device: refused" refused auto "$SER";      nowrite "a loop pseudo-device"
run "$DEV" auto "" STUB_FW=ok
check "firmware erase + read-back: wiped" wiped auto "$SER"
run "$DEV" overwrite "" STUB_FW=fail
check "overwrite + read-back: wiped" wiped overwrite "$SER"
run "$DEV" zero "" STUB_FW=fail
check "single zero pass: wiped, methodRequested zero" wiped zero "$SER"
run "$DEV" auto "" STUB_FW=ok STUB_VERIFY_RC=1
check "firmware erase, not zeros: controller-confirmed wiped" wiped auto "$SER"
run "$DEV" auto "" STUB_FW=fail STUB_OVR_RC=1 'STUB_OVR_ERR=shred: /dev/x: error writing at offset 4096: Input/output "error"	tab'
check "overwrite fails (quote and tab in the error): failed, still valid JSON" failed auto "$SER"
run "$DEV" auto "" STUB_FW=fail STUB_VERIFY_RC=1
check "overwrite does not read back clean: failed" failed auto "$SER"
[ "$RC" -ne 0 ] && ok "a failed wipe exits non-zero" || bad "a failed wipe exits non-zero" "rc=$RC"
run "$DEV" crypto "" STUB_FW=ok STUB_ID=none
check "a drive that reports no identity: wiped, no drive object (D18)" wiped crypto -

echo "the drive must still be the one the operator chose"
run "$DEV" auto "WRONG-SERIAL-999" STUB_FW=ok
check "wrong serial: refused" refused auto "$SER";              nowrite "wrong serial"
case "$RESULT" in *WRONG-SERIAL-999*"$SER"*|*"$SER"*WRONG-SERIAL-999*) ok "wrong serial: the reason names both serials" ;; *) bad "wrong serial: the reason names both serials" "$RESULT" ;; esac
[ "$RC" -ne 0 ] && ok "wrong serial: exits non-zero" || bad "wrong serial: exits non-zero" "rc=$RC"
run "$DEV" auto "WRONG" STUB_FW=ok STUB_ID=none
check "a serial expected, the drive reports none: refused" refused auto -; nowrite "expected a serial, drive reports none"
run "$DEV" auto "$SER" STUB_FW=ok
check "matching serial: wiped" wiped auto "$SER"
case "$CALLS" in *firmware_erase*) ok "matching serial: the erase actually ran" ;; *) bad "matching serial: the erase actually ran" "$CALLS" ;; esac
run "$DEV" auto "  $SER " STUB_FW=ok
check "matching serial with stray whitespace (lsblk pads some): wiped" wiped auto "$SER"
run "$DEV" auto "" STUB_FW=ok
case "$CALLS" in *firmware_erase*) ok "no expected serial (older kiosk): no check, the wipe runs" ;; *) bad "no expected serial (older kiosk): no check, the wipe runs" "$CALLS" ;; esac

echo "the whole engine"
live=$(grep -n 'WIPE_RESULT {' "$SRC" | grep -v '^[0-9]*:[[:space:]]*#')
[ -z "$live" ] && ok "no WIPE_RESULT line is concatenated by hand" || bad "no WIPE_RESULT line is concatenated by hand" "$live"
case "$(grep -n 'gui_wipe_one "\${2:-}" "\${3:-}" "\${4:-}"' "$SRC")" in '') bad "--wipe-drive passes the expected serial through" "dispatch unchanged" ;; *) ok "--wipe-drive passes the expected serial through" ;; esac
d_line=$(grep -n '^if \[ "\${1:-}" = "--wipe-drive" \]' "$SRC" | cut -d: -f1)
for f in als_drive_identity als_lsblk_val wipe_result als_utc_now; do
  f_line=$(grep -n "^$f() {" "$SRC" | cut -d: -f1)
  [ -n "$f_line" ] && [ -n "$d_line" ] && [ "$f_line" -lt "$d_line" ] \
    && ok "$f is defined above the --wipe-drive dispatch" \
    || bad "$f is defined above the --wipe-drive dispatch" "def line ${f_line:-none}, dispatch line ${d_line:-none}"
done

echo "esc(): no control character can break the JSON (plan step 41)"
ESC="$(grep '^esc() {' "$SRC")"
for code in 1 7 8 11 12 27 31 127; do
  s=$(printf "a\\$(printf '%03o' "$code")b\"c\\\\d")
  j=$(env -i PATH="$SAFE" "$BASH" -c "$ESC
printf '{\"v\":\"%s\"}' \"\$(esc \"\$1\")\"" _ "$s")
  r=$(printf '%s' "$j" | "$PY" -c 'import json,sys; v=json.loads(sys.stdin.read())["v"]; print("OK" if v == "ab\"c\\d" else repr(v))' 2>&1)
  [ "$r" = OK ] && ok "control byte $code is stripped, quote and backslash kept" || bad "control byte $code is stripped, quote and backslash kept" "$r"
done
r=$(env -i PATH="$SAFE" "$BASH" -c "$ESC
esc 'Samsung SSD 980 — Größe'" | "$PY" -c 'import sys; b=sys.stdin.buffer.read(); print("OK" if b.decode("utf-8")=="Samsung SSD 980 — Größe" else repr(b))' 2>&1)
[ "$r" = OK ] && ok "UTF-8 text passes through untouched" || bad "UTF-8 text passes through untouched" "$r"
# End to end: lsblk reports a control byte in the model as \x01; it must not
# reach the WIPE_RESULT line raw.
STUBS_CTL=$(printf '%s' "$STUBS" | sed 's/980 \\\\x22PRO\\\\x22/980 \\\\x01\\\\x22PRO\\\\x22\\\\x1b/')
case "$STUBS_CTL" in *x01*x1b*) ;; *) echo "could not plant the control bytes"; exit 1 ;; esac
STUBS_SAVE="$STUBS"; STUBS="$STUBS_CTL"
run "$DEV" auto "" STUB_FW=ok
STUBS="$STUBS_SAVE"
check "a model with control bytes (lsblk \\x01, \\x1b): WIPE_RESULT still parses, bytes dropped" wiped auto "$SER"


echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
