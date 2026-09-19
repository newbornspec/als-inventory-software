#!/usr/bin/env bash
# Tests for how the engine decides an NVMe SANITIZE finished (plan step 32, D-3).
#
# nvme_sanitize used to grep `nvme sanitize-log -H` for the words "completed
# successfully". The sanitize log describes the LAST sanitize the controller
# ran, so a success left over from an earlier one - including a block erase
# when a crypto erase was just issued - matched the words and was taken as the
# erase just requested having finished. It now decodes the binary log page and
# requires status done (1 or 4), progress 65535 AND the recorded action to be
# the one issued.
#
#   bash tools/test-wipe-sanitize.sh
#
# SAFETY. Only nvme_sanitize and its two helpers are extracted and run, and
# `nvme` is a shell FUNCTION here that logs the issue command and hands back a
# log page from a temp file - the real nvme binary is never reachable (PATH
# holds only wrappers for read-only tools), and no device path is ever opened.

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
SAFE="$T/safe"; LOG="$T/calls.log"
mkdir -p "$SAFE"
for t in od cat grep; do
  real=$(command -v "$t") || { echo "missing $t"; exit 1; }
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$real" > "$SAFE/$t"
  chmod +x "$SAFE/$t"
done

SRC="$HERE/hardware-audit.sh"
FUNCS="$(extract "$SRC" nvme_sanitize_log)
$(extract "$SRC" nvme_sanitize_limit)
$(extract "$SRC" nvme_sanitize)"
case "$FUNCS" in *'nvme_sanitize_log() {'*'nvme_sanitize() {'*) ;; *) echo "could not extract nvme_sanitize - refusing to run"; exit 1 ;; esac

# One raw byte, by value. printf's format gets a backslash-octal escape.
byte() { printf "\\$(printf '%03o' "$1")"; }
le16() { byte $(( $1 & 255 )); byte $(( ($1 >> 8) & 255 )); }
le32() { le16 $(( $1 & 65535 )); le16 $(( ($1 >> 16) & 65535 )); }
# mklog FILE SPROG SSTAT CDW10 [EST_CRYPTO_SECONDS] -> a 32-byte sanitize log page
mklog() {
  { le16 "$2"; le16 "$3"; le32 "$4"
    le32 4294967295; le32 4294967295; le32 "${5:-4294967295}"
    le32 0; le32 0; le32 0; } > "$1"
}

# san ACTION LOGFILE... -> RC, POLLS (log reads), ISSUED (the sanitize command)
# Each log read hands back the next file; the last one repeats forever.
san() {
  local act="$1"; shift
  : > "$LOG"
  env -i PATH="$SAFE" LOG="$LOG" LOGS="$*" "$BASH" -c "$FUNCS
nvme() {
  case \"\$1\" in
    sanitize) echo \"issue \$*\" >> \"\$LOG\"; return 0 ;;
    sanitize-log)
      n=\$(grep -c '^read' \"\$LOG\")
      echo read >> \"\$LOG\"
      set -- \$LOGS
      [ \"\$n\" -ge \"\$#\" ] && n=\$(( \$# - 1 ))
      shift \"\$n\"
      cat \"\$1\"
      ;;
    *) echo \"UNEXPECTED nvme \$*\" >> \"\$LOG\"; return 1 ;;
  esac
}
sleep() { :; }
nvme_sanitize /dev/nvme9 $act" >/dev/null 2>&1
  RC=$?
  POLLS=$(command grep -c '^read' "$LOG")
  ISSUED=$(command grep '^issue' "$LOG")
}

L="$T/logs"; mkdir -p "$L"
mklog "$L/ok4"      65535 257 4 30      # 0x0101: done, global-data-erased; crypto
mklog "$L/ok4nd"    65535   4 4 30      # done with no-deallocate; crypto
mklog "$L/fail4"    65535 259 4 30      # 0x0103: FAILED
mklog "$L/stale2"   65535 257 2 30      # done - but a BLOCK erase, not crypto
mklog "$L/run4"      1000   2 4 30      # in progress, crypto
mklog "$L/part4"    32768 257 4 30      # says done, progress only half-way
mklog "$L/never"        0   0 0 30      # never sanitized
mklog "$L/ok2"      65535 257 2         # block erase done, no estimate
mklog "$L/ok4big"   65535 257 20  30    # CDW10 = 0x14: action bits 2:0 = 4, AUSE set
: > "$L/empty"                          # the page could not be read at all

echo "the result is read as numbers, not words"
san 4 "$L/ok4";   [ "$RC" -eq 0 ] && ok "SSTAT 0x0101 + SPROG 65535 + action 4 issued 4: success" || bad "SSTAT 0x0101 + SPROG 65535 + action 4 issued 4: success" "rc=$RC polls=$POLLS"
[ "$ISSUED" = "issue sanitize /dev/nvme9 -a 4" ] && ok "the sanitize issued is exactly the action asked for" || bad "the sanitize issued is exactly the action asked for" "$ISSUED"
san 4 "$L/ok4nd"; [ "$RC" -eq 0 ] && ok "status 4 (done, no-deallocate) + action 4: success" || bad "status 4 (done, no-deallocate) + action 4: success" "rc=$RC"
san 4 "$L/ok4big"; [ "$RC" -eq 0 ] && ok "only CDW10 bits 2:0 are the action (0x14 is action 4)" || bad "only CDW10 bits 2:0 are the action (0x14 is action 4)" "rc=$RC"
san 2 "$L/ok2";   [ "$RC" -eq 0 ] && ok "block erase: status done + action 2 issued 2: success" || bad "block erase: status done + action 2 issued 2: success" "rc=$RC"
san 4 "$L/run4" "$L/run4" "$L/ok4"; [ "$RC" -eq 0 ] && [ "$POLLS" -eq 3 ] && ok "in progress, then done: waits, then success" || bad "in progress, then done: waits, then success" "rc=$RC polls=$POLLS"

echo "anything short of all three is NOT success"
san 4 "$L/fail4"; [ "$RC" -ne 0 ] && ok "SSTAT 0x0103 (failed): fails" || bad "SSTAT 0x0103 (failed): fails" "rc=0"
[ "$POLLS" -eq 1 ] && ok "a reported failure fails at once, it does not wait out the deadline" || bad "a reported failure fails at once, it does not wait out the deadline" "polls=$POLLS"
san 4 "$L/stale2"; [ "$RC" -ne 0 ] && ok "a stale success for a DIFFERENT action (block erase) is not success" || bad "a stale success for a DIFFERENT action (block erase) is not success" "rc=0"
san 4 "$L/part4"; [ "$RC" -ne 0 ] && ok "status done but SPROG 32768: not success" || bad "status done but SPROG 32768: not success" "rc=0"
san 4 "$L/never"; [ "$RC" -ne 0 ] && ok "a log that never shows the sanitize: not success" || bad "a log that never shows the sanitize: not success" "rc=0"
san 4 "$L/empty"; [ "$RC" -ne 0 ] && ok "an unreadable log page: not success" || bad "an unreadable log page: not success" "rc=0"
san 4 "$L/stale2" "$L/run4" "$L/ok4"; [ "$RC" -eq 0 ] && ok "stale success, then running, then this action done: success" || bad "stale success, then running, then this action done: success" "rc=$RC polls=$POLLS"

echo "the wait is based on the drive's own estimate"
lim() { env -i "$BASH" -c "$FUNCS
nvme_sanitize_limit $1"; }
[ "$(lim 30)" = 300 ]        && ok "estimate 30 s: wait the 300 s floor" || bad "estimate 30 s: wait the 300 s floor" "$(lim 30)"
[ "$(lim 3000)" = 6060 ]     && ok "estimate 3000 s: wait twice that plus a minute" || bad "estimate 3000 s: wait twice that plus a minute" "$(lim 3000)"
[ "$(lim 99999)" = 21600 ]   && ok "a huge estimate is capped at 6 h" || bad "a huge estimate is capped at 6 h" "$(lim 99999)"
[ "$(lim 4294967295)" = 1200 ] && ok "0xFFFFFFFF (no estimate): the old 20 minutes" || bad "0xFFFFFFFF (no estimate): the old 20 minutes" "$(lim 4294967295)"
[ "$(lim '')" = 1200 ]       && ok "no estimate field: the old 20 minutes" || bad "no estimate field: the old 20 minutes" "$(lim '')"
# The stale case above carries a 30 s crypto estimate: 300 s at one read per
# 5 s is 60 waits, then one last read - 61 reads, not the 241 of the old fixed
# 20 minutes. Proves the estimate is what set the deadline.
san 4 "$L/stale2"; [ "$POLLS" -eq 61 ] && ok "the deadline actually used is the estimate's (61 reads for 300 s)" || bad "the deadline actually used is the estimate's (61 reads for 300 s)" "polls=$POLLS"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
