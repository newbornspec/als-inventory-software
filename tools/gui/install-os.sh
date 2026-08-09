#!/usr/bin/env bash
#
# ALS Audit Station — OS install driver (Clonezilla image restore).
#
# Usage:  install-os.sh <image_id> <target_device>
#   <image_id>       a directory name under the images root (a Clonezilla image)
#   <target_device>  whole-disk device, e.g. /dev/sda or /dev/nvme0n1
#
# Streams human-readable progress on stdout and finishes with one machine line:
#   INSTALL_RESULT {"status":"installed|failed","message":"…","device":"…"}
#
# This is the pluggable install driver: the backend only knows this contract,
# so swapping restore engines later touches nothing else. It restores a
# Clonezilla whole-disk image with ocs-sr (partclone under the hood), reinstalls
# the bootloader and resizes the last partition to fill the drive.
#
# NOTE: needs validation on real hardware. Requires Clonezilla's `ocs-sr`, which
# SystemRescue does NOT ship by default — see USB-SETUP for adding it (or boot a
# Clonezilla-based live image). Removable/USB targets are refused so the boot
# stick is never overwritten.
set -u

IMG="${1:-}"
DEV="${2:-}"
IMAGES_ROOT="${ALS_IMAGES_ROOT:-}"

result_fail() {
  # Strip the characters that would break the JSON result line — the message
  # now carries real engine output, which contains quotes and newlines.
  local msg
  msg=$(printf '%s' "$1" | tr -d '"\\' | tr '\n\r' '  ')
  echo "INSTALL_RESULT {\"status\":\"failed\",\"message\":\"$msg\",\"device\":\"$DEV\"}"
  exit 1
}

# Locate the images root (USB boot mount first, then ../images next to gui/).
if [ -z "$IMAGES_ROOT" ]; then
  for d in /mnt/als-images /run/archiso/bootmnt/images /cdrom/images /mnt/usb/images \
           "$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/images"; do
    [ -d "$d" ] && IMAGES_ROOT="$d" && break
  done
fi

[ -n "$IMG" ] || result_fail "no image selected"
[ -n "$IMAGES_ROOT" ] && [ -d "$IMAGES_ROOT/$IMG" ] || result_fail "image not found: $IMG"
[ -n "$DEV" ] && [ -b "$DEV" ] || result_fail "no such target device: $DEV"

# Safety: never write to the boot media / any removable disk.
kname="${DEV#/dev/}"
if [ "$(cat "/sys/block/$kname/removable" 2>/dev/null)" = "1" ]; then
  result_fail "refusing removable device $DEV"
fi
# The removable check above silently passes for a partition (there is no
# /sys/block/nvme0n1p3), and restoring a whole-disk image onto one partition
# produces a machine that will not boot. Insist on a whole disk.
[ -d "/sys/block/$kname" ] || result_fail "$DEV is not a whole disk"

command -v ocs-sr >/dev/null 2>&1 || \
  result_fail "Clonezilla (ocs-sr) is not installed on this boot media"

echo "Preparing to restore image '$IMG' to $DEV …"

# Clonezilla looks for images under /home/partimag — bind our repo there.
# A bind left over from a cancelled run would silently shadow the real library
# (the umount below is skipped when the backend kills the process group), so
# unstack any previous ones first.
mkdir -p /home/partimag
for _ in 1 2 3; do umount /home/partimag 2>/dev/null || break; done
mount --bind "$IMAGES_ROOT" /home/partimag 2>/dev/null || true

# Assert the image is actually visible where Clonezilla will look for it. This
# used to be swallowed by `|| true` and only surfaced much later as a generic
# restore failure.
[ -d "/home/partimag/$IMG" ] || \
  result_fail "image $IMG is not visible at /home/partimag (bind mount failed)"
[ -s "/home/partimag/$IMG/clonezilla-img" ] || \
  result_fail "image $IMG looks incomplete (no clonezilla-img) — recapture it"

# partclone paints progress with ncurses onto a terminal that does not exist
# here (the backend runs this script through a pipe), which is why a healthy
# restore used to look frozen. Ask for plain text where the flag is supported —
# probed, not assumed, because an older ocs-sr aborts on an unknown flag.
NOGUI=""
ocs-sr --help 2>&1 | grep -q -- '-nogui' && NOGUI="-nogui"

# Unattended whole-disk restore:
#   -e1 auto  fix NTFS boot geometry     -e2      sfdisk geometry from image
#   -r        resize last partition      -j2      restore hidden data between MBR/1st part
#   -p true   do nothing when finished   -batch   non-interactive
#   -scr      SKIP Clonezilla's pre-restore "is this image restorable?" check.
#             (It is NOT "no screensaver" — that comment was wrong for a long
#             time.) Kept for speed, which is only safe because images are
#             verified once on the server after capture with `zstd -t` /
#             `ocs-chkimg`. If that ever stops happening, drop this flag.
#   restoredisk <image> <disk-kernel-name>   whole disk, never a partition
OUT="/tmp/als-install.$$.out"
: > "$OUT"
ocs-sr -e1 auto -e2 -r -j2 -scr $NOGUI -p true -batch restoredisk "$IMG" "$kname" \
  > "$OUT" 2>&1 &
pid=$!
start=$(date +%s)

# Heartbeat. ocs-sr can print nothing for the entire duration of a large NTFS
# partition, so without this the panel looks dead and a working restore is
# indistinguishable from a failed one. Same approach as run_overwrite() in
# hardware-audit.sh. Prints when the engine's last line changes, plus a
# keepalive every 30s so the operator always sees the clock moving.
last_line=""; ticks=0
while kill -0 "$pid" 2>/dev/null; do
  sleep 5
  ticks=$(( ticks + 1 ))
  now=$(date +%s); el=$(( now - start ))
  line=$(tr '\r' '\n' < "$OUT" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -n1)
  line="${line:-restoring …}"
  if [ "$line" != "$last_line" ] || [ $(( ticks % 6 )) -eq 0 ]; then
    printf '    [%02d:%02d:%02d] %s\n' $(( el/3600 )) $(( (el%3600)/60 )) $(( el%60 )) "$line"
    last_line="$line"
  fi
done
wait "$pid"; rc=$?

umount /home/partimag 2>/dev/null || true

if [ "$rc" = "0" ]; then
  tr '\r' '\n' < "$OUT" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -n 20
  rm -f "$OUT"
  echo "Restore finished."
  echo "INSTALL_RESULT {\"status\":\"installed\",\"message\":\"restored $IMG\",\"device\":\"$DEV\"}"
  exit 0
fi

# Failure: dump the files that actually explain it. Clonezilla deletes
# /tmp/unzip_cmd_error.* the moment it exits, so this is the only chance to
# read the decompressor's own words — that is where a corrupt or truncated
# image announces itself. Previously all of this was thrown away and the
# operator got "ocs-sr restore failed" and nothing else.
echo "--- restore output (last 30 lines) ---"
tr '\r' '\n' < "$OUT" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -n 30
echo "--- decompressor stderr (zstd) ---"
cat /tmp/unzip_cmd_error.* 2>/dev/null || echo "(none)"
echo "--- partclone.log (last 30) ---"
tail -n 30 /var/log/clonezilla/partclone.log 2>/dev/null || echo "(none)"
echo "--- clonezilla.log (last 30) ---"
tail -n 30 /var/log/clonezilla/clonezilla.log 2>/dev/null || echo "(none)"

err=$(tr '\r' '\n' < "$OUT" 2>/dev/null | grep -v '^[[:space:]]*$' \
      | grep -iE 'error|failed|no space|cannot|invalid|corrupt|truncated|denied|premature' \
      | tail -n1)
rm -f "$OUT"
result_fail "restore failed on $DEV (exit $rc)${err:+ — $err}"
