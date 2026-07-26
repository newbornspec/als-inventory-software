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
  echo "INSTALL_RESULT {\"status\":\"failed\",\"message\":\"$1\",\"device\":\"$DEV\"}"
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

command -v ocs-sr >/dev/null 2>&1 || \
  result_fail "Clonezilla (ocs-sr) is not installed on this boot media"

echo "Preparing to restore image '$IMG' to $DEV …"

# Clonezilla looks for images under /home/partimag — bind our repo there.
mkdir -p /home/partimag
mount --bind "$IMAGES_ROOT" /home/partimag 2>/dev/null || true

# Unattended whole-disk restore:
#   -e1 auto  fix NTFS boot geometry     -e2      sfdisk geometry from image
#   -r        resize last partition      -j2      restore hidden data between MBR/1st part
#   -scr      no screensaver             -p true  do nothing when finished
#   -batch    non-interactive            restoredisk <image> <disk-kernel-name>
if ocs-sr -e1 auto -e2 -r -j2 -scr -p true -batch restoredisk "$IMG" "$kname"; then
  umount /home/partimag 2>/dev/null || true
  echo "Restore finished."
  echo "INSTALL_RESULT {\"status\":\"installed\",\"message\":\"restored $IMG\",\"device\":\"$DEV\"}"
  exit 0
fi

umount /home/partimag 2>/dev/null || true
result_fail "ocs-sr restore failed on $DEV"
