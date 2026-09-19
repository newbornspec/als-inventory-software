#!/usr/bin/env bash
# Tests for how make-als-layer.sh chooses the layer's squashfs compressor.
#
# Why. Firefox took 13.6 s from launch to first request on the station, and
# most of it was the kernel decompressing our xz layer on one core. lz4 cuts
# that (measured 5.9-6.75 s -> 1.74 s cold, same ESR, station-class cores).
# But a layer the kernel cannot decompress does not degrade - casper's mount
# fails and the boot panics. So what must hold is:
#   - lz4 ONLY when the stick's own casper/vmlinuz is a kernel proven to have
#     SQUASHFS_LZ4 built in (the 24.04.2 kernel, proven under QEMU), or the
#     build host's /boot/config-<that release> says =y for both options;
#   - a config that says otherwise wins over the proven list; =m is not enough;
#   - anything unproven or unreadable builds xz, as before;
#   - ALS_LAYER_COMP=xz is the opt-out, =lz4 insists (and stops rather than
#     fall back), anything else is refused;
#   - the built file's superblock is read back and must match the choice,
#     and the existing mount check still runs on it.
#
#   bash tools/test-layer-comp.sh
#
# Runs in a temp directory with fake kernel images; sources make-als-layer.sh
# with ALS_LAYER_LIB=1 (returns before the root check - nothing touches a
# stick). ALS_TEST_VMLINUZ=<the ISO's casper/vmlinuz> adds a check against the
# real 24.04.2 kernel image.

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s   (%s)\n' "$1" "$2"; }

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

# shellcheck disable=SC1091
ALS_LAYER_LIB=1 . "$HERE/make-als-layer.sh" || { echo "could not source make-als-layer.sh"; exit 1; }
unset ALS_LAYER_COMP

for f in als_kernel_release als_pick_layer_comp als_squashfs_comp als_kconfig_lz4 als_comp_id; do
  if ! command -v "$f" >/dev/null 2>&1; then
    bad "make-als-layer.sh defines $f" "missing"
    echo; echo "$PASS passed, $FAIL failed"; exit 1
  fi
done

# A minimal x86 bzImage setup header: "HdrS" at 0x202, a pointer at 0x20E to
# the version string at pointer+0x200 (here 0x100 -> byte 768).
mkbz() {  # mkbz <file> <version string>
  head -c 2048 /dev/zero > "$1"
  printf 'HdrS' | dd of="$1" bs=1 seek=514 conv=notrunc 2>/dev/null
  printf '\000\001' | dd of="$1" bs=1 seek=526 conv=notrunc 2>/dev/null
  printf '%s\000' "$2" | dd of="$1" bs=1 seek=768 conv=notrunc 2>/dev/null
}
PROVEN_STR="6.11.0-17-generic (buildd@lcy02-amd64-038) #17~24.04.2-Ubuntu SMP PREEMPT_DYNAMIC Mon Jan 20 22:48:29 UTC 2025"
OTHER_STR="6.8.0-31-generic (buildd@lcy02-amd64-080) #31-Ubuntu SMP PREEMPT_DYNAMIC Sat Apr 20 00:40:06 UTC 2024"
mkbz "$T/proven" "$PROVEN_STR"
mkbz "$T/other" "$OTHER_STR"
# Same release, different build: not the kernel that was proven.
mkbz "$T/rebuilt" "6.11.0-17-generic (buildd@x) #17~24.04.9-Ubuntu SMP"
head -c 2048 /dev/zero > "$T/garbage"
R="$T/root"; mkdir -p "$R/boot"

pick() {  # pick <vmlinuz>  -> sets OUT, RC (runs in a subshell so die cannot end the test)
  OUT=$( ( als_pick_layer_comp "$1" "$R" && printf 'RESULT %s|%s\n' "$LAYER_COMP" "$LAYER_COMP_ARGS" ) 2>&1 )
  RC=$?
}
result() { printf '%s\n' "$OUT" | sed -n 's/^RESULT //p'; }

echo "reading the kernel version out of the image"
v=$(als_kernel_release "$T/proven")
[ "$v" = "6.11.0-17-generic#17~24.04.2-Ubuntu" ] && ok "release and build: $v" || bad "als_kernel_release" "'$v'"
v=$(als_kernel_release "$T/garbage"); [ -z "$v" ] && ok "no HdrS header -> nothing" || bad "garbage image" "'$v'"
v=$(als_kernel_release "$T/missing"); [ -z "$v" ] && ok "no file -> nothing" || bad "missing image" "'$v'"
if [ -n "${ALS_TEST_VMLINUZ:-}" ] && [ -f "$ALS_TEST_VMLINUZ" ]; then
  v=$(als_kernel_release "$ALS_TEST_VMLINUZ")
  [ "$v" = "6.11.0-17-generic#17~24.04.2-Ubuntu" ] && ok "the real 24.04.2 casper/vmlinuz reads $v" \
    || bad "real vmlinuz" "'$v'"
fi

echo "auto (the default)"
rm -f "$R"/boot/config-*
pick "$T/proven"
[ "$(result)" = "lz4|-comp lz4 -Xhc" ] && ok "the proven 24.04.2 kernel -> lz4 -Xhc" || bad "proven kernel" "$OUT"
pick "$T/other"
[ "$(result)" = "xz|-comp xz" ] && ok "an unproven kernel with no config -> xz" || bad "unproven kernel" "$OUT"
printf '%s\n' "$OUT" | grep -q 'not one proven' && ok "  and it says why" || bad "xz reason" "$OUT"
pick "$T/rebuilt"
[ "$(result)" = "xz|-comp xz" ] && ok "same release, different build -> xz" || bad "rebuilt kernel" "$OUT"
pick "$T/garbage"
[ "$(result)" = "xz|-comp xz" ] && ok "an unreadable kernel image -> xz" || bad "garbage" "$OUT"
pick "$T/missing"
[ "$(result)" = "xz|-comp xz" ] && ok "no kernel image at all -> xz" || bad "missing" "$OUT"

echo "the build log names the exact kernel image it read"
# A layer built OFF the stick (Docker on the PC) was judged against a copy of
# the ISO's vmlinuz, not the stick's own. The log must carry that image's
# sha256 so it can be compared with E:\casper\vmlinuz before the layer goes on.
want_sha=$(sha256sum "$T/proven" | cut -d' ' -f1)
pick "$T/proven"
printf '%s\n' "$OUT" | grep -q "kernel image sha256: $want_sha" \
  && ok "the guard prints the sha256 of the vmlinuz it judged" || bad "vmlinuz sha256 in the log" "$OUT"
pick "$T/missing"
printf '%s\n' "$OUT" | grep -q "kernel image sha256: " && bad "no sha256 for a missing image" "$OUT" \
  || ok "  and none for an image that is not there"

echo "a /boot/config for that release is the authority"
printf 'CONFIG_SQUASHFS=y\nCONFIG_SQUASHFS_XZ=y\nCONFIG_SQUASHFS_LZ4=y\n' > "$R/boot/config-6.8.0-31-generic"
pick "$T/other"
[ "$(result)" = "lz4|-comp lz4 -Xhc" ] && ok "unlisted kernel, config has both =y -> lz4" || bad "config y" "$OUT"
printf 'CONFIG_SQUASHFS=y\nCONFIG_SQUASHFS_LZ4=m\n' > "$R/boot/config-6.8.0-31-generic"
pick "$T/other"
[ "$(result)" = "xz|-comp xz" ] && ok "SQUASHFS_LZ4=m (a module) -> xz" || bad "config m" "$OUT"
printf 'CONFIG_SQUASHFS=m\nCONFIG_SQUASHFS_LZ4=y\n' > "$R/boot/config-6.8.0-31-generic"
pick "$T/other"
[ "$(result)" = "xz|-comp xz" ] && ok "SQUASHFS=m -> xz" || bad "squashfs m" "$OUT"
printf 'CONFIG_SQUASHFS=y\n# CONFIG_SQUASHFS_LZ4 is not set\n' > "$R/boot/config-6.11.0-17-generic"
pick "$T/proven"
[ "$(result)" = "xz|-comp xz" ] && ok "a config saying NO beats the proven list -> xz" || bad "config overrides list" "$OUT"
rm -f "$R"/boot/config-*

echo "ALS_LAYER_COMP"
ALS_LAYER_COMP=xz; pick "$T/proven"; unset ALS_LAYER_COMP
[ "$(result)" = "xz|-comp xz" ] && ok "=xz opts out even on the proven kernel" || bad "opt-out" "$OUT"
ALS_LAYER_COMP=lz4; pick "$T/proven"; unset ALS_LAYER_COMP
[ "$(result)" = "lz4|-comp lz4 -Xhc" ] && ok "=lz4 on the proven kernel -> lz4" || bad "lz4 proven" "$OUT"
ALS_LAYER_COMP=lz4; pick "$T/other"; unset ALS_LAYER_COMP
[ "$RC" != "0" ] && [ -z "$(result)" ] && ok "=lz4 on an unproven kernel STOPS the build (no silent fallback)" \
  || bad "lz4 forced unproven" "rc=$RC $OUT"
for w in zstd gzip XZ "lz4 " bogus; do
  ALS_LAYER_COMP="$w"; pick "$T/proven"; unset ALS_LAYER_COMP
  [ "$RC" != "0" ] && [ -z "$(result)" ] && printf '%s\n' "$OUT" | grep -q 'not a compressor this build knows' \
    && ok "='$w' is refused" || bad "unknown compressor '$w'" "rc=$RC $OUT"
done

echo "the superblock read-back"
mksb() {  # mksb <file> <compression id> <block size>
  head -c 96 /dev/zero > "$1"
  printf 'hsqs' | dd of="$1" bs=1 seek=0 conv=notrunc 2>/dev/null
  # 131072 = 0x00020000, little-endian
  case "$3" in
    131072)  printf '\000\000\002\000' | dd of="$1" bs=1 seek=12 conv=notrunc 2>/dev/null ;;
    1048576) printf '\000\000\020\000' | dd of="$1" bs=1 seek=12 conv=notrunc 2>/dev/null ;;
  esac
  case "$2" in
    4) printf '\004\000' | dd of="$1" bs=1 seek=20 conv=notrunc 2>/dev/null ;;
    5) printf '\005\000' | dd of="$1" bs=1 seek=20 conv=notrunc 2>/dev/null ;;
    6) printf '\006\000' | dd of="$1" bs=1 seek=20 conv=notrunc 2>/dev/null ;;
  esac
}
mksb "$T/sb-lz4" 5 131072; mksb "$T/sb-xz" 4 131072; mksb "$T/sb-zstd1m" 6 1048576
[ "$(als_squashfs_comp "$T/sb-lz4")" = "5 131072" ] && ok "lz4 superblock -> '5 131072'" || bad "sb lz4" "$(als_squashfs_comp "$T/sb-lz4")"
[ "$(als_squashfs_comp "$T/sb-xz")" = "4 131072" ] && ok "xz superblock -> '4 131072'" || bad "sb xz" "$(als_squashfs_comp "$T/sb-xz")"
[ "$(als_squashfs_comp "$T/sb-zstd1m")" = "6 1048576" ] && ok "zstd 1M superblock -> '6 1048576'" || bad "sb zstd" "$(als_squashfs_comp "$T/sb-zstd1m")"
als_squashfs_comp "$T/garbage" >/dev/null && bad "not a squashfs" "accepted" || ok "no hsqs magic -> refused"
[ "$(als_comp_id lz4)" = 5 ] && [ "$(als_comp_id xz)" = 4 ] && ok "ids: xz 4, lz4 5" || bad "als_comp_id" "$(als_comp_id lz4) $(als_comp_id xz)"
if command -v mksquashfs >/dev/null 2>&1; then
  mkdir -p "$T/tree/usr"; head -c 300000 /dev/urandom > "$T/tree/usr/blob"
  for c in xz lz4; do
    ALS_LAYER_COMP=$c; als_pick_layer_comp "$T/proven" "$R" >/dev/null; unset ALS_LAYER_COMP
    # shellcheck disable=SC2086
    mksquashfs "$T/tree" "$T/real-$c.sqfs" -noappend -no-progress $LAYER_COMP_ARGS -b "$ALS_SQUASH_BLOCK" >/dev/null 2>&1
    got=$(als_squashfs_comp "$T/real-$c.sqfs")
    [ "$got" = "$(als_comp_id $c) 131072" ] && ok "a real mksquashfs $c image reads back '$got'" || bad "real $c" "'$got'"
  done
else
  echo "  (mksquashfs not installed - real-image read-back skipped)"
fi

echo "room on the stick before the layer is copied over the old one"
# lz4 makes the layer ~52 MB bigger. cp truncates the old file and then
# writes: running out of space part-way leaves a truncated layer that grub.cfg
# still names. The build must refuse BEFORE touching the old file.
if command -v als_stick_room >/dev/null 2>&1; then
  mkdir -p "$T/stick"
  head -c 3000 /dev/zero > "$T/new.sqfs"         # the new layer: 3000 bytes
  head -c 1000 /dev/zero > "$T/stick/layer"      # the old layer on the stick: 1000 bytes
  room() {  # room <free KiB> [margin bytes] -> RC, OUT
    FREE_K=$1
    OUT=$( ( df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 1 1 %s 1%% /x\n' "$FREE_K"; }
             ALS_STICK_MARGIN=${2:-0} als_stick_room "$T/stick/layer" "$T/new.sqfs" ) 2>&1 ); RC=$?
  }
  room 2; [ "$RC" = 0 ] && ok "2 KiB free + the old 1000 bytes >= 3000 bytes -> copy" || bad "enough room" "rc=$RC $OUT"
  room 1; [ "$RC" != 0 ] && ok "1 KiB free + 1000 bytes < 3000 bytes -> refused" || bad "too little room" "rc=$RC $OUT"
  printf '%s\n' "$OUT" | grep -q 'not enough room' && ok "  and it says so" || bad "room message" "$OUT"
  room 2 4096; [ "$RC" != 0 ] && ok "the safety margin counts" || bad "margin" "rc=$RC $OUT"
  rm -f "$T/stick/layer"
  room 2; [ "$RC" != 0 ] && ok "no old layer to replace: 2 KiB free < 3000 bytes -> refused" || bad "no old layer" "rc=$RC $OUT"
  room 3; [ "$RC" = 0 ] && ok "no old layer, 3 KiB free -> copy" || bad "no old layer, room" "rc=$RC $OUT"
  room ""; [ "$RC" != 0 ] && ok "df unreadable -> refused, not guessed" || bad "df unreadable" "rc=$RC $OUT"
else
  bad "make-als-layer.sh defines als_stick_room" "missing"
fi

echo "do_build wiring"
L=$HERE/make-als-layer.sh
ln_room=$(grep -n '^  als_stick_room "\$CASPER/\$LAYER_FILE" "\$OUT"' "$L" | head -1 | cut -d: -f1)
ln_cp=$(grep -n '^  cp "\$OUT" "\$CASPER/\$LAYER_FILE"' "$L" | head -1 | cut -d: -f1)
# the media_rw that makes the stick writable for THAT copy (the last before it)
ln_rw=$(grep -n '^  media_rw$' "$L" | awk -F: -v c="${ln_cp:-0}" '$1 < c {n = $1} END {print n}')
[ -n "$ln_room" ] && [ -n "$ln_rw" ] && [ -n "$ln_cp" ] && [ "$ln_room" -lt "$ln_rw" ] && [ "$ln_rw" -lt "$ln_cp" ] \
  && ok "the room check ($ln_room) runs before the stick is made writable and the copy ($ln_cp)" \
  || bad "room check wiring" "room=$ln_room rw=$ln_rw cp=$ln_cp"
grep -q -- '-comp xz -b 131072' "$L" && bad "no hard-coded xz" "$(grep -n -- '-comp xz -b 131072' "$L")" \
  || ok "mksquashfs no longer hard-codes -comp xz"
grep -q '^  mksquashfs "\$STAGE" "\$OUT" -noappend -no-progress \$LAYER_COMP_ARGS -b "\$ALS_SQUASH_BLOCK"' "$L" \
  && ok "mksquashfs uses the chosen compressor and 128K blocks" || bad "mksquashfs line" "$(grep -n '^  mksquashfs' "$L")"
ln_pick=$(grep -n '^  als_pick_layer_comp "\$CASPER/vmlinuz"' "$L" | head -1 | cut -d: -f1)
ln_fetch=$(grep -n 'step "Fetching packages' "$L" | head -1 | cut -d: -f1)
ln_squash=$(grep -n '^  mksquashfs "\$STAGE"' "$L" | head -1 | cut -d: -f1)
ln_sb=$(grep -n '^  sb=\$(als_squashfs_comp "\$OUT")' "$L" | head -1 | cut -d: -f1)
ln_mount=$(grep -n '^  mount -t squashfs -o loop,ro "\$OUT"' "$L" | head -1 | cut -d: -f1)
if [ -n "$ln_pick" ] && [ -n "$ln_fetch" ] && [ -n "$ln_squash" ] && [ -n "$ln_sb" ] && [ -n "$ln_mount" ] \
   && [ "$ln_pick" -lt "$ln_fetch" ] && [ "$ln_squash" -lt "$ln_sb" ] && [ "$ln_sb" -lt "$ln_mount" ]; then
  ok "chosen before any download ($ln_pick), superblock checked ($ln_sb), then the mount check ($ln_mount)"
else
  bad "ordering" "pick=$ln_pick fetch=$ln_fetch squash=$ln_squash sb=$ln_sb mount=$ln_mount"
fi
grep -q 'superblock reads' "$L" && ok "a superblock that does not match stops the build" || bad "sb die" "missing"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
