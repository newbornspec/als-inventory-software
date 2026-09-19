#!/usr/bin/env bash
# Tests for the guards on suspend-to-unfreeze (plan step 42, D-2):
# als_suspend_ok, als_wipe_lock / als_wipe_unlock, and the frozen branch of
# ata_secure_erase. Owner decision D42: the guards exist, the feature stays
# OFF (AUDIT_WIPE_UNFREEZE defaults to 0).
#
# Why this exists. With AUDIT_WIPE_UNFREEZE=1, a frozen SATA drive made the
# engine suspend the WHOLE machine with rtcwake - while the kiosk may be
# running other wipes at the same time (it starts them concurrently), on a
# machine that may only offer s2idle (which cannot unfreeze anything), or one
# whose resume is known to fail. Now a suspend needs: no other wipe running,
# "deep" in /sys/power/mem_sleep, a model not on the no-resume list, and no
# temporarily removed HPA on the drive.
#
#   bash tools/test-wipe-unfreeze.sh
#
# SAFETY: rtcwake is a TRIPWIRE that only logs (nothing is ever suspended);
# hdparm is a stub that only logs and answers -I from a state file (its
# --security-* calls change nothing); /sys is a temp directory (ALS_SYS_ROOT);
# the wipe registry is a temp directory (ALS_WIPE_RUN_DIR). No device path is
# ever opened: the "device" is a temp regular file and the stubs refuse /dev.

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
TRIP="$T/trip"; SAFE="$T/safe"; LOG="$T/calls.log"; FROZEN="$T/frozen"; RUN="$T/run/als-wipe"; SYS="$T/root/sys"
mkdir -p "$TRIP" "$SAFE" "$T/run" "$SYS/power" "$SYS/class/dmi/id"
case "$T" in /dev/*) echo "REFUSING: the temp dir is under /dev"; exit 1 ;; esac

# rtcwake: log, and "unfreeze" the drive (what a real suspend/resume does).
printf '#!/bin/sh\necho "rtcwake $*" >> "%s"\nrm -f "%s"\nexit 0\n' "$LOG" "$FROZEN" > "$TRIP/rtcwake"
chmod +x "$TRIP/rtcwake"
for t in shred dd blkdiscard nvme wipefs sgdisk; do
  printf '#!/bin/sh\necho "%s $*" >> "%s"\nexit 0\n' "$t" "$LOG" > "$TRIP/$t"
  chmod +x "$TRIP/$t"
done
cat > "$TRIP/hdparm" <<EOF
#!/bin/sh
echo "hdparm \$*" >> "$LOG"
for a in "\$@"; do case "\$a" in /dev/*|--dco-restore|--dco-setmax|--dco-freeze) echo "hdparm REFUSED \$*" >> "$T/refused.log"; exit 99 ;; esac; done
# --dco-identify is read-only (the hidden-area check of step 34 asks it):
# answer nothing, so the check says "unknown" and the wipe goes on.
[ "\$1" = --dco-identify ] && exit 1
if [ "\$1" = -I ]; then
  echo "Security: "
  echo "		supported"
  echo "	not	enabled"
  echo "	not	locked"
  if [ -e "$FROZEN" ]; then echo "		frozen"; else echo "	not	frozen"; fi
  echo "		supported: enhanced erase"
fi
exit 0
EOF
chmod +x "$TRIP/hdparm"
for t in head tr sed grep cat printenv mkdir rmdir ls rm; do
  real=$(command -v "$t") || { echo "missing $t"; exit 1; }
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$real" > "$SAFE/$t"
  chmod +x "$SAFE/$t"
done

SRC="$HERE/hardware-audit.sh"
FUNCS="$(grep '^ALS_NO_RESUME_MODELS=' "$SRC")
$(extract "$SRC" fw_why)
$(extract "$SRC" fw_tried)
$(extract "$SRC" als_wipe_lock)
$(extract "$SRC" als_wipe_unlock)
$(extract "$SRC" als_suspend_ok)
$(extract "$SRC" ata_secure_erase)"
case "$FUNCS" in *'ALS_NO_RESUME_MODELS='*'als_wipe_lock() {'*'als_suspend_ok() {'*'ata_secure_erase() {'*) ;;
  *) echo "could not extract the suspend guards - refusing to run"; exit 1 ;; esac

DEV="$T/sdz"; : > "$DEV"

# A dead PID: a process that has exited (checked, not assumed).
true & DEAD=$!; wait "$DEAD" 2>/dev/null
kill -0 "$DEAD" 2>/dev/null && { echo "could not get a dead PID"; exit 1; }
# A live PID that is not the engine's: a sleeper, killed at the end.
sleep 300 & LIVE=$!
trap 'kill "$LIVE" 2>/dev/null; rm -rf "$T"' EXIT

# setup: MEM (mem_sleep contents, "-" = no file), MODEL ("-" = no file)
setup() {
  rm -rf "$T/run/als-wipe"; rm -f "$SYS/power/mem_sleep" "$SYS/class/dmi/id/product_name"
  [ "$1" = - ] || printf '%s\n' "$1" > "$SYS/power/mem_sleep"
  [ "$2" = - ] || printf '%s\n' "$2" > "$SYS/class/dmi/id/product_name"
}
# se <env...> -> RC, OUT, CALLS: the lock taken, then ata_secure_erase on a
# frozen drive (PRE: shell code run after the lock, e.g. to add other wipes).
se() {
  : > "$LOG"; : > "$FROZEN"
  OUT=$(env -i PATH="$TRIP:$SAFE" LOG="$LOG" ALS_SYS_ROOT="$T/root" ALS_WIPE_RUN_DIR="$RUN" DEV="$DEV" \
        AUDIT_WIPE_UNFREEZE=1 "$@" "$BASH" -c "$FUNCS
sleep() { :; }
als_wipe_lock
\${PRE:-:}
ata_secure_erase \"\$DEV\" auto; rc=\$?
echo \"rc=\$rc why=\$FW_WHY\"" 2>&1)
  CALLS=$(command cat "$LOG")
}
suspended() { case "$CALLS" in *rtcwake*) return 0 ;; esac; return 1; }

echo "all guards pass: the suspend happens, the drive unfreezes, the erase runs"
setup "s2idle [deep]" "Latitude 5490"
se
suspended && ok "rtcwake -m mem was called" || bad "rtcwake -m mem was called" "$OUT"
case "$CALLS" in *"rtcwake -m mem -s 6"*) ok "  ... for ~6 seconds" ;; *) bad "  ... for ~6 seconds" "$CALLS" ;; esac
case "$OUT" in *"rc=0"*) ok "  ... and the ATA secure erase then ran" ;; *) bad "  ... and the ATA secure erase then ran" "$OUT" ;; esac
case "$CALLS" in *security-erase-enhanced*) ok "  ... (enhanced)" ;; *) bad "  ... (enhanced)" "$CALLS" ;; esac

echo "a second wipe running blocks the suspend"
setup "s2idle [deep]" "Latitude 5490"
se PRE="mkdir -p $RUN/$LIVE"
suspended && bad "another wipe's live PID in the registry: no suspend" "$CALLS" || ok "another wipe's live PID in the registry: no suspend"
case "$OUT" in *"another wipe is running on this machine (process $LIVE)"*) ok "  ... and the operator is told why" ;; *) bad "  ... and the operator is told why" "$OUT" ;; esac
case "$OUT" in *"rc=1 why=frozen"*) ok "  ... the drive stays frozen: FW_WHY frozen, falls back" ;; *) bad "  ... FW_WHY frozen" "$OUT" ;; esac
case "$CALLS" in *security-*) bad "  ... no security command was sent" "$CALLS" ;; *) ok "  ... no security command was sent" ;; esac
setup "s2idle [deep]" "Latitude 5490"
se PRE="mkdir -p $RUN/$DEAD"
suspended && ok "a DEAD PID left in the registry (a killed engine) does not block" || bad "a DEAD PID does not block" "$OUT"
[ ! -e "$RUN/$DEAD" ] && ok "  ... and the stale entry is cleared" || bad "  ... and the stale entry is cleared" "$(ls "$RUN")"
setup "s2idle [deep]" "Latitude 5490"
se PRE="mkdir -p $RUN/not-a-pid"
suspended && bad "an unexpected entry in the registry: no suspend (fail closed)" "$CALLS" || ok "an unexpected entry in the registry: no suspend (fail closed)"
setup "s2idle [deep]" "Latitude 5490"
se ALS_WIPE_RUN_DIR="$T/nowhere/als-wipe"
suspended && bad "this wipe could not register (no parent dir): no suspend" "$CALLS" || ok "this wipe could not register (no parent dir): no suspend"
case "$OUT" in *"could not register"*) ok "  ... said so" ;; *) bad "  ... said so" "$OUT" ;; esac

echo "no 'deep' in /sys/power/mem_sleep blocks the suspend"
setup "[s2idle]" "Latitude 5490"
se
suspended && bad "mem_sleep '[s2idle]' only: no suspend" "$CALLS" || ok "mem_sleep '[s2idle]' only: no suspend"
case "$OUT" in *"does not offer deep suspend"*) ok "  ... said so" ;; *) bad "  ... said so" "$OUT" ;; esac
setup - "Latitude 5490"
se
suspended && bad "no mem_sleep file at all: no suspend" "$CALLS" || ok "no mem_sleep file at all: no suspend"
setup "[s2idle] deep" "Latitude 5490"
se
suspended && ok "deep offered but not selected: suspend allowed..." || bad "deep offered but not selected: suspend allowed" "$OUT"
grep -qx deep "$SYS/power/mem_sleep" && ok "  ... after selecting deep (s2idle would leave the drive frozen)" || bad "  ... after selecting deep" "$(command cat "$SYS/power/mem_sleep")"

echo "machines where resume is known to fail"
setup "s2idle [deep]" "HP EliteBook 840 G3"
se AUDIT_WIPE_NO_SUSPEND_MODELS="ThinkPad T440|hp elitebook 840 g3"
suspended && bad "model on the audit.conf list (case-insensitive): no suspend" "$CALLS" || ok "model on the audit.conf list (case-insensitive): no suspend"
case "$OUT" in *"resume is known to fail on this model (HP EliteBook 840 G3)"*) ok "  ... said so, naming the model" ;; *) bad "  ... said so" "$OUT" ;; esac
setup "s2idle [deep]" "HP EliteBook 840 G4"
se AUDIT_WIPE_NO_SUSPEND_MODELS="hp elitebook 840 g3"
suspended && ok "a different model is not matched by a near name" || bad "a different model is not matched" "$OUT"
setup "s2idle [deep]" "Latitude 5490"
FUNCS_LISTED=$(printf '%s' "$FUNCS" | sed 's/^ALS_NO_RESUME_MODELS=.*/ALS_NO_RESUME_MODELS="Latitude 5490"/')
: > "$LOG"; : > "$FROZEN"
env -i PATH="$TRIP:$SAFE" LOG="$LOG" ALS_SYS_ROOT="$T/root" ALS_WIPE_RUN_DIR="$RUN" DEV="$DEV" AUDIT_WIPE_UNFREEZE=1 "$BASH" -c "$FUNCS_LISTED
sleep() { :; }
als_wipe_lock; ata_secure_erase \"\$DEV\" auto" >/dev/null 2>&1
CALLS=$(command cat "$LOG")
suspended && bad "model on the built-in list: no suspend" "$CALLS" || ok "model on the built-in list: no suspend"
setup "s2idle [deep]" -
se
suspended && bad "model unreadable: no suspend (cannot be checked)" "$CALLS" || ok "model unreadable: no suspend (cannot be checked)"

echo "a temporarily removed HPA (step 34) blocks the suspend"
setup "s2idle [deep]" "Latitude 5490"
se WR_HPA_REMOVED=1
suspended && bad "HPA removed on this drive: no suspend (a reset would restore it)" "$CALLS" || ok "HPA removed on this drive: no suspend (a reset would restore it)"

echo "the default stays OFF (owner decision D42)"
setup "s2idle [deep]" "Latitude 5490"
se AUDIT_WIPE_UNFREEZE=
suspended && bad "AUDIT_WIPE_UNFREEZE unset: never suspends, even with every guard passing" "$CALLS" || ok "AUDIT_WIPE_UNFREEZE unset: never suspends, even with every guard passing"
grep -q '"${AUDIT_WIPE_UNFREEZE:-0}" = "1"' "$SRC" && ok "hardware-audit.sh: the default is 0" || bad "hardware-audit.sh: the default is 0" "$(grep -n UNFREEZE "$SRC")"
tr -d '\r' < "$HERE/audit.conf.example" | grep -qx 'AUDIT_WIPE_UNFREEZE="0"' && ok "audit.conf.example: AUDIT_WIPE_UNFREEZE=\"0\"" || bad "audit.conf.example keeps 0" "$(grep -n UNFREEZE "$HERE/audit.conf.example")"
grep -q '^ALS_NO_RESUME_MODELS=' "$SRC" && ok "the no-resume model list exists in the engine" || bad "the no-resume model list exists" ""
rt=$(grep -n 'rtcwake -m' "$SRC" | grep -v '^[0-9]*:[[:space:]]*#')
[ "$(printf '%s\n' "$rt" | grep -c .)" = 1 ] && ok "exactly one rtcwake call in the engine (the guarded one)" || bad "exactly one rtcwake call" "$rt"

echo "gui_wipe_one registers itself while it runs, and deregisters"
: > "$LOG"
GF="$(grep -E '^(esc|o_begin|o_s|o_s0|o_n|o_raw|o_end|als_utc_now)\(\) \{' "$SRC")
$(grep '^ALS_TOOL_VERSION=' "$SRC")"
for f in als_json_array wr_limit als_lsblk_val als_lsblk_unescape als_drive_identity wipe_result clear_label \
         als_disk_is_usb als_boot_disk ata_hidden_areas ata_hpa_remove ata_kernel_whole smart_counts wipe_assess als_wipe_lock als_wipe_unlock; do
  GF="$GF
$(extract "$SRC" "$f")"
done
GF="$GF
$(extract "$SRC" gui_wipe_one | sed 's/\[ ! -b "\$dev" \]/[ ! -e "$dev" ]/')"
case "$GF" in *'[ ! -e "$dev" ]'*) ;; *) echo "could not relax the -b check - refusing to run"; exit 1 ;; esac
for t in basename wc date cmp cut awk; do
  real=$(command -v "$t") || { echo "missing $t"; exit 1; }
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$real" > "$SAFE/$t"; chmod +x "$SAFE/$t"
done
for t in lsblk findmnt readlink; do printf '#!/bin/sh\nexit 0\n' > "$SAFE/$t"; chmod +x "$SAFE/$t"; done
rm -rf "$RUN"
GOUT=$(env -i PATH="$TRIP:$SAFE" LOG="$LOG" ALS_WIPE_RUN_DIR="$RUN" ALS_SYS_ROOT="$T/root" DEV="$DEV" RUN="$RUN" "$BASH" -c "$GF
firmware_erase() { echo \"during: \$(ls \"\$RUN\" 2>/dev/null | tr '\n' ' ') self=\$\$\" >> \"\$LOG\"; return 1; }
run_overwrite() { return 0; }
verify_erased() { VE_LABEL=zeros; VE_MIB=1; return 0; }
als_part_starts() { :; }
blockdev() { echo 1048576; }
cat() { case \"\$*\" in */queue/rotational) echo 1 ;; */removable) echo 0 ;; *) command cat \"\$@\" ;; esac; }
gui_wipe_one \"\$DEV\" auto" 2>&1)
during=$(grep '^during:' "$LOG")
self=${during##*self=}
case "$during" in "during: $self "*) ok "while it runs, the registry holds its own PID ($self)" ;; *) bad "while it runs, the registry holds its PID" "$during / $GOUT" ;; esac
[ -d "$RUN" ] && [ -z "$(ls "$RUN")" ] && ok "  ... and it is removed when the engine exits" || bad "  ... removed when the engine exits" "$(ls "$RUN" 2>&1)"
case "$GOUT" in *'WIPE_RESULT {"status":"wiped"'*) ok "  ... the wipe itself is unaffected" ;; *) bad "  ... the wipe itself is unaffected" "$GOUT" ;; esac

kill "$LIVE" 2>/dev/null; wait "$LIVE" 2>/dev/null
[ ! -s "$T/refused.log" ] && ok "no stub ever saw a /dev path or a DCO command" || bad "no stub saw a /dev path" "$(command cat "$T/refused.log")"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
