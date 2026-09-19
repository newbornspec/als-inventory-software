#!/usr/bin/env bash
# Tests for the read-back after an erase (plan step 31, D-3): verify_erased,
# its python3 checker (als_verify_py), the pre-erase partition starts
# (als_part_starts) - and what gui_wipe_one does with each verdict.
#
# Why this exists. A firmware erase used to be "verified" by asking whether the
# drive read back as zeros, and when it did not, it was recorded anyway as
# "controller-confirmed" - the drive's own word. A controller that answered
# "done" and changed nothing got exactly the same certificate as a real crypto
# erase, while the customer's partition table and NTFS volume were still there.
# And the old zeros check passed a read that FAILED (nothing came back, so no
# non-zero bytes were counted): an unreadable drive "verified".
#
# These tests use REAL BYTES: each "drive" is a temp file holding a real
# protective MBR, a real GPT header and entry, a real NTFS / BitLocker / FAT /
# LUKS / ext boot area, or the fill a real erase leaves (random, 0xFF, zeros, a
# vendor pattern). The checker that reads them is extracted from
# hardware-audit.sh, not copied.
#
#   bash tools/test-wipe-verify.sh        (needs python3, or python on Windows)
#
# SAFETY - the pattern of test-wipe-ladder.sh:
#   - every "device" is a temporary REGULAR FILE; the harness refuses any /dev
#     target, and gui_wipe_one's `[ ! -b ]` is relaxed to `[ ! -e ]` only in the
#     extracted copy;
#   - `dd` is a wrapper that REFUSES any if=/of= under /dev, refuses any of= at
#     all (a read-back never writes), logs every call, and only then runs the
#     real dd on the temp file (dropping iflag=direct, which tmpfs and Windows
#     cannot do - the log proves the engine asked for it);
#   - every other tool that can write to a disk (shred, blkdiscard, hdparm,
#     nvme, rtcwake, wipefs, sgdisk) is a TRIPWIRE that only logs;
#   - the erase itself (firmware_erase, run_overwrite) is a stub that changes
#     the temp file the way a real erase - or a lying controller - would;
#   - PATH holds nothing else but wrappers for read-only tools.

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s   (%s)\n' "$1" "$2"; }

# A python that actually runs (on Windows `python3` can be a Store stub).
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
TRIP="$T/trip"; SAFE="$T/safe"; PYD="$T/py"; LOG="$T/calls.log"
mkdir -p "$TRIP" "$SAFE" "$PYD" "$T/root/sys/block"
case "$T" in /dev/*) echo "REFUSING: the temp dir is under /dev"; exit 1 ;; esac

for t in shred blkdiscard hdparm nvme rtcwake wipefs sgdisk; do
  printf '#!/bin/sh\necho "%s $*" >> "%s"\nexit 0\n' "$t" "$LOG" > "$TRIP/$t"
  chmod +x "$TRIP/$t"
done

# dd: reads only, never a /dev path. STUB_DD=fail: the read fails, nothing
# comes back. STUB_DD=virtual: a drive that does not exist on disk (the 1 TB
# case) - hands back bs*count zero bytes, so the log shows what was asked for.
REALDD=$(command -v dd) || { echo "missing dd"; exit 1; }
cat > "$TRIP/dd" <<EOF
#!/bin/sh
echo "dd \$*" >> "$LOG"
bs=512; count=; args=
for a in "\$@"; do
  case "\$a" in
    if=/dev/*|of=*) echo "dd REFUSED \$a" >> "$LOG"; echo "dd REFUSED \$a" >> "$T/refused.log"; exit 99 ;;
    bs=*) bs=\${a#bs=} ;;
    count=*) count=\${a#count=} ;;
  esac
  case "\$a" in iflag=direct) ;; *) args="\$args \$a" ;; esac
done
case "\$(printenv STUB_DD)" in
  fail) exit 1 ;;
  virtual) head -c \$(( bs * count )) /dev/zero; exit 0 ;;
esac
exec "$REALDD" \$args
EOF
chmod +x "$TRIP/dd"

printf '#!/bin/sh\nexec "%s" "$@"\n' "$PYREAL" > "$PYD/python3"
chmod +x "$PYD/python3"

for t in head tr sed grep basename wc cat printenv date rm od; do
  real=$(command -v "$t") || { echo "missing $t"; exit 1; }
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$real" > "$SAFE/$t"
  chmod +x "$SAFE/$t"
done
for t in lsblk findmnt readlink; do
  printf '#!/bin/sh\nexit 0\n' > "$SAFE/$t"; chmod +x "$SAFE/$t"
done

# ---- fixtures: real on-disk structures, byte for byte ----------------------
cat > "$T/fx.py" <<'PYEOF'
import os, struct, sys

def put(path, off, data):
    with open(path, "r+b") as f:
        f.seek(off)
        f.write(data)

def fillbytes(kind, n):
    if kind == "zeros":
        return bytes(n)
    if kind == "ff":
        return b"\xff" * n
    if kind == "random":
        return os.urandom(n)
    if kind == "text":
        t = b"Customer invoice 2025-11, payroll.xlsx, family photos ... "
        return (t * (n // len(t) + 1))[:n]
    if kind.startswith("pattern:"):
        p = bytes.fromhex(kind[8:])
        return (p * (n // len(p) + 1))[:n]
    raise SystemExit("unknown fill " + kind)

def boot(kind):
    # A 512-byte volume boot sector (or header) of the named kind.
    b = bytearray(512)
    b[0:3] = b"\xeb\x52\x90"
    if kind == "ntfs":
        b[3:11] = b"NTFS    "
    elif kind == "bitlocker":
        b[3:11] = b"-FVE-FS-"
    elif kind == "fat32":
        b[3:11] = b"MSDOS5.0"
        b[82:90] = b"FAT32   "
    elif kind == "fat16":
        b[3:11] = b"MSDOS5.0"
        b[54:62] = b"FAT16   "
    elif kind == "luks":
        b[0:6] = b"LUKS\xba\xbe"
        b[6:8] = b"\x00\x02"
        return bytes(b)
    b[510:512] = b"\x55\xaa"
    return bytes(b)

def main():
    op, path = sys.argv[1], sys.argv[2]
    a = sys.argv[3:]
    if op == "new":                       # new FILE MIB FILL
        n = int(a[0]) * 1048576
        with open(path, "wb") as f:
            for o in range(0, n, 1048576):
                f.write(fillbytes(a[1], 1048576))
    elif op == "fill":                    # fill FILE START LEN|all FILL
        size = os.path.getsize(path)
        s = int(a[0])
        n = size - s if a[1] == "all" else int(a[1])
        for o in range(s, s + n, 1048576):
            put(path, o, fillbytes(a[2], min(1048576, s + n - o)))
    elif op == "gpt":                     # gpt FILE SECTOR PART_LBA [BOOT_KIND]
        ss, lba = int(a[0]), int(a[1])
        size = os.path.getsize(path)
        mbr = bytearray(512)
        mbr[446 + 4] = 0xEE               # protective MBR: one 0xEE entry
        mbr[446 + 8:446 + 12] = struct.pack("<I", 1)
        mbr[446 + 12:446 + 16] = struct.pack("<I", min(size // ss - 1, 0xFFFFFFFF))
        mbr[510:512] = b"\x55\xaa"
        put(path, 0, bytes(ss))           # the table area is zeros, not fill
        put(path, 0, bytes(mbr))
        hdr = bytearray(92)
        hdr[0:8] = b"EFI PART"
        hdr[8:12] = b"\x00\x00\x01\x00"
        hdr[12:16] = struct.pack("<I", 92)
        hdr[24:32] = struct.pack("<Q", 1)
        hdr[72:80] = struct.pack("<Q", 2)  # the entries start at LBA 2
        hdr[80:84] = struct.pack("<I", 128)
        hdr[84:88] = struct.pack("<I", 128)
        put(path, ss, bytes(ss))
        put(path, ss, bytes(hdr))
        ent = bytearray(128)
        ent[0:16] = bytes.fromhex("a2a0d0ebe5b9334487c068b6b72699c7")  # basic data
        ent[16:32] = os.urandom(16)
        ent[32:40] = struct.pack("<Q", lba)
        ent[40:48] = struct.pack("<Q", lba + 2048)
        put(path, 2 * ss, bytes(32 * ss))
        put(path, 2 * ss, bytes(ent))
        put(path, size - ss, bytes(ss))    # and the backup header at the end
        put(path, size - ss, bytes(hdr))
        if len(a) > 2:
            put(path, lba * ss, bytes(4096))
            put(path, lba * ss, boot(a[2]))
    elif op == "boot":                    # boot FILE OFFSET KIND
        o = int(a[0])
        put(path, o, bytes(4096))
        put(path, o, boot(a[1]))
    elif op == "ext":                     # ext FILE OFFSET: an ext4 superblock
        o = int(a[0])
        put(path, o, bytes(4096))
        sb = bytearray(1024)
        sb[0:4] = struct.pack("<I", 65536)   # inode count
        sb[56:58] = b"\x53\xef"              # s_magic 0xEF53
        put(path, o + 1024, bytes(sb))
    elif op == "mbr":                     # mbr FILE: a real MBR in sector 0 only
        # Boot code (x86, the usual low-entropy mix of opcodes and text), one
        # NTFS/BitLocker-type (0x07) partition at LBA 2048, three empty
        # entries, 0x55AA. The seven sectors after it are left as they are.
        m = bytearray(512)
        code = b"\xfa\x33\xc0\x8e\xd0\xbc\x00\x7c\x8e\xc0\x8e\xd8\xbe\x00\x7c\xbf\x00\x06" \
            + b"Invalid partition table\0Error loading operating system\0Missing operating system\0"
        m[0:440] = (code * (440 // len(code) + 1))[:440]
        m[446] = 0x80
        m[446 + 4] = 0x07
        m[446 + 8:446 + 12] = struct.pack("<I", 2048)
        m[446 + 12:446 + 16] = struct.pack("<I", 409600)
        m[510:512] = b"\x55\xaa"
        put(path, 0, bytes(m))
    elif op == "bytes":                   # bytes FILE OFFSET HEX
        put(path, int(a[0]), bytes.fromhex(a[1]))
    else:
        raise SystemExit("unknown op " + op)

main()
PYEOF
fx() { "$PYREAL" "$T/fx.py" "$@" || { echo "fixture failed: $*"; exit 1; }; }

SRC="$HERE/hardware-audit.sh"
VF="$(extract "$SRC" als_verify_py)
$(extract "$SRC" als_part_starts)
$(extract "$SRC" verify_erased)"
case "$VF" in *'als_verify_py() {'*PYEOF*'als_part_starts() {'*'verify_erased() {'*) ;; *) echo "could not extract verify_erased - refusing to run"; exit 1 ;; esac

FUNCS="$(grep -E '^(esc|o_begin|o_s|o_s0|o_n|o_raw|o_end|als_utc_now)\(\) \{' "$SRC")
$(grep '^ALS_TOOL_VERSION=' "$SRC")
$(extract "$SRC" als_lsblk_val)
$(extract "$SRC" als_lsblk_unescape)
$(extract "$SRC" als_drive_identity)
$(extract "$SRC" wipe_result)
$(extract "$SRC" clear_label)
$(extract "$SRC" als_disk_is_usb)
$(extract "$SRC" als_boot_disk)
$(extract "$SRC" als_json_array)
$(extract "$SRC" wr_limit)
$(extract "$SRC" ata_hidden_areas)
$(extract "$SRC" ata_hpa_remove)
$(extract "$SRC" smart_counts)
$(extract "$SRC" wipe_assess)
$(extract "$SRC" als_wipe_lock)
$(extract "$SRC" als_wipe_unlock)
$VF
$(extract "$SRC" gui_wipe_one | sed 's/\[ ! -b "\$dev" \]/[ ! -e "$dev" ]/')"
case "$FUNCS" in *'[ ! -e "$dev" ]'*) ;; *) echo "could not relax the -b check - refusing to run"; exit 1 ;; esac

# blockdev answers from the temp file (or STUB_SIZE for a virtual drive).
# firmware_erase / run_overwrite change the temp file the way the erase would:
#   STUB_FW=lie      "done", nothing changed (the lying controller)
#   STUB_FW=random   a crypto erase: the whole drive reads as ciphertext
#   STUB_FW=ff|zeros|pattern:HEX   a fill a controller may leave
#   STUB_FW=ends     only the first and last MiB erased (both GPT copies
#                    gone - what wipefs does - the volumes left behind)
#   STUB_FW=gone     the drive vanished during the erase
#   STUB_FW=fail     no firmware erase available
#   STUB_OVR=zeros   the overwrite wrote zeros (last pass); lie: wrote nothing;
#                    random: the zero pass never happened
STUBS='
blockdev() {
  case "$1" in
    --getsize64) if [ -n "${STUB_SIZE:-}" ]; then echo "$STUB_SIZE"; else [ -e "$2" ] && wc -c < "$2" | tr -d " "; fi ;;
    --getss) echo "${STUB_SS:-512}" ;;
    *) return 0 ;;
  esac
}
firmware_erase() {
  echo "firmware_erase $*" >> "$LOG"
  M="NVMe cryptographic erase (sanitize)"; FW_LEVEL="${STUB_FW_LEVEL:-purge}"
  case "${STUB_FW:-fail}" in
    fail) M=""; return 1 ;;
    lie)  return 0 ;;
    gone) rm -f "$1"; return 0 ;;
    ends) "$PYREAL" "$FX" fill "$1" 0 1048576 zeros
          "$PYREAL" "$FX" fill "$1" $(( $(wc -c < "$1") - 1048576 )) 1048576 zeros; return 0 ;;
    *)    "$PYREAL" "$FX" fill "$1" 0 all "$STUB_FW"; return 0 ;;
  esac
}
run_overwrite() {
  echo "run_overwrite $*" >> "$LOG"
  case "${STUB_OVR:-zeros}" in
    lie) ;;
    *) "$PYREAL" "$FX" fill "$1" 0 all "${STUB_OVR:-zeros}" ;;
  esac
  return 0
}
cat() { case "$*" in */queue/rotational) echo 0 ;; */removable) echo 0 ;; *) command cat "$@" ;; esac; }
'

# wipe DEV WANT <env...> -> OUT, RESULT, CALLS
wipe() {
  local dev="$1" want="$2"; shift 2
  case "$dev" in /dev/*) echo "REFUSING: a /dev target in the harness"; exit 1 ;; esac
  : > "$LOG"
  OUT=$(env -i PATH="$TRIP:$PYD:$SAFE" LOG="$LOG" FX="$T/fx.py" PYREAL="$PYREAL" ALS_SYS_ROOT="$T/root" \
        D="$dev" W="$want" "$@" "$BASH" -c "$FUNCS
$STUBS
gui_wipe_one \"\$D\" \"\$W\"" 2>&1)
  RESULT=$(printf '%s\n' "$OUT" | sed -n 's/^WIPE_RESULT //p' | tail -n1)
  CALLS=$(command cat "$LOG")
}
# field NAME -> the value of a string field of RESULT, parsed as JSON
field() { printf '%s' "$RESULT" | "$PYREAL" -c 'import json,sys; v=json.loads(sys.stdin.read()).get(sys.argv[1]); sys.stdout.write("" if v is None else str(v))' "$1" 2>/dev/null; }

# ve DEV MODE [STARTS] <env...> -> VRC, VWHY, VLABEL, VMIB, CALLS (verify_erased alone)
ve() {
  local dev="$1" mode="$2" starts="$3"; shift 3
  case "$dev" in /dev/*) echo "REFUSING: a /dev target in the harness"; exit 1 ;; esac
  : > "$LOG"
  local r
  r=$(env -i PATH="$TRIP:$PYD:$SAFE" LOG="$LOG" FX="$T/fx.py" PYREAL="$PYREAL" ALS_SYS_ROOT="$T/root" \
      D="$dev" MODE="$mode" S="$starts" "$@" "$BASH" -c "$FUNCS
$STUBS
verify_erased \"\$D\" \"\$MODE\" \"\$S\"; rc=\$?
printf '%s|%s|%s|%s' \"\$rc\" \"\$VE_LABEL\" \"\$VE_MIB\" \"\$VE_WHY\"" 2>&1)
  VRC=${r%%|*}; r=${r#*|}
  VLABEL=${r%%|*}; r=${r#*|}
  VMIB=${r%%|*}; VWHY=${r#*|}
  CALLS=$(command cat "$LOG")
}

MIB=16
D="$T/drive"
# A Windows disk as a customer hands it in: GPT, one NTFS partition at 3 MiB
# (outside every fixed read window of a 16 MiB drive - only the saved
# partition start finds it), the rest of the disk full of their files.
mkdisk() { fx new "$D" "$MIB" "${1:-text}"; fx gpt "$D" "${2:-512}" "${3:-6144}" "${4:-ntfs}"; }

echo "the partition starts are recorded before the erase"
mkdisk
got=$(env -i PATH="$TRIP:$PYD:$SAFE" LOG="$LOG" ALS_SYS_ROOT="$T/root" D="$D" "$BASH" -c "$FUNCS
$STUBS
als_part_starts \"\$D\" drive")
[ "$got" = "3145728" ] && ok "from the on-disk GPT: the NTFS partition at byte 3145728" || bad "from the on-disk GPT: the NTFS partition at byte 3145728" "got '$got'"
mkdir -p "$T/root/sys/block/nvme7n1/nvme7n1p1" "$T/root/sys/block/nvme7n1/nvme7n1p2"
echo 2048 > "$T/root/sys/block/nvme7n1/nvme7n1p1/start"
echo 206848 > "$T/root/sys/block/nvme7n1/nvme7n1p2/start"
got=$(env -i PATH="$TRIP:$PYD:$SAFE" LOG="$LOG" ALS_SYS_ROOT="$T/root" D="$D" "$BASH" -c "$FUNCS
$STUBS
als_part_starts \"\$D\" nvme7n1")
[ "$got" = "1048576 105906176 3145728" ] && ok "from the kernel's sysfs as well (512-byte units)" || bad "from the kernel's sysfs as well (512-byte units)" "got '$got'"
rm -rf "$T/root/sys/block/nvme7n1"

echo "a lying controller: 'done', and the customer's disk is untouched"
mkdisk
wipe "$D" auto STUB_FW=lie STUB_OVR=lie
[ "$(field status)" = failed ] && ok "status failed" || bad "status failed" "$RESULT"
case "$(field reason)" in *"GPT header (EFI PART) at byte 512"*) ok "the reason names the signature and its offset" ;; *) bad "the reason names the signature and its offset" "$(field reason)" ;; esac
case "$OUT" in *"OLD DATA STILL PRESENT"*"GPT header (EFI PART) at byte 512"*) ok "the firmware erase's failure was announced, naming what was found" ;; *) bad "the firmware erase's failure was announced, naming what was found" "$OUT" ;; esac
case "$CALLS" in *firmware_erase*run_overwrite*) ok "found -> down the ladder to an overwrite" ;; *) bad "found -> down the ladder to an overwrite" "$CALLS" ;; esac
[ "$(field verification)" = found ] && ok "verification: found" || bad "verification: found" "$RESULT"
[ "$(field sanitisationLevel)" = none ] && ok "sanitisationLevel: none" || bad "sanitisationLevel: none" "$RESULT"
case "$RESULT" in *controller*) bad "no 'controller-confirmed' anywhere in the result" "$RESULT" ;; *) ok "no 'controller-confirmed' anywhere in the result" ;; esac

mkdisk
wipe "$D" auto STUB_FW=lie STUB_OVR=zeros
[ "$(field status)" = wiped ] && ok "lying controller, then a real overwrite: wiped" || bad "lying controller, then a real overwrite: wiped" "$RESULT"
case "$(field method)" in Overwrite*"verified (reads as zeros)"*) ok "  ... recorded as the overwrite, not the firmware erase" ;; *) bad "  ... recorded as the overwrite, not the firmware erase" "$(field method)" ;; esac
[ "$(field sanitisationLevel)" = clear ] && ok "  ... sanitisationLevel clear (an overwrite is never Purge)" || bad "  ... sanitisationLevel clear (an overwrite is never Purge)" "$RESULT"

mkdisk random
wipe "$D" auto STUB_FW=ends STUB_OVR=lie
[ "$(field status)" = failed ] && ok "only the partition table erased: failed" || bad "only the partition table erased: failed" "$RESULT"
case "$OUT" in *"OLD DATA STILL PRESENT"*"NTFS boot sector at byte 3145731"*) ok "  ... found through the SAVED partition start (NTFS at 3 MiB)" ;; *) bad "  ... found through the SAVED partition start (NTFS at 3 MiB)" "$OUT" ;; esac

# The same, one volume type at a time, straight through verify_erased: the
# table at both ends erased, the drive otherwise ciphertext, and the volume's
# own boot sector / header / superblock left at the saved partition start.
ends() { fx fill "$D" 0 1048576 zeros; fx fill "$D" $(( MIB * 1048576 - 1048576 )) 1048576 zeros; }
for k in ntfs:"NTFS boot sector at byte 3145731" bitlocker:"BitLocker boot sector (-FVE-FS-) at byte 3145731" \
         fat32:"FAT32 boot sector at byte 3145810" fat16:"FAT boot sector at byte 3145782" luks:"LUKS header at byte 3145728"; do
  mkdisk random 512 6144 "${k%%:*}"; ends
  ve "$D" firmware "0 3145728"
  [ "$VRC" = 1 ] && [ "$VWHY" = "${k#*:}" ] && ok "a ${k%%:*} volume left at its partition start: found ($VWHY)" \
    || bad "a ${k%%:*} volume left at its partition start: found" "rc=$VRC $VWHY"
done
mkdisk random 512 6144 none; fx ext "$D" 3145728; ends
ve "$D" firmware "0 3145728"
[ "$VRC" = 1 ] && [ "$VWHY" = "ext2/3/4 superblock at byte 3146808" ] && ok "an ext4 superblock left at its partition start: found" || bad "an ext4 superblock left at its partition start: found" "rc=$VRC $VWHY"
ve "$D" firmware "0"
[ "$VRC" = 0 ] && ok "  ... and WITHOUT the saved start the same drive passes - which is why they are recorded first" || bad "  ... and WITHOUT the saved start the same drive passes" "rc=$VRC $VWHY"

fx new "$D" "$MIB" random; fx bytes "$D" 4096 "$(printf 'EFI PART' | od -An -tx1 | tr -d ' \n')"
ve "$D" firmware "0"
[ "$VRC" = 1 ] && case "$VWHY" in *"4K sectors"*"at byte 4096"*) true ;; *) false ;; esac \
  && ok "a GPT header at LBA 1 of a 4096-byte-sector drive: found" || bad "a GPT header at LBA 1 of a 4096-byte-sector drive: found" "rc=$VRC $VWHY"
fx new "$D" "$MIB" random; fx bytes "$D" $(( MIB * 1048576 - 512 )) "$(printf 'EFI PART' | od -An -tx1 | tr -d ' \n')"
ve "$D" firmware "0"
[ "$VRC" = 1 ] && case "$VWHY" in *"backup GPT"*) true ;; *) false ;; esac \
  && ok "the backup GPT header in the last sector: found (the last-MiB window)" || bad "the backup GPT header in the last sector: found (the last-MiB window)" "rc=$VRC $VWHY"

echo "a genuine erase: firmware methods accept what an erase leaves"
mkdisk
wipe "$D" auto STUB_FW=random
[ "$(field status)" = wiped ] && ok "crypto erase, reads as random: wiped" || bad "crypto erase, reads as random: wiped" "$RESULT"
case "$CALLS" in *run_overwrite*) bad "  ... and NO overwrite was called" "$CALLS" ;; *) ok "  ... and NO overwrite was called" ;; esac
case "$(field method)" in *"verified (reads as random)"*) ok "  ... method says what was read back: random" ;; *) bad "  ... method says what was read back: random" "$(field method)" ;; esac
[ "$(field verification)" = clean ] && [ "$(field sanitisationLevel)" = purge ] && ok "  ... verification clean, sanitisationLevel purge" || bad "  ... verification clean, sanitisationLevel purge" "$RESULT"
case "$OUT" in *"Read back "*" MiB across the drive: no old data found"*"Sanitisation level: purge"*) ok "  ... the operator's summary says what was read and the level" ;; *) bad "  ... the operator's summary says what was read and the level" "$OUT" ;; esac

mkdisk
wipe "$D" auto STUB_FW=ff
[ "$(field status)" = wiped ] && case "$(field method)" in *"reads as 0xFF"*) true ;; *) false ;; esac \
  && ok "all 0xFF after a firmware method: wiped (reads as 0xFF)" || bad "all 0xFF after a firmware method: wiped (reads as 0xFF)" "$RESULT"
mkdisk
wipe "$D" auto STUB_FW=zeros
[ "$(field status)" = wiped ] && case "$(field method)" in *"reads as zeros"*) true ;; *) false ;; esac \
  && ok "all zeros after a firmware method: wiped (reads as zeros)" || bad "all zeros after a firmware method: wiped (reads as zeros)" "$RESULT"
mkdisk
wipe "$D" auto STUB_FW=pattern:deadbeef
[ "$(field status)" = wiped ] && case "$(field method)" in *"reads as pattern"*) true ;; *) false ;; esac \
  && ok "a short repeated vendor fill: wiped (reads as pattern)" || bad "a short repeated vendor fill: wiped (reads as pattern)" "$RESULT"
mkdisk
wipe "$D" auto STUB_FW=pattern:55aa
[ "$(field status)" = wiped ] && ok "a 55 AA 55 AA ... fill is a fill, not a boot signature at byte 510" || bad "a 55 AA 55 AA ... fill is a fill, not a boot signature at byte 510" "$RESULT"
mkdisk
wipe "$D" auto STUB_FW=random STUB_FW_LEVEL=clear
[ "$(field sanitisationLevel)" = clear ] && ok "a NORMAL ATA secure erase, verified: clear, not purge" || bad "a NORMAL ATA secure erase, verified: clear, not purge" "$RESULT"
# Ciphertext that happens to hold 55 AA at byte 510: 1 in 65536 per place
# looked, so a real crypto erase would hit it now and then. It is chance.
fx new "$D" "$MIB" random; fx bytes "$D" 510 55aa
ve "$D" firmware "0"
[ "$VRC" = 0 ] && ok "random data that happens to hold 55 AA at byte 510: still clean" || bad "random data that happens to hold 55 AA at byte 510: still clean" "rc=$VRC $VWHY"
# ...but a REAL MBR in a random-looking block is not chance. A real partition
# table followed by seven sectors of compressed boot loader or ciphertext reads
# as 7.8+ bits/byte over the 4 KiB block; with headerless full-disk encryption
# on the partitions there is no longer magic anywhere, and the old "a 2-byte hit
# in a random block is chance" waiver let a controller that erased NOTHING pass
# as a crypto erase ("reads as random"). Review finding, wave 2 round A.
fx new "$D" "$MIB" random; fx mbr "$D"
ve "$D" firmware "0"
[ "$VRC" = 1 ] && [ "$VWHY" = "MBR/boot-sector signature 0x55AA at byte 510" ] \
  && ok "a real MBR + random-looking sectors 1-7 (untouched encrypted disk): found" || bad "a real MBR + random-looking sectors 1-7 (untouched encrypted disk): found" "rc=$VRC $VWHY"
ve "$D" firmware "0 1048576"
[ "$VRC" = 1 ] && ok "  ... also with a saved partition start in the list" || bad "  ... also with a saved partition start in the list" "rc=$VRC $VWHY"
fx new "$D" "$MIB" random; fx bytes "$D" 446 00; fx bytes "$D" 462 00; fx bytes "$D" 478 00; fx bytes "$D" 494 00; fx bytes "$D" 510 55aa
ve "$D" firmware "0"
[ "$VRC" = 1 ] && ok "an MBR whose four status bytes are 00 (the rest random): found - that is not chance" || bad "an MBR whose four status bytes are 00 (the rest random): found" "rc=$VRC $VWHY"
fx new "$D" "$MIB" random; fx bytes "$D" 446 00; fx bytes "$D" 462 80; fx bytes "$D" 478 00; fx bytes "$D" 494 17; fx bytes "$D" 510 55aa
ve "$D" firmware "0"
[ "$VRC" = 0 ] && ok "  ... but one status byte that no MBR can hold (0x17): chance, clean" || bad "  ... but one status byte that no MBR can hold (0x17): chance, clean" "rc=$VRC $VWHY"
# The same rule for the other 2-byte magic, ext's 0xEF53: a real superblock
# has s_rev_level 0 or 1 (20 bytes after the magic); ciphertext almost never.
fx new "$D" "$MIB" random; fx bytes "$D" 1080 53ef; fx bytes "$D" 1100 01000000
ve "$D" firmware "0"
[ "$VRC" = 1 ] && [ "$VWHY" = "ext2/3/4 superblock at byte 1080" ] \
  && ok "0xEF53 + s_rev_level 1 in a random-looking block: found" || bad "0xEF53 + s_rev_level 1 in a random-looking block: found" "rc=$VRC $VWHY"
fx new "$D" "$MIB" random; fx bytes "$D" 1080 53ef; fx bytes "$D" 1100 7a31c9e4
ve "$D" firmware "0"
[ "$VRC" = 0 ] && ok "  ... 0xEF53 with a random s_rev_level: chance, clean" || bad "  ... 0xEF53 with a random s_rev_level: chance, clean" "rc=$VRC $VWHY"
fx new "$D" "$MIB" random; fx fill "$D" 8388608 8192 text
ve "$D" firmware "0"
[ "$VRC" = 1 ] && case "$VWHY" in *"not an erase pattern"*) true ;; *) false ;; esac \
  && ok "a stretch of plain-text files in a window: found" || bad "a stretch of plain-text files in a window: found" "rc=$VRC $VWHY"

echo "an overwrite must read back as zeros"
mkdisk
wipe "$D" overwrite STUB_OVR=zeros
[ "$(field status)" = wiped ] && case "$(field method)" in *"reads as zeros"*) true ;; *) false ;; esac \
  && ok "overwrite, reads as zeros: wiped" || bad "overwrite, reads as zeros: wiped" "$RESULT"
[ "$(field sanitisationLevel)" = clear ] && ok "  ... sanitisationLevel clear" || bad "  ... sanitisationLevel clear" "$RESULT"
mkdisk
wipe "$D" overwrite STUB_OVR=random
[ "$(field status)" = failed ] && case "$(field reason)" in *"non-zero data"*) true ;; *) false ;; esac \
  && ok "overwrite reads back random (the zero pass never happened): failed" || bad "overwrite reads back random (the zero pass never happened): failed" "$RESULT"
mkdisk
wipe "$D" overwrite STUB_OVR=ff
[ "$(field status)" = failed ] && ok "overwrite reads back 0xFF: failed (0xFF is only accepted from firmware)" || bad "overwrite reads back 0xFF: failed (0xFF is only accepted from firmware)" "$RESULT"

echo "could not verify -> failed with the reason (owner decision D31), never wiped"
mkdisk
wipe "$D" auto STUB_FW=random STUB_DD=fail
[ "$(field status)" = failed ] && ok "an unreadable device: failed" || bad "an unreadable device: failed" "$RESULT"
[ "$(field verification)" = unverified ] && ok "  ... verification unverified" || bad "  ... verification unverified" "$RESULT"
case "$(field reason)" in *"could not verify"*"short read"*) ok "  ... the reason says why ($(field reason))" ;; *) bad "  ... the reason says why" "$(field reason)" ;; esac
case "$CALLS" in *run_overwrite*) bad "  ... and no overwrite is started on a drive that cannot be read" "$CALLS" ;; *) ok "  ... and no overwrite is started on a drive that cannot be read" ;; esac
mkdisk
wipe "$D" auto STUB_FW=gone
[ "$(field status)" = failed ] && case "$(field reason)" in *"no longer present"*) true ;; *) false ;; esac \
  && ok "the device vanished during the erase: failed" || bad "the device vanished during the erase: failed" "$RESULT"
mkdisk
wipe "$D" overwrite STUB_OVR=zeros STUB_DD=fail
[ "$(field status)" = failed ] && [ "$(field verification)" = unverified ] && ok "an overwrite that cannot be read back: failed, unverified" || bad "an overwrite that cannot be read back: failed, unverified" "$RESULT"
# A read that comes back SHORT: the drive is smaller than it claims.
mkdisk
wipe "$D" auto STUB_FW=random STUB_SIZE=$(( (MIB + 4) * 1048576 ))
[ "$(field status)" = failed ] && case "$(field reason)" in *"short read"*) true ;; *) false ;; esac \
  && ok "a short read (the drive answers less than it claims): failed" || bad "a short read (the drive answers less than it claims): failed" "$RESULT"
# No python3 at all.
mkdisk
: > "$LOG"
OUT=$(env -i PATH="$TRIP:$SAFE" LOG="$LOG" FX="$T/fx.py" PYREAL="$PYREAL" ALS_SYS_ROOT="$T/root" D="$D" "$BASH" -c "$FUNCS
$STUBS
gui_wipe_one \"\$D\" auto" 2>&1)
RESULT=$(printf '%s\n' "$OUT" | sed -n 's/^WIPE_RESULT //p' | tail -n1)
[ "$(field status)" = failed ] && case "$(field reason)" in *python3*) true ;; *) false ;; esac \
  && ok "python3 missing: failed, and says so" || bad "python3 missing: failed, and says so" "$RESULT"

echo "bounded: a 1 TB drive is verified by reading windows, never the whole drive"
: > "$T/tb"
ve "$T/tb" firmware "" STUB_DD=virtual STUB_SIZE=1000204886016
tot=$(printf '%s\n' "$CALLS" | "$PYREAL" -c '
import sys
t = 0
for l in sys.stdin:
    a = dict(x.split("=", 1) for x in l.split()[1:] if "=" in x)
    if "count" in a: t += int(a["bs"]) * int(a["count"])
print(t)')
[ "$VRC" = 0 ] && [ "$tot" = 10485760 ] && [ "$VMIB" = 10 ] \
  && ok "1 TB, no partitions: 10 windows, 10 MiB read in total" || bad "1 TB, no partitions: 10 windows, 10 MiB read in total" "rc=$VRC read=$tot mib=$VMIB"
ndd=$(printf '%s\n' "$CALLS" | grep -c '^dd ')
ndir=$(printf '%s\n' "$CALLS" | grep '^dd ' | grep -c 'iflag=direct')
[ "$ndd" = "$ndir" ] && [ "$ndd" -gt 0 ] && ok "every read asks for O_DIRECT (the drive, not the page cache)" || bad "every read asks for O_DIRECT" "$ndir of $ndd"
case "$CALLS" in *"skip=244190390 count=256"*) ok "the last MiB is one of the windows" ;; *) bad "the last MiB is one of the windows" "$CALLS" ;; esac
ve "$T/tb" firmware "1048576 105906176 500107862016" STUB_DD=virtual STUB_SIZE=1000204886016
[ "$VRC" = 0 ] && [ "$VMIB" = 13 ] && ok "1 TB with 3 saved partition starts: 13 MiB read in total" || bad "1 TB with 3 saved partition starts: 13 MiB read in total" "rc=$VRC mib=$VMIB"
many=""; i=1; while [ "$i" -le 100 ]; do many="$many $(( i * 4294967296 ))"; i=$((i + 1)); done
ve "$T/tb" firmware "$many" STUB_DD=virtual STUB_SIZE=1000204886016
[ "$VRC" = 0 ] && [ "$VMIB" -le 42 ] && ok "100 partition starts: capped at 32 extra windows ($VMIB MiB)" || bad "100 partition starts: capped at 32 extra windows" "rc=$VRC mib=$VMIB"

echo "the checker's own failures are 'could not verify', never 'clean'"
fx new "$D" "$MIB" random
ve "$D" firmware "0" STUB_DD=virtual STUB_SIZE=0
[ "$VRC" = 2 ] && ok "a size of 0: could not verify" || bad "a size of 0: could not verify" "rc=$VRC $VWHY"

echo "the whole engine"
live=$(grep -n 'controller-confirmed' "$SRC")
[ -z "$live" ] && ok "grep controller-confirmed tools/hardware-audit.sh is empty" || bad "grep controller-confirmed tools/hardware-audit.sh is empty" "$live"
live=$(grep -n 'verify_zero' "$SRC")
[ -z "$live" ] && ok "the old zeros-only check is gone" || bad "the old zeros-only check is gone" "$live"
d_line=$(grep -n '^if \[ "\${1:-}" = "--wipe-drive" \]' "$SRC" | cut -d: -f1)
for f in als_verify_py als_part_starts verify_erased; do
  f_line=$(grep -n "^$f() {" "$SRC" | cut -d: -f1)
  [ -n "$f_line" ] && [ -n "$d_line" ] && [ "$f_line" -lt "$d_line" ] \
    && ok "$f is defined above the --wipe-drive dispatch" || bad "$f is defined above the --wipe-drive dispatch" "def ${f_line:-none}, dispatch ${d_line:-none}"
done
[ ! -s "$T/refused.log" ] && ok "the harness never saw a /dev path or a write" || bad "the harness never saw a /dev path or a write" "$(command cat "$T/refused.log")"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
