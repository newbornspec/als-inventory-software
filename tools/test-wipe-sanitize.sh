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
san 4 "$L/never" "$L/ok4";   [ "$RC" -eq 0 ] && ok "SSTAT 0x0101 + SPROG 65535 + action 4 issued 4: success" || bad "SSTAT 0x0101 + SPROG 65535 + action 4 issued 4: success" "rc=$RC polls=$POLLS"
[ "$ISSUED" = "issue sanitize /dev/nvme9 -a 4" ] && ok "the sanitize issued is exactly the action asked for" || bad "the sanitize issued is exactly the action asked for" "$ISSUED"
san 4 "$L/never" "$L/ok4nd"; [ "$RC" -eq 0 ] && ok "status 4 (done, no-deallocate) + action 4: success" || bad "status 4 (done, no-deallocate) + action 4: success" "rc=$RC"
san 4 "$L/never" "$L/ok4big"; [ "$RC" -eq 0 ] && ok "only CDW10 bits 2:0 are the action (0x14 is action 4)" || bad "only CDW10 bits 2:0 are the action (0x14 is action 4)" "rc=$RC"
san 2 "$L/never" "$L/ok2";   [ "$RC" -eq 0 ] && ok "block erase: status done + action 2 issued 2: success" || bad "block erase: status done + action 2 issued 2: success" "rc=$RC"
san 4 "$L/never" "$L/run4" "$L/run4" "$L/ok4"; [ "$RC" -eq 0 ] && [ "$POLLS" -eq 4 ] && ok "in progress, then done: waits, then success" || bad "in progress, then done: waits, then success" "rc=$RC polls=$POLLS"

echo "anything short of all three is NOT success"
san 4 "$L/never" "$L/fail4"; [ "$RC" -ne 0 ] && ok "SSTAT 0x0103 (failed): fails" || bad "SSTAT 0x0103 (failed): fails" "rc=0"
[ "$POLLS" -eq 2 ] && ok "a reported failure fails at once, it does not wait out the deadline" || bad "a reported failure fails at once, it does not wait out the deadline" "polls=$POLLS"
san 4 "$L/stale2"; [ "$RC" -ne 0 ] && ok "a stale success for a DIFFERENT action (block erase) is not success" || bad "a stale success for a DIFFERENT action (block erase) is not success" "rc=0"
san 4 "$L/part4"; [ "$RC" -ne 0 ] && ok "status done but SPROG 32768: not success" || bad "status done but SPROG 32768: not success" "rc=0"
san 4 "$L/never"; [ "$RC" -ne 0 ] && ok "a log that never shows the sanitize: not success" || bad "a log that never shows the sanitize: not success" "rc=0"
san 4 "$L/empty"; [ "$RC" -ne 0 ] && ok "an unreadable log page: not success" || bad "an unreadable log page: not success" "rc=0"
san 4 "$L/stale2" "$L/run4" "$L/ok4"; [ "$RC" -eq 0 ] && ok "stale success, then running, then this action done: success" || bad "stale success, then running, then this action done: success" "rc=$RC polls=$POLLS"

echo "a success left over from an earlier sanitize of the SAME action is not this one"
# The log is read before the command is issued. When that snapshot already
# says "done, 65535, this action", the same page afterwards proves nothing:
# the run has to see its own operation (status 2, or progress below 65535).
san 4 "$L/ok4"; [ "$RC" -ne 0 ] && ok "log unchanged from a stale completed crypto sanitize: not success" || bad "log unchanged from a stale completed crypto sanitize: not success" "rc=0 polls=$POLLS"
[ "$POLLS" -eq 14 ] && ok "the stale case gives up after the 60 s grace (snapshot + 13 reads), not the full deadline" || bad "the stale case gives up after the 60 s grace (snapshot + 13 reads), not the full deadline" "polls=$POLLS"
san 4 "$L/ok4" "$L/run4" "$L/ok4"; [ "$RC" -eq 0 ] && ok "stale same-action snapshot, then running, then done: success" || bad "stale same-action snapshot, then running, then done: success" "rc=$RC polls=$POLLS"
san 4 "$L/ok4" "$L/ok4" "$L/ok4" "$L/ok4" "$L/run4" "$L/ok4"; [ "$RC" -eq 0 ] && ok "firmware updates the page late (stale for 3 reads, then running): success" || bad "firmware updates the page late (stale for 3 reads, then running): success" "rc=$RC polls=$POLLS"
san 4 "$L/ok4" "$L/part4" "$L/ok4"; [ "$RC" -eq 0 ] && ok "progress seen below 65535 counts as this run's operation" || bad "progress seen below 65535 counts as this run's operation" "rc=$RC polls=$POLLS"
san 4 "$L/empty" "$L/ok4"; [ "$RC" -ne 0 ] && ok "snapshot unreadable, then a completed entry never seen running: not success" || bad "snapshot unreadable, then a completed entry never seen running: not success" "rc=0"
san 4 "$L/stale2" "$L/ok4"; [ "$RC" -eq 0 ] && [ "$POLLS" -eq 2 ] && ok "snapshot of a DIFFERENT action, then this action done: success at once" || bad "snapshot of a DIFFERENT action, then this action done: success at once" "rc=$RC polls=$POLLS"
san 2 "$L/ok2"; [ "$RC" -ne 0 ] && ok "the same rule for block erase (action 2)" || bad "the same rule for block erase (action 2)" "rc=0"

echo "the wait is based on the drive's own estimate"
lim() { env -i "$BASH" -c "$FUNCS
nvme_sanitize_limit $1"; }
[ "$(lim 30)" = 300 ]        && ok "estimate 30 s: wait the 300 s floor" || bad "estimate 30 s: wait the 300 s floor" "$(lim 30)"
[ "$(lim 3000)" = 6060 ]     && ok "estimate 3000 s: wait twice that plus a minute" || bad "estimate 3000 s: wait twice that plus a minute" "$(lim 3000)"
[ "$(lim 99999)" = 21600 ]   && ok "a huge estimate is capped at 6 h" || bad "a huge estimate is capped at 6 h" "$(lim 99999)"
[ "$(lim 4294967295)" = 1200 ] && ok "0xFFFFFFFF (no estimate): the old 20 minutes" || bad "0xFFFFFFFF (no estimate): the old 20 minutes" "$(lim 4294967295)"
[ "$(lim '')" = 1200 ]       && ok "no estimate field: the old 20 minutes" || bad "no estimate field: the old 20 minutes" "$(lim '')"
# The stale case above carries a 30 s crypto estimate: 300 s at one read per
# 5 s is 60 waits, then one last read - 61 reads (plus the one snapshot read
# before the command), not the 241 of the old fixed 20 minutes. Proves the
# estimate is what set the deadline.
san 4 "$L/stale2"; [ "$POLLS" -eq 62 ] && ok "the deadline actually used is the estimate's (61 reads for 300 s, plus the snapshot)" || bad "the deadline actually used is the estimate's (61 reads for 300 s, plus the snapshot)" "polls=$POLLS"

# ---------------------------------------------------------------------------
# Plan step 36 (D-2): which controller gets the sanitize, in what order the
# NVMe methods are tried, and whether a format covers every namespace.
#
# firmware_erase used to run `nvme format` on the namespace FIRST, try the
# sanitize only when format failed, send that sanitize to /dev/nvme<N> guessed
# from the namespace's name (nvme0n1 -> nvme0; on a two-drive or multipath
# machine that can be the OTHER drive), and never ask how many namespaces the
# drive has - so a format with FNA bit 1 clear left a second namespace intact.
#
# SAFETY. firmware_erase and als_nvme_ctrl are extracted and run with `nvme`
# a shell FUNCTION that only logs and answers from the test's variables, and
# nvme_sanitize a stub that only logs (its real logic is tested above). The
# /dev/nvme* paths are strings in the log - nothing opens them: PATH holds only
# read-only wrappers. sysfs is a fixture tree under ALS_SYS_ROOT, plain files
# and directories only (no symlink has to work, so Git Bash runs it too).
FE="$(extract "$SRC" als_nvme_ctrl)
$(extract "$SRC" firmware_erase)"
case "$FE" in *'als_nvme_ctrl() {'*'firmware_erase() {'*) ;; *) echo "could not extract firmware_erase - refusing to run"; exit 1 ;; esac
for t in sed head; do
  real=$(command -v "$t") || { echo "missing $t"; exit 1; }
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$real" > "$SAFE/$t"
  chmod +x "$SAFE/$t"
done

R="$T/root"
mkfs() {   # a fresh sysfs fixture
  rm -rf "$R"; mkdir -p "$R/sys/block" "$R/sys/class/nvme"
  local c
  for c in 0 1 2 3; do mkdir -p "$R/sys/class/nvme/nvme$c"; echo "243:$c" > "$R/sys/class/nvme/nvme$c/dev"; done
}
# ns NAME CTRL_DEV NSID: a namespace whose device is the controller with that dev
ns() { mkdir -p "$R/sys/block/$1/device"; echo "$2" > "$R/sys/block/$1/device/dev"; echo "$3" > "$R/sys/block/$1/nsid"; }

# fe NAME WANT <env...> -> RC, OUT, CALLS, MLAB
#   SANICAP / FNA: the id-ctrl answer (unset SANICAP: id-ctrl fails)
#   NSL: the namespace ids list-ns reports, e.g. "1 2"
#   SAN4_RC / SAN2_RC: how each sanitize ends (default 0 = done)
#   FMT_RC: how nvme format ends (default 0)
#   SUBSYS: what `nvme list-subsys -o json` prints
fe() {
  local name="$1" want="$2"; shift 2
  : > "$LOG"
  OUT=$(env -i PATH="$SAFE" LOG="$LOG" ALS_SYS_ROOT="$R" NAME="$name" AUDIT_WIPE_METHOD="$want" "$@" "$BASH" -c "$FE
nvme() {
  echo \"nvme \$*\" >> \"\$LOG\"
  case \"\$1\" in
    id-ctrl) [ -n \"\${SANICAP:-}\" ] || return 1
             printf '{\"vid\":5197,\"sn\":\"S5H2\",\"oacs\":%s,\"sanicap\":%s,\"fna\":%s,\"nn\":%s}\n' \"\${OACS:-15}\" \"\$SANICAP\" \"\${FNA:-0}\" \"\${NN:-32}\" ;;
    list-ns) case \" \$* \" in
               *' --all '*) [ \"\${LSALL_RC:-0}\" = 0 ] || return 1; l=\${NSL-1} ;;
               *) [ \"\${LSACT_RC:-0}\" = 0 ] || return 1; l=\${NSL_ACT-\${NSL-1}} ;;
             esac
             i=0; for n in \$l; do printf '[%4d]:0x%x\n' \"\$i\" \"\$n\"; i=\$((i+1)); done ;;
    list-subsys) printf '%s\n' \"\${SUBSYS:-}\" ;;
    format) return \"\${FMT_RC:-0}\" ;;
    *) echo \"UNEXPECTED nvme \$*\" >> \"\$LOG\"; return 1 ;;
  esac
}
nvme_sanitize() { echo \"sanitize \$1 -a \$2\" >> \"\$LOG\"; case \"\$2\" in 4) return \"\${SAN4_RC:-0}\" ;; 2) return \"\${SAN2_RC:-0}\" ;; esac; return 1; }
FW_LEVEL=unset
firmware_erase \"/dev/\$NAME\" \"\$NAME\"; rc=\$?
echo \"M=\$M\"
echo \"FW_LEVEL=\$FW_LEVEL\"
exit \$rc" 2>&1)
  RC=$?
  CALLS=$(command cat "$LOG")
  MLAB=$(printf '%s\n' "$OUT" | command sed -n 's/^M=//p')
  LEVEL=$(printf '%s\n' "$OUT" | command sed -n 's/^FW_LEVEL=//p')
}
# first LINE-PATTERN: the line number of the first call matching it (999 = none)
first() { printf '%s\n' "$CALLS" | command grep -n -e "$1" | head -n1 | cut -d: -f1 | command grep . || echo 999; }
for t in cut; do
  real=$(command -v "$t") || { echo "missing $t"; exit 1; }
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$real" > "$SAFE/$t"; chmod +x "$SAFE/$t"
done

echo "step 36: the sanitize goes to the namespace's OWN controller"
mkfs; ns nvme0n1 243:1 1
fe nvme0n1 auto SANICAP=3 FNA=0 NSL=1
case "$CALLS" in *"sanitize /dev/nvme1 -a 4"*) ok "nvme0n1 on controller nvme1: the sanitize targets /dev/nvme1" ;; *) bad "nvme0n1 on controller nvme1: the sanitize targets /dev/nvme1" "$CALLS" ;; esac
case "$CALLS" in *"/dev/nvme0 "*|*"/dev/nvme0") bad "  ... and nothing is sent to /dev/nvme0 (the other drive)" "$CALLS" ;; *) ok "  ... and nothing is sent to /dev/nvme0 (the other drive)" ;; esac
case "$CALLS" in *"id-ctrl /dev/nvme1"*"list-ns /dev/nvme1 --all"*) ok "  ... SANICAP/FNA and the namespace list are read from that controller" ;; *) bad "  ... SANICAP/FNA and the namespace list are read from that controller" "$CALLS" ;; esac

mkfs; mkdir -p "$R/sys/block/nvme0c1n1"
fe nvme0c1n1 auto SANICAP=3 NSL=1
case "$CALLS" in *"sanitize /dev/nvme1 -a 4"*) ok "a per-path name nvme0c1n1: controller nvme1" ;; *) bad "a per-path name nvme0c1n1: controller nvme1" "$CALLS" ;; esac

mkfs; mkdir -p "$R/sys/block/nvme0n1/multipath/nvme0c2n1" "$R/sys/block/nvme0n1/device"; echo 1 > "$R/sys/block/nvme0n1/nsid"
fe nvme0n1 auto SANICAP=3 NSL=1
case "$CALLS" in *"sanitize /dev/nvme2 -a 4"*) ok "a native-multipath head with one path (nvme0c2n1): controller nvme2" ;; *) bad "a native-multipath head with one path (nvme0c2n1): controller nvme2" "$CALLS" ;; esac

mkfs; mkdir -p "$R/sys/block/nvme0n1/multipath/nvme0c0n1" "$R/sys/block/nvme0n1/multipath/nvme0c1n1"
fe nvme0n1 auto SANICAP=3 NSL=1
[ "$RC" -ne 0 ] && ok "a multipath head with TWO controllers: ambiguous, no firmware erase" || bad "a multipath head with TWO controllers: ambiguous, no firmware erase" "rc=0 $CALLS"
case "$CALLS" in *sanitize*|*format*|*id-ctrl*) bad "  ... and no command is sent to either controller" "$CALLS" ;; *) ok "  ... and no command is sent to either controller" ;; esac
case "$OUT" in *"more than one NVMe controller (nvme0 nvme1)"*) ok "  ... and it says why, naming both" ;; *) bad "  ... and it says why, naming both" "$OUT" ;; esac

mkfs; mkdir -p "$R/sys/block/nvme0n1/device/nvme3" "$R/sys/block/nvme0n1/device/nvme0n1"; echo 1 > "$R/sys/block/nvme0n1/nsid"
fe nvme0n1 auto SANICAP=3 NSL=1
case "$CALLS" in *"sanitize /dev/nvme3 -a 4"*) ok "device is the subsystem, holding controller nvme3: nvme3" ;; *) bad "device is the subsystem, holding controller nvme3: nvme3" "$CALLS" ;; esac

mkfs
fe nvme0n1 auto SANICAP=3 NSL=1 'SUBSYS={"Subsystems":[{"Name":"nvme-subsys0","Paths":[{"Name":"nvme2","Transport":"pcie","State":"live"}]}]}'
case "$CALLS" in *"list-subsys -o json /dev/nvme0n1"*"sanitize /dev/nvme2 -a 4"*) ok "no sysfs: nvme list-subsys -o json names nvme2" ;; *) bad "no sysfs: nvme list-subsys -o json names nvme2" "$CALLS" ;; esac
fe nvme0n1 auto SANICAP=3 NSL=1 'SUBSYS=[{"Subsystems":[{"Name":"nvme-subsys0","Paths":[{"Name":"nvme0"},{"Name":"nvme1"}]}]}]'
[ "$RC" -ne 0 ] && case "$CALLS" in *sanitize*|*format*) false ;; *) true ;; esac \
  && ok "no sysfs, list-subsys names two controllers: ambiguous, nothing sent" || bad "no sysfs, list-subsys names two controllers: ambiguous, nothing sent" "rc=$RC $CALLS"
fe nvme0n1 auto SANICAP=3 NSL=1
[ "$RC" -ne 0 ] && case "$CALLS" in *sanitize*|*format*) false ;; *) true ;; esac \
  && ok "nothing says which controller: no guess, nothing sent" || bad "nothing says which controller: no guess, nothing sent" "rc=$RC $CALLS"

echo "step 36: sanitize first, as SANICAP allows; format last"
mkfs; ns nvme0n1 243:0 1
fe nvme0n1 auto SANICAP=3 FNA=4 NSL=1
[ "$RC" -eq 0 ] && [ "$(first 'sanitize .* -a 4')" -lt "$(first 'format')" ] \
  && ok "SANICAP 0x3: sanitize -a 4 is issued before any format" || bad "SANICAP 0x3: sanitize -a 4 is issued before any format" "$CALLS"
case "$CALLS" in *format*) bad "  ... and when it works, no format at all" "$CALLS" ;; *) ok "  ... and when it works, no format at all" ;; esac
[ "$MLAB" = "NVMe cryptographic erase (sanitize)" ] && ok "  ... recorded as the sanitize crypto erase" || bad "  ... recorded as the sanitize crypto erase" "$MLAB"
[ "$LEVEL" = purge ] && ok "  ... sanitisation level purge (set by firmware_erase itself)" || bad "  ... sanitisation level purge (set by firmware_erase itself)" "$LEVEL"
fe nvme0n1 auto SANICAP=3 FNA=4 NSL=1 SAN4_RC=1
[ "$(first 'sanitize .* -a 4')" -lt "$(first 'sanitize .* -a 2')" ] && [ "$(first 'sanitize .* -a 2')" -lt 999 ] && [ "$MLAB" = "NVMe block-erase sanitize" ] \
  && ok "crypto sanitize fails: block-erase sanitize next, still before any format" || bad "crypto sanitize fails: block-erase sanitize next, still before any format" "$CALLS / $MLAB"
[ "$LEVEL" = purge ] && ok "  ... block-erase sanitize: purge" || bad "  ... block-erase sanitize: purge" "$LEVEL"
case "$CALLS" in *format*) bad "  ... no format while a sanitize worked" "$CALLS" ;; *) ok "  ... no format while a sanitize worked" ;; esac
fe nvme0n1 auto SANICAP=3 FNA=4 NSL=1 SAN4_RC=1 SAN2_RC=1
[ "$RC" -eq 0 ] && [ "$(first 'sanitize .* -a 2')" -lt "$(first 'format /dev/nvme0n1 -s 2')" ] && [ "$MLAB" = "NVMe cryptographic erase (nvme format -s2)" ] \
  && ok "both sanitizes fail, one namespace: format -s2 last" || bad "both sanitizes fail, one namespace: format -s2 last" "$CALLS / $MLAB"
[ "$LEVEL" = purge ] && ok "  ... format -s2 (crypto): purge" || bad "  ... format -s2 (crypto): purge" "$LEVEL"
fe nvme0n1 auto SANICAP=0 FNA=0 NSL=1
case "$CALLS" in *sanitize*) bad "SANICAP 0: no sanitize is sent" "$CALLS" ;; *) ok "SANICAP 0: no sanitize is sent" ;; esac
[ "$RC" -eq 0 ] && [ "$MLAB" = "NVMe secure erase (nvme format -s1)" ] && case "$CALLS" in *"-s 2"*) false ;; *) true ;; esac \
  && ok "  ... one namespace, FNA without crypto: format -s1 only" || bad "  ... one namespace, FNA without crypto: format -s1 only" "$CALLS / $MLAB"
[ "$LEVEL" = purge ] && ok "  ... format -s1 (user data erase): purge" || bad "  ... format -s1 (user data erase): purge" "$LEVEL"
fe nvme0n1 crypto SANICAP=2 FNA=0 NSL=1
[ "$RC" -ne 0 ] && case "$CALLS" in *"-a 2"*|*"-s 1"*) false ;; *) true ;; esac \
  && ok "crypto asked, only block erase supported: no block erase, no -s1 format passed off as crypto" || bad "crypto asked, only block erase supported: no block erase, no -s1 format passed off as crypto" "$CALLS"
[ "$LEVEL" = unset ] && ok "  ... and a failed firmware erase sets no level" || bad "  ... and a failed firmware erase sets no level" "$LEVEL"
fe nvme0n1 secure SANICAP=3 FNA=4 NSL=1
case "$CALLS" in *"-a 4"*|*"-s 2"*) bad "secure asked: block erase / -s1 only, no crypto" "$CALLS" ;; *) ok "secure asked: block erase / -s1 only, no crypto" ;; esac
fe nvme0n1 auto FNA=0 NSL=1
[ "$(first 'sanitize .* -a 4')" = 3 ] && ok "id-ctrl unreadable: the sanitize is still tried first (an unsupported one just fails)" || bad "id-ctrl unreadable: the sanitize is still tried first" "$CALLS"

echo "step 36: a format must cover every namespace"
mkfs; ns nvme0n1 243:0 1
fe nvme0n1 auto SANICAP=0 FNA=0 NSL="1 2"
[ "$RC" -ne 0 ] && ok "two namespaces, FNA 0, no sanitize: the firmware erase fails" || bad "two namespaces, FNA 0, no sanitize: the firmware erase fails" "rc=0 $MLAB"
case "$CALLS" in *format*) bad "  ... no format that would erase only nvme0n1" "$CALLS" ;; *) ok "  ... no format that would erase only nvme0n1" ;; esac
case "$OUT" in *"other namespace(s) nvme0n2"*) ok "  ... and it names the namespace not covered (nvme0n2)" ;; *) bad "  ... and it names the namespace not covered (nvme0n2)" "$OUT" ;; esac
fe nvme0n1 auto SANICAP=0 FNA=2 NSL="1 2"
[ "$RC" -eq 0 ] && case "$CALLS" in *"format /dev/nvme0n1 -s 1"*) true ;; *) false ;; esac \
  && ok "two namespaces, FNA bit 1 (secure erase covers all): format is used" || bad "two namespaces, FNA bit 1 (secure erase covers all): format is used" "$CALLS"
fe nvme0n1 auto SANICAP=3 FNA=0 NSL="1 2"
[ "$RC" -eq 0 ] && [ "$MLAB" = "NVMe cryptographic erase (sanitize)" ] \
  && ok "two namespaces with a sanitize: the sanitize is used (it erases every namespace - D36)" || bad "two namespaces with a sanitize: the sanitize is used" "$CALLS"
mkfs; ns nvme0n2 243:0 2
fe nvme0n2 auto SANICAP=0 FNA=0 NSL="1 2 3"
case "$OUT" in *"other namespace(s) nvme0n1 nvme0n3"*) ok "wiping nvme0n2 of three: names nvme0n1 and nvme0n3, not itself" ;; *) bad "wiping nvme0n2 of three: names nvme0n1 and nvme0n3, not itself" "$OUT" ;; esac
mkfs; ns nvme0n1 243:0 1
fe nvme0n1 auto SANICAP=0 FNA=0 NSL=""
case "$CALLS" in *format*) bad "the namespace list cannot be read: no format (coverage unknown)" "$CALLS" ;; *) ok "the namespace list cannot be read: no format (coverage unknown)" ;; esac

echo "step 36 review: a drive that cannot list ALLOCATED namespaces"
# `nvme list-ns --all` is Identify CNS 10h, which the spec requires only of
# controllers with Namespace Management - most single-namespace consumer drives
# reject it. The coverage check then saw no namespaces and never used format,
# so a drive with no sanitize support fell from a verified format Purge to an
# hours-long overwrite (Clear). Proof of one namespace is taken from id-ctrl
# NN = 1, or - only without Namespace Management (OACS bit 3 clear) - from the
# mandatory ACTIVE list (CNS 02h).
mkfs; ns nvme0n1 243:0 1
fe nvme0n1 auto SANICAP=0 FNA=0 LSALL_RC=1 NN=1 OACS=0 LSACT_RC=1
[ "$RC" -eq 0 ] && [ "$MLAB" = "NVMe secure erase (nvme format -s1)" ] && [ "$LEVEL" = purge ] \
  && ok "list-ns --all rejected, id-ctrl NN=1, no sanitize: format -s1 (purge)" || bad "list-ns --all rejected, id-ctrl NN=1, no sanitize: format -s1 (purge)" "rc=$RC $MLAB $LEVEL / $CALLS"
fe nvme0n1 auto SANICAP=0 FNA=0 LSALL_RC=1 NN=32 OACS=0 NSL_ACT=1
[ "$RC" -eq 0 ] && case "$CALLS" in *"list-ns /dev/nvme0"$'\n'*"format /dev/nvme0n1 -s 1"*) true ;; *) false ;; esac \
  && ok "list-ns --all rejected, no Namespace Management: the active list (one namespace) allows format" || bad "list-ns --all rejected, no Namespace Management: the active list (one namespace) allows format" "rc=$RC $CALLS"
fe nvme0n1 auto SANICAP=0 FNA=0 LSALL_RC=1 NN=32 OACS=0 NSL_ACT="1 2"
[ "$RC" -ne 0 ] && case "$CALLS" in *format*) false ;; *) true ;; esac && case "$OUT" in *"other namespace(s) nvme0n2"*) true ;; *) false ;; esac \
  && ok "  ... the active list shows two: no format, names nvme0n2" || bad "  ... the active list shows two: no format, names nvme0n2" "rc=$RC $OUT"
fe nvme0n1 auto SANICAP=0 FNA=0 LSALL_RC=1 NN=32 OACS=8 NSL_ACT=1
case "$CALLS" in *format*) bad "  ... WITH Namespace Management the active list is not trusted (a detached namespace is not in it): no format" "$CALLS" ;; *) ok "  ... WITH Namespace Management the active list is not trusted (a detached namespace is not in it): no format" ;; esac
fe nvme0n1 auto SANICAP=0 FNA=0 LSALL_RC=1 NN=32 OACS=0 LSACT_RC=1
case "$CALLS" in *format*) bad "  ... neither list readable and NN > 1: no format" "$CALLS" ;; *) ok "  ... neither list readable and NN > 1: no format" ;; esac
fe nvme0n1 auto SANICAP=0 FNA=0 NN=1 NSL="1 2"
case "$CALLS" in *format*) bad "  ... NN=1 but the allocated list shows two (a lying id-ctrl): the list wins, no format" "$CALLS" ;; *) ok "  ... NN=1 but the allocated list shows two (a lying id-ctrl): the list wins, no format" ;; esac

echo "ATA secure erase: the sanitisation level comes from the erase actually run"
# NIST SP 800-88: the ENHANCED erase is a Purge, the normal one a Clear (it
# writes only the user area). Every other test stubs firmware_erase and injects
# the level, so this runs the real ata_secure_erase with `hdparm` a shell
# FUNCTION that logs and answers -I from $INFO - never a device.
ATA="$(extract "$SRC" ata_secure_erase)"
case "$ATA" in *'ata_secure_erase() {'*) ;; *) echo "could not extract ata_secure_erase - refusing to run"; exit 1 ;; esac
for t in tr; do
  real=$(command -v "$t") || { echo "missing $t"; exit 1; }
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$real" > "$SAFE/$t"; chmod +x "$SAFE/$t"
done
SEC='Security:
	Master password revision code = 65534
		supported
	not	enabled
	not	locked
	not	frozen
	not	expired: security count'
# ase WANT INFO -> RC, OUT, CALLS, LEVEL, MLAB
ase() {
  : > "$LOG"
  OUT=$(env -i PATH="$SAFE" LOG="$LOG" INFO="$2" "$BASH" -c "$ATA
hdparm() {
  echo \"hdparm \$*\" >> \"\$LOG\"
  case \"\$1\" in -I) printf '%s\n' \"\$INFO\" ;; esac
  return 0
}
rtcwake() { echo \"rtcwake \$*\" >> \"\$LOG\"; return 1; }
sleep() { :; }
FW_LEVEL=unset
ata_secure_erase /dev/sdz $1; rc=\$?
echo \"M=\$M\"
echo \"FW_LEVEL=\$FW_LEVEL\"
exit \$rc" 2>&1)
  RC=$?
  CALLS=$(command cat "$LOG")
  MLAB=$(printf '%s\n' "$OUT" | command sed -n 's/^M=//p')
  LEVEL=$(printf '%s\n' "$OUT" | command sed -n 's/^FW_LEVEL=//p')
}
ase auto "$SEC"
[ "$RC" -eq 0 ] && case "$CALLS" in *"--security-erase ALSwipe1"*) true ;; *) false ;; esac && [ "$LEVEL" = clear ] \
  && ok "no enhanced erase: the NORMAL secure erase runs and is recorded as clear" || bad "no enhanced erase: the NORMAL secure erase runs and is recorded as clear" "rc=$RC $LEVEL / $CALLS"
ase auto "$SEC
		supported: enhanced erase"
[ "$RC" -eq 0 ] && case "$CALLS" in *"--security-erase-enhanced ALSwipe1"*) true ;; *) false ;; esac && [ "$LEVEL" = purge ] \
  && ok "enhanced erase supported: the ENHANCED erase runs and is recorded as purge" || bad "enhanced erase supported: the ENHANCED erase runs and is recorded as purge" "rc=$RC $LEVEL / $CALLS"
ase crypto "$SEC
		supported: enhanced erase"
[ "$RC" -eq 0 ] && [ "$LEVEL" = purge ] && ok "crypto asked, enhanced supported: purge" || bad "crypto asked, enhanced supported: purge" "rc=$RC $LEVEL"
ase crypto "$SEC"
[ "$RC" -ne 0 ] && [ "$LEVEL" = unset ] && case "$CALLS" in *security-erase*) false ;; *) true ;; esac \
  && ok "crypto asked, no enhanced erase: nothing run, no level set" || bad "crypto asked, no enhanced erase: nothing run, no level set" "rc=$RC $LEVEL / $CALLS"
ase auto "$(printf '%s\n' "$SEC" | command sed 's/not	frozen/frozen/')"
[ "$RC" -ne 0 ] && [ "$LEVEL" = unset ] && case "$CALLS" in *security-erase*) false ;; *) true ;; esac \
  && ok "a frozen drive: nothing run, no level set" || bad "a frozen drive: nothing run, no level set" "rc=$RC $LEVEL / $CALLS"

echo "the whole engine"
live=$(grep -n 'ctrl="/dev/\${d%%n' "$SRC")
[ -z "$live" ] && ok "the controller is never guessed from the namespace's name" || bad "the controller is never guessed from the namespace's name" "$live"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
