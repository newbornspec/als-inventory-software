#!/usr/bin/env bash
#
# Locate the ALS audit media, whatever live system booted.
#
# WHY THIS EXISTS
# SystemRescue (archiso) writes to a single FAT32 partition, so the tools sat at
# the root of the boot medium and /run/archiso/bootmnt always found them. An
# Ubuntu ISO written to USB is read-only ISO9660 — you cannot add files to it —
# so the tools live on a SECOND, writable partition instead, and the live system
# mounts that wherever it likes (or not at all).
#
# Four search strategies, cheapest first. Every one of them is read-only.
#
# Source it, then:   DIR=$(als_find_media) || echo "media not found"

ALS_MEDIA_LABEL="${ALS_MEDIA_LABEL:-ALSAUDIT}"

# A directory counts as the media if the audit script is in it.
als_is_media() { [ -n "$1" ] && [ -f "$1/hardware-audit.sh" ]; }

als_find_media() {
  local d

  # 1. Beside whatever sourced us. Correct whenever the tools are run from the
  #    stick directly, and the only strategy that works in a dev checkout.
  d=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)
  als_is_media "$d" && { printf '%s' "$d"; return 0; }

  # 2. The mountpoints live systems conventionally use.
  #    /run/archiso/bootmnt = SystemRescue; /cdrom + /isodevice = Ubuntu casper.
  for d in /run/archiso/bootmnt /cdrom /isodevice /mnt/usb /media/usb; do
    als_is_media "$d" && { printf '%s' "$d"; return 0; }
  done

  # 3. Anything already mounted under /media or /mnt — Ubuntu's desktop session
  #    auto-mounts the data partition there under a user-specific path.
  for d in /media/*/* /media/* /mnt/*; do
    als_is_media "$d" && { printf '%s' "$d"; return 0; }
  done

  # 4. Nothing mounted it: find the partition by LABEL and mount it ourselves,
  #    read-only. A bare live shell (no desktop session) auto-mounts nothing, so
  #    without this the GUI would not find its own files.
  command -v blkid >/dev/null 2>&1 || return 1
  local dev
  dev=$(blkid -L "$ALS_MEDIA_LABEL" 2>/dev/null)
  [ -n "$dev" ] || return 1
  mkdir -p /mnt/als-media 2>/dev/null || return 1
  mount -o ro "$dev" /mnt/als-media 2>/dev/null || return 1
  als_is_media /mnt/als-media && { printf '%s' /mnt/als-media; return 0; }
  umount /mnt/als-media 2>/dev/null
  return 1
}
