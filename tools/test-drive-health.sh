#!/usr/bin/env bash
# The engine's per-drive health READ (contract C5): als_drive_health and the
# storage-entry pieces around it, extracted from hardware-audit.sh and run
# against stub tools. The formula itself is tested in test-drive-health.py;
# this covers what the shell does around it:
#   - one `smartctl -j -x` per drive (no second text scrape), with a time limit;
#   - SMART supported but switched off: `smartctl -s on` ONCE, then read again;
#     and if it will not switch on, the contract's reason, not a number;
#   - a read that hangs is cut off by the limit and says so;
#   - eMMC through `mmc extcsd read`, and the reason when mmc-utils is absent;
#   - no python3 / no smartctl: a reason and "update the stick", never a guess;
#   - the storage entry built with o_* stays valid JSON, carries health, the
#     kernel name, and the old flat fields from the same read;
#   - the capture's storage loop no longer scrapes `smartctl -a`.
#
#   bash tools/test-drive-health.sh        (needs python3, or python on Windows)
#
# SAFETY: nothing here touches a disk. smartctl and mmc are stub scripts that
# print fixtures and refuse to run unless the "device" is one of the fake
# names below; PATH holds only the stubs and wrappers for read-only tools.

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s   (%s)\n' "$1" "$2"; }

PYREAL=""
for c in python3 python; do
  p=$(command -v "$c" 2>/dev/null) || continue
  if "$p" -c 'import sys' >/dev/null 2>&1; then PYREAL="$p"; break; fi
done
[ -n "$PYREAL" ] || { echo "needs python3 (or python)"; exit 1; }

extract() {
  awk -v fn="$2" '
    $0 ~ "^"fn"\\(\\) \\{" { on=1 }
    on { print }
    on && /^}/ { exit }
  ' "$1"
}

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
STUB="$T/stub"; SAFE="$T/safe"; PYD="$T/py"; LOG="$T/calls.log"
mkdir -p "$STUB" "$SAFE" "$PYD" "$T/nopy"
: > "$LOG"
case "$T" in /dev/*) echo "REFUSING: the temp dir is under /dev"; exit 1 ;; esac

SRC="$HERE/hardware-audit.sh"
FUNCS="$(grep -E '^(esc|o_begin|o_s|o_s0|o_n|o_raw|o_end)\(\) \{' "$SRC")
$(extract "$SRC" als_health_py)
$(extract "$SRC" als_health_to)
$(extract "$SRC" als_health_kind)
$(extract "$SRC" als_drive_health)
$(extract "$SRC" als_health_flat)"
case "$FUNCS" in *'als_health_py() {'*PYEOF*'als_drive_health() {'*'als_health_flat() {'*) ;;
  *) echo "could not extract the drive-health functions - refusing to run"; exit 1 ;; esac

# ---- fixtures (smartctl 7.4 -j -x shaped) ---------------------------------
cat > "$T/nvme.json" <<'EOF'
{"json_format_version":[1,0],"smartctl":{"version":[7,4],"svn_revision":"5530","exit_status":0},
 "device":{"name":"/dev/nvme0n1","info_name":"/dev/nvme0n1","type":"nvme","protocol":"NVMe"},
 "smart_support":{"available":true,"enabled":true},
 "smart_status":{"passed":true,"nvme":{"value":0}},
 "nvme_smart_health_information_log":{"critical_warning":0,"temperature":36,"available_spare":100,"available_spare_threshold":10,"percentage_used":6,"power_cycles":812,"power_on_hours":5678,"media_errors":0},
 "temperature":{"current":36},"power_cycle_count":812,"power_on_time":{"hours":5678}}
EOF
cat > "$T/hdd-off.json" <<'EOF'
{"json_format_version":[1,0],"smartctl":{"version":[7,4],"exit_status":0,
 "messages":[{"string":"SMART Disabled. Use option -s with argument 'on' to enable it.","severity":"information"}]},
 "device":{"name":"/dev/sda","type":"sat","protocol":"ATA"},"rotation_rate":5400,
 "smart_support":{"available":true,"enabled":false}}
EOF
cat > "$T/hdd-on.json" <<'EOF'
{"json_format_version":[1,0],"smartctl":{"version":[7,4],"exit_status":0},
 "device":{"name":"/dev/sda","type":"sat","protocol":"ATA"},"rotation_rate":5400,
 "smart_support":{"available":true,"enabled":true},"smart_status":{"passed":true},
 "ata_smart_attributes":{"revision":16,"table":[
  {"id":5,"name":"Reallocated_Sector_Ct","value":200,"worst":200,"thresh":140,"when_failed":"","raw":{"value":2,"string":"2"}},
  {"id":9,"name":"Power_On_Hours","value":78,"worst":78,"thresh":0,"when_failed":"","raw":{"value":16083,"string":"16083h+45m+12.345s"}},
  {"id":197,"name":"Current_Pending_Sector","value":200,"worst":200,"thresh":0,"when_failed":"","raw":{"value":0,"string":"0"}},
  {"id":198,"name":"Offline_Uncorrectable","value":200,"worst":200,"thresh":0,"when_failed":"","raw":{"value":0,"string":"0"}}]},
 "power_on_time":{"hours":16083},"power_cycle_count":2100,"temperature":{"current":34}}
EOF
cat > "$T/emmc.txt" <<'EOF'
eMMC Life Time Estimation A [EXT_CSD_DEVICE_LIFE_TIME_EST_TYP_A]: 0x02
eMMC Life Time Estimation B [EXT_CSD_DEVICE_LIFE_TIME_EST_TYP_B]: 0x01
eMMC Pre EOL information [EXT_CSD_PRE_EOL_INFO]: 0x01
EOF

# ---- stubs ------------------------------------------------------------------
# smartctl: the "device" must be one of the fake names; STUB_SMART picks the
# drive's behaviour. The -s on state is kept in a file, like the drive would.
cat > "$STUB/smartctl" <<EOF
#!/bin/sh
echo "smartctl \$*" >> "$LOG"
last=""; for a in "\$@"; do last="\$a"; done
case "\$last" in /dev/nvme0n1|/dev/sda) ;; *) echo "smartctl REFUSED \$last" >> "$T/refused.log"; exit 99 ;; esac
case "\$(printenv STUB_SMART)" in
  nvme) cat "$T/nvme.json" ;;
  off-enables)
    if [ "\$1" = "-s" ]; then touch "$T/enabled"; exit 0; fi
    if [ -f "$T/enabled" ]; then cat "$T/hdd-on.json"; else cat "$T/hdd-off.json"; fi ;;
  off-stuck)
    if [ "\$1" = "-s" ]; then exit 4; fi
    cat "$T/hdd-off.json" ;;
  hang) sleep 5; cat "$T/nvme.json" ;;
esac
exit 0
EOF
chmod +x "$STUB/smartctl"
cat > "$STUB/mmc" <<EOF
#!/bin/sh
echo "mmc \$*" >> "$LOG"
[ "\$1 \$2 \$3" = "extcsd read /dev/mmcblk0" ] || { echo "mmc REFUSED \$*" >> "$T/refused.log"; exit 99; }
cat "$T/emmc.txt"
EOF
chmod +x "$STUB/mmc"
printf '#!/bin/sh\nexec "%s" "$@"\n' "$PYREAL" > "$PYD/python3"
chmod +x "$PYD/python3"
for t in sed cat timeout sleep touch printenv tr date; do
  real=$(command -v "$t") || { echo "missing $t"; exit 1; }
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$real" > "$SAFE/$t"
  chmod +x "$SAFE/$t"
done

# Run one drive through the extracted functions and print what the storage
# entry would be. $1 = PATH, $2 = name, $3 = kind.
entry() {
  PATH="$1" "$BASH" -c "$FUNCS"'
als_drive_health "$0" "$1"
o_begin; o_s serialNumber "S1"; o_s device "$0"
als_health_flat "$DH_OUT"; o_raw health "$DH_JSON"
printf "%s\n" "$(o_end)"
printf "LINE %s\n" "$DH_LINE"' "$2" "$3"
}
field() { "$PYREAL" -c 'import json,sys
d=json.loads(sys.stdin.readline())
for k in sys.argv[1].split("."):
    d = d.get(k) if isinstance(d, dict) else None
print(json.dumps(d))' "$1"; }

P="$STUB:$PYD:$SAFE"

# 1. NVMe: one read, measured, old fields from the same JSON.
: > "$LOG"
OUT=$(STUB_SMART=nvme entry "$P" nvme0n1 nvme)
E=$(printf '%s\n' "$OUT" | head -n1)
[ "$(printf '%s' "$E" | field health.percent)" = "94" ] && [ "$(printf '%s' "$E" | field health.status)" = '"good"' ] \
  && ok "NVMe: 94% good" || bad "NVMe: 94% good" "$E"
[ "$(printf '%s' "$E" | field healthPct)" = "94" ] && [ "$(printf '%s' "$E" | field powerOnHours)" = "5678" ] \
  && [ "$(printf '%s' "$E" | field smartStatus)" = '"PASSED"' ] && [ "$(printf '%s' "$E" | field ssdLifeUsedPct)" = "6" ] \
  && ok "NVMe: the old flat fields come from the same read" || bad "NVMe: flat fields" "$E"
[ "$(printf '%s' "$E" | field device)" = '"nvme0n1"' ] && ok "the entry carries the kernel name" || bad "device name" "$E"
[ "$(grep -c '^smartctl' "$LOG")" = "1" ] && grep -q '^smartctl -j -x /dev/nvme0n1$' "$LOG" \
  && ok "NVMe: exactly one smartctl read, -j -x" || bad "NVMe: one read" "$(cat "$LOG")"
printf '%s\n' "$OUT" | grep -qx 'LINE 94% Good (life remaining 94% reported by the drive)' \
  && ok "NVMe: the summary line" || bad "NVMe: summary line" "$OUT"

# 2. SMART off, switches on: -s on once, then read again, measured.
: > "$LOG"; rm -f "$T/enabled"
OUT=$(STUB_SMART=off-enables entry "$P" sda ata-hdd)
E=$(printf '%s\n' "$OUT" | head -n1)
[ "$(printf '%s' "$E" | field health.percent)" = "96" ] && [ "$(printf '%s' "$E" | field health.powerOnHours)" = "16083" ] \
  && ok "SMART off then switched on: measured (96%, 16083 h - not 345)" || bad "SMART off then on" "$E"
[ "$(grep -c '^smartctl -s on /dev/sda$' "$LOG")" = "1" ] && [ "$(grep -c '^smartctl -j -x /dev/sda$' "$LOG")" = "2" ] \
  && ok "SMART off: 'smartctl -s on' once, then one more read" || bad "SMART off: calls" "$(cat "$LOG")"

# 3. SMART off and it will not switch on: the reason, no number.
: > "$LOG"
OUT=$(STUB_SMART=off-stuck entry "$P" sda ata-hdd)
E=$(printf '%s\n' "$OUT" | head -n1)
[ "$(printf '%s' "$E" | field health.reason)" = '"SMART is switched off and would not turn on"' ] \
  && [ "$(printf '%s' "$E" | field health.percent)" = "null" ] && [ "$(printf '%s' "$E" | field healthPct)" = "null" ] \
  && ok "SMART stays off: the contract's reason, no percent" || bad "SMART stays off" "$E"
[ "$(grep -c '^smartctl -s on' "$LOG")" = "1" ] && ok "SMART stays off: only one attempt to switch it on" \
  || bad "SMART stays off: one attempt" "$(cat "$LOG")"

# 4. A read that hangs is cut off by the limit.
s0=$(date +%s)
OUT=$(ALS_SMART_TIMEOUT=1 STUB_SMART=hang entry "$P" nvme0n1 nvme)
s1=$(date +%s)
E=$(printf '%s\n' "$OUT" | head -n1)
[ "$(printf '%s' "$E" | field health.reason)" = '"the drive did not answer the health request in 30 s"' ] \
  && ok "hung read: 'did not answer' reason" || bad "hung read: reason" "$E"
[ $((s1 - s0)) -lt 5 ] && ok "hung read: cut off by the limit ($((s1 - s0)) s)" || bad "hung read: limit" "$((s1 - s0)) s"

# 5. eMMC through mmc-utils; mmcblk0boot0 asks the chip itself.
: > "$LOG"
OUT=$(entry "$P" mmcblk0 emmc)
E=$(printf '%s\n' "$OUT" | head -n1)
[ "$(printf '%s' "$E" | field health.percent)" = "80" ] && [ "$(printf '%s' "$E" | field health.tool)" = '"mmc-utils"' ] \
  && ok "eMMC: 80% from the life estimates" || bad "eMMC" "$E"
: > "$LOG"
entry "$P" mmcblk0boot0 emmc >/dev/null
grep -q '^mmc extcsd read /dev/mmcblk0$' "$LOG" && ok "eMMC boot partition: read from the parent chip" \
  || bad "eMMC boot partition" "$(cat "$LOG")"
rm -f "$STUB/mmc.off"; mv "$STUB/mmc" "$STUB/mmc.off"
OUT=$(entry "$P" mmcblk0 emmc)
mv "$STUB/mmc.off" "$STUB/mmc"
E=$(printf '%s\n' "$OUT" | head -n1)
[ "$(printf '%s' "$E" | field health.reason)" = '"this build cannot read eMMC health"' ] \
  && [ "$(printf '%s' "$E" | field health.action)" = '"update the stick"' ] \
  && ok "eMMC without mmc-utils: 'update the stick'" || bad "eMMC without mmc-utils" "$E"

# 6. No smartctl / no python3: said, never guessed.
mkdir -p "$T/nosmart"; cp "$PYD/python3" "$T/nosmart/"
OUT=$(entry "$T/nosmart:$SAFE" sda ata-ssd)
E=$(printf '%s\n' "$OUT" | head -n1)
[ "$(printf '%s' "$E" | field health.reason)" = '"this build cannot read drive health (smartctl is missing)"' ] \
  && ok "no smartctl: reason + 'update the stick'" || bad "no smartctl" "$E"
OUT=$(entry "$STUB:$SAFE" sda ata-ssd)
E=$(printf '%s\n' "$OUT" | head -n1)
[ "$(printf '%s' "$E" | field health)" = '{"measured": false, "reason": "this build cannot compute drive health", "action": "update the stick", "source": "ata-ssd"}' ] \
  && ok "no python3: 'this build cannot compute drive health' - 'update the stick'" || bad "no python3" "$E"

# 7. Nothing any of this printed says unknown.
ALL=$(STUB_SMART=nvme entry "$P" nvme0n1 nvme; STUB_SMART=off-stuck entry "$P" sda ata-hdd; entry "$STUB:$SAFE" sda ata-ssd)
case "$(printf '%s' "$ALL" | tr 'A-Z' 'a-z')" in *unknown*) bad "no 'unknown' anywhere" "$ALL" ;; *) ok "no 'unknown' anywhere" ;; esac

# 8. The capture itself: one line per drive, no text scrape left.
grep -q 'smartctl -a "/dev/$D_NAME"' "$SRC" && bad "the storage loop no longer scrapes smartctl -a" "found" \
  || ok "the storage loop no longer scrapes smartctl -a"
grep -q 'als_drive_health "$D_NAME"' "$SRC" && grep -q 'o_raw health "$DH_JSON"' "$SRC" \
  && grep -q 'p_obj hiddenStorage "$HIDDEN_STORAGE"' "$SRC" \
  && ok "the storage loop reads health per drive, stores storage[].health and hiddenStorage" \
  || bad "storage loop wiring" "missing"
grep -q 'printf "  %-14s %s\\n" "Drive health" "$l"' "$SRC" && ok "the summary prints a Drive health line per drive" \
  || bad "summary per drive" "missing"
[ -s "$T/refused.log" ] && bad "stubs were only ever asked about the fake drives" "$(cat "$T/refused.log")" \
  || ok "stubs were only ever asked about the fake drives"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
