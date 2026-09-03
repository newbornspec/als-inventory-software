#!/usr/bin/env bash
#
# Build (and optionally arm) the ALS overlay layer for the Ubuntu audit stick.
#
# WHAT THIS SOLVES
#   1. The kiosk does not start by itself. SystemRescue ran autorun/autorun at
#      boot; Ubuntu's casper has no such hook, so the operator has had to type
#      `bash /cdrom/gui/start-gui.sh` every time.
#   2. The live session is amnesiac. Every `apt install nvme-cli` is thrown away
#      at reboot - and without nvme-cli an NVMe drive cannot be secure-erased,
#      which is most of what comes through the door.
#
# HOW IT WORKS - and this was read out of THIS STICK'S OWN INITRD, not from
# documentation, because most of what is written about casper online is wrong
# for 24.04.
#
#   casper does NOT glob /casper/*.squashfs. Layer selection is driven by one
#   variable, set in the initrd at /conf/conf.d/default-layer.conf:
#
#       LAYERFS_PATH=minimal.standard.live.squashfs
#
#   setup_overlay() builds the stack by repeatedly stripping the last
#   dot-component off that basename, so today it mounts, lowest first:
#
#       minimal.squashfs -> minimal.standard.squashfs -> minimal.standard.live.squashfs
#
#   and the LONGEST name ends up leftmost in lowerdir, i.e. HIGHEST priority.
#   A kernel parameter `layerfs-path=` overrides the variable.
#
#   So a layer named minimal.standard.live.als.squashfs extends that chain and
#   sits on top of everything. Files in it are simply part of the root
#   filesystem from the first second of boot.
#
# THE NAMING TRAP - the reason this script refuses to be talked out of the name.
#   The chain only walks UP, by stripping components. Call the layer
#   als.squashfs and the chain is just "als": casper would mount our few
#   hundred kilobytes AS THE ENTIRE ROOT, find no /sbin/init, and panic. The
#   name MUST extend a chain whose every ancestor already exists.
#
# WHY THIS IS SAFE TO BUILD BEFORE YOU COMMIT TO IT
#   Copying the layer onto the stick does NOTHING until grub.cfg names it,
#   because default-layer.conf keeps LAYERFS_PATH pointed at the stock chain
#   and the glob branch is dead code on this image. So `build` is inert and
#   `arm` is the only step that changes how the machine boots. They are
#   deliberately separate.
#
# RUN THIS FROM THE UBUNTU LIVE SESSION on the audit machine. mksquashfs does
# not exist on Windows, and the packages have to be fetched for this release.
#
#   bash /cdrom/make-als-layer.sh build     # packages only - the safe half
#   bash /cdrom/make-als-layer.sh build --with-autostart   # + kiosk autostart
#   bash /cdrom/make-als-layer.sh arm       # edits grub.cfg - reboots into the kiosk
#   bash /cdrom/make-als-layer.sh undo      # removes both
#   bash /cdrom/make-als-layer.sh status
#
set -u

# The name is not configurable, for the reason in the header.
LAYER_NAME="minimal.standard.live.als"
LAYER_FILE="${LAYER_NAME}.squashfs"
PARENT="minimal.standard.live.squashfs"

# Packages baked into the layer. Unpacked with `dpkg -x`, which lays out the
# files without running maintainer scripts - right for self-contained CLI tools,
# which is what all of these are.
# smartmontools is NOT in this image - checked against every casper manifest -
# and hardware-audit.sh shells out to smartctl four times, so today that comes
# down the wire on every boot. cage is deliberately NOT here: start-gui.sh only
# reaches the cage path when there is no graphical session, and an XDG autostart
# entry guarantees there is one, so it would be dead weight pulling wlroots.
PACKAGES="${ALS_PACKAGES:-nvme-cli smartmontools partclone pigz}"

say()  { printf '%s\n' "$*"; }
die()  { printf '\n  !!  %s\n\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

[ "$(id -u)" = "0" ] || die "Run this with sudo - it writes to the boot medium."

# --- locate the stick -------------------------------------------------------
SELF_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
MEDIA=""
if [ -r "$SELF_DIR/find-media.sh" ]; then
  . "$SELF_DIR/find-media.sh"; MEDIA=$(als_find_media 2>/dev/null)
fi
[ -n "$MEDIA" ] || for d in /cdrom /isodevice /run/archiso/bootmnt; do
  [ -f "$d/hardware-audit.sh" ] && { MEDIA="$d"; break; }
done
[ -n "$MEDIA" ] || die "Could not find the audit media. Is this booted from the stick?"

CASPER="$MEDIA/casper"
GRUB="$MEDIA/boot/grub/grub.cfg"
[ -d "$CASPER" ] || die "$CASPER does not exist - this is not the Ubuntu stick."
[ -f "$CASPER/$PARENT" ] || die "$PARENT is missing. The layer chain would break; refusing."

# The stick is mounted read-only. Put it back that way whatever happens.
REMOUNTED=0
media_rw() {
  mount -o remount,rw "$MEDIA" 2>/dev/null && REMOUNTED=1 && return 0
  die "Could not remount $MEDIA read-write."
}
media_ro() { [ "$REMOUNTED" = "1" ] && { sync; mount -o remount,ro "$MEDIA" 2>/dev/null; REMOUNTED=0; }; }
trap media_ro EXIT

# --- build ------------------------------------------------------------------
do_build() {
  command -v mksquashfs >/dev/null 2>&1 || {
    step "Installing squashfs-tools (needs internet)"
    apt-get update -qq >/dev/null 2>&1
    apt-get install -y -qq squashfs-tools >/dev/null 2>&1
  }
  command -v mksquashfs >/dev/null 2>&1 || die "mksquashfs is still missing - connect to the network and retry."

  STAGE=$(mktemp -d) || die "mktemp failed"
  trap 'rm -rf "$STAGE"; media_ro' EXIT

  # 0755, and this is not cosmetic. mktemp -d creates the directory 0700, and
  # mksquashfs faithfully preserves that as the ROOT directory of the layer.
  # Overlayfs takes a merged directory's ownership and mode from the TOPMOST
  # layer - which is ours - so "/" on the booted system became drwx------ root
  # root. No non-root user could traverse it, GDM never started, and the
  # machine stopped at a text console right after plymouth quit, with nothing
  # anywhere saying why.
  chmod 0755 "$STAGE" || die "could not chmod the staging directory"

  if [ "$WANT_AUTOSTART" = "0" ]; then
    say ""
    say "  Packages only: no autostart entry, no installer mask."
    say "  Nothing in this layer touches how the desktop session starts."
  else
  step "Staging the autostart entry"
  mkdir -p "$STAGE/etc/xdg/autostart"
  cat > "$STAGE/etc/xdg/autostart/als-audit-station.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=ALS Audit Station
Comment=Starts the audit kiosk automatically on the live desktop
Exec=/bin/bash -lc 'for d in /cdrom /isodevice /run/archiso/bootmnt /media/*/*; do [ -f "$d/gui/start-gui.sh" ] && exec bash "$d/gui/start-gui.sh"; done'
Terminal=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=3
NoDisplay=false
DESKTOP
  say "  /etc/xdg/autostart/als-audit-station.desktop"

  # Ubuntu launches "Try or Install Ubuntu" as a systemd USER unit every
  # graphical session:
  #     /etc/systemd/user/graphical-session.target.wants/ubuntu-desktop-installer.service
  #       -> /lib/systemd/user/ubuntu-desktop-installer.service
  #       ExecStart=/snap/bin/ubuntu-desktop-bootstrap --try-or-install
  # An autostart entry on its own therefore gives you the kiosk AND the
  # installer fighting for focus. A symlink to /dev/null at the /etc path is
  # systemd's own mask idiom and outranks the /lib unit. /etc/systemd/user/ in
  # the live layer holds nothing but graphical-session.target.wants, so there is
  # nothing here to collide with. If the mask somehow fails the installer simply
  # appears, which is today's behaviour - no new risk.
  step "Masking the Ubuntu installer window"
  mkdir -p "$STAGE/etc/systemd/user"
  ln -sf /dev/null "$STAGE/etc/systemd/user/ubuntu-desktop-installer.service"
  say "  ubuntu-desktop-installer.service -> /dev/null (masked)"
  fi

  # Gate: every package must be a NEW install. Our layer outranks the base, so
  # an "upgraded" package would silently shadow a library the running system is
  # already using - a way to break the desktop that would look nothing like this
  # script when it surfaced.
  step "Checking the packages only ADD (nothing upgraded)"
  plan=$(apt-get install -s --no-install-recommends $PACKAGES 2>/dev/null | grep -E '^[0-9]+ upgraded')
  say "  $plan"
  case "$plan" in
    0\ upgraded*) : ;;
    '') say "  (could not simulate - no package lists? continuing without the gate)" ;;
    *) die "Some package would be UPGRADED, not added: $plan
      Baking it in would shadow a library the live system already uses.
      Drop it from ALS_PACKAGES and re-run." ;;
  esac

  step "Fetching packages: $PACKAGES"
  DEBS="$STAGE/.debs"; mkdir -p "$DEBS"
  ( cd "$DEBS" && apt-get download $PACKAGES >/dev/null 2>&1 )
  got=0
  for deb in "$DEBS"/*.deb; do
    [ -f "$deb" ] || continue
    dpkg -x "$deb" "$STAGE" 2>/dev/null && { got=$((got+1)); say "  unpacked $(basename "$deb")"; }
  done
  rm -rf "$DEBS"
  if [ "$got" = "0" ]; then
    say "  none fetched - no internet? The layer will still carry the autostart."
    say "  Re-run with a connection to bake the tools in."
  else
    say "  $got package(s) baked in"
  fi

  # xz at 128K blocks, because that is what the three layers already on the
  # stick use - their superblocks all read compression id 4, block_size 131072.
  # This is not cosmetic: squashfs decompressor support is per-compressor in the
  # kernel config, and xz is the only one PROVEN present here, since the running
  # system is mounted from it. A layer the kernel cannot decompress does not
  # degrade, it panics the boot.
  step "Building $LAYER_FILE (xz, 128K blocks, matching the stock layers)"
  OUT="$STAGE.squashfs"
  mksquashfs "$STAGE" "$OUT" -noappend -no-progress -comp xz -b 131072 >/dev/null 2>&1 \
    || die "mksquashfs failed"

  # Prove it mounts BEFORE putting it anywhere near the boot chain.
  step "Verifying the layer mounts"
  MP=$(mktemp -d)
  mount -t squashfs -o loop,ro "$OUT" "$MP" 2>/dev/null || { rmdir "$MP"; die "The layer does not mount - refusing to install it."; }
  fail=""
  if [ "$WANT_AUTOSTART" != "0" ]; then
    [ -f "$MP/etc/xdg/autostart/als-audit-station.desktop" ] || fail="the autostart entry is missing"
  fi

  # Check the MODE of every directory we ship, not just that our files exist.
  # A directory here shadows the real one on the booted system, so one that is
  # not world-traversable locks every non-root process out of that path - and
  # at "/" that means the desktop never starts. This is the check that would
  # have caught the 0700 staging root before it reached a machine.
  if [ -z "$fail" ]; then
    bad=$(find "$MP" -type d ! -perm -0005 2>/dev/null | head -5)
    [ -n "$bad" ] && fail="these directories are not world-traversable and would lock the system out of them:
$(printf '%s' "$bad" | sed "s|^$MP|  |")"
  fi
  umount "$MP"; rmdir "$MP"
  [ -n "$fail" ] && die "The layer mounted but $fail"
  say "  mounts clean, autostart present, every directory traversable"

  step "Copying onto the stick"
  media_rw
  cp "$OUT" "$CASPER/$LAYER_FILE" || die "copy failed"
  sync
  media_ro
  say "  $CASPER/$LAYER_FILE  ($(du -h "$CASPER/$LAYER_FILE" 2>/dev/null | cut -f1))"

  cat <<EOF

  Built, and INERT. casper will not look at it until grub.cfg names it, so
  nothing about this boot has changed. Verify it is there, then:

      sudo bash $0 arm

EOF
}

# --- arm --------------------------------------------------------------------
do_arm() {
  [ -f "$CASPER/$LAYER_FILE" ] || die "$LAYER_FILE is not on the stick yet. Run 'build' first."
  [ -f "$GRUB" ] || die "$GRUB not found."
  grep -q 'layerfs-path=' "$GRUB" && { say "Already armed."; return 0; }

  # Re-check the layer here, not just at build time. A layer built by an older
  # copy of this script can be sitting on the stick already - and the first one
  # that shipped had a 0700 root, which made "/" untraversable for every
  # non-root process and stopped the machine at a text console just after
  # plymouth, with no error pointing anywhere near here. Arming is the step that
  # can cost a boot, so it verifies rather than assumes.
  step "Re-checking the layer before arming"
  MP=$(mktemp -d)
  mount -t squashfs -o loop,ro "$CASPER/$LAYER_FILE" "$MP" 2>/dev/null \
    || { rmdir "$MP"; die "The layer on the stick does not mount. Rebuild it: $0 build"; }
  bad=$(find "$MP" -type d ! -perm -0005 2>/dev/null | head -5)
  umount "$MP"; rmdir "$MP"
  if [ -n "$bad" ]; then
    die "This layer has directories that are not world-traversable:
$(printf '%s' "$bad" | sed "s|^$MP|  |")
      Booting it would leave the machine at a text console with no desktop.
      It was built by an older version of this script. Rebuild it:
          $0 build"
  fi
  say "  mounts clean, every directory traversable"

  media_rw
  [ -f "$MEDIA/boot/grub/grub.cfg.als-orig" ] || cp "$GRUB" "$MEDIA/boot/grub/grub.cfg.als-orig"

  # parse_cmdline() loops the whole /proc/cmdline, so this works either side of
  # the '---'. It goes before it, next to the other casper parameters.
  sed -i "s|\(linux\t*/casper/vmlinuz\)|\1 layerfs-path=$LAYER_FILE|" "$GRUB" || die "sed failed"
  sync
  n=$(grep -c "layerfs-path=$LAYER_FILE" "$GRUB")
  media_ro
  [ "$n" -ge 1 ] || die "grub.cfg was not modified - check it by hand."

  cat <<EOF

  Armed - $n boot entr(y/ies) now load the ALS layer. Reboot and the kiosk
  should come up on its own.

  If it does NOT boot, from any machine that can read the stick:
      delete  casper/$LAYER_FILE
      restore boot/grub/grub.cfg  from  boot/grub/grub.cfg.als-orig
  Or from a live session:  sudo bash $0 undo

EOF
}

do_undo() {
  media_rw
  [ -f "$CASPER/$LAYER_FILE" ] && { rm -f "$CASPER/$LAYER_FILE"; say "removed $LAYER_FILE"; }
  # Take out exactly what arm put in, and nothing else.
  #
  # This used to copy grub.cfg.als-orig over the top instead. That backup is of
  # the file as it was before ANY ALS edit, so a single undo also silently
  # reverted the menu timeout from 3 seconds back to 30 - an unrelated change
  # that had nothing to do with the layer, and which came back without a word
  # about it. A backup taken for one purpose is not a general undo.
  #
  # grub.cfg.als-orig stays on the stick as the manual escape hatch for a
  # machine that will not boot at all; it is just no longer used routinely.
  if grep -q "layerfs-path=$LAYER_FILE" "$GRUB" 2>/dev/null; then
    sed -i "s| layerfs-path=$LAYER_FILE||g" "$GRUB"
    say "removed layerfs-path from grub.cfg (every other setting left alone)"
  else
    say "grub.cfg was not armed"
  fi
  sync; media_ro
  say "Undone. The stick boots exactly as it did before."
}

do_status() {
  say "media        : $MEDIA"
  say "parent layer : $([ -f "$CASPER/$PARENT" ] && echo present || echo MISSING)"
  say "ALS layer    : $([ -f "$CASPER/$LAYER_FILE" ] && du -h "$CASPER/$LAYER_FILE" | cut -f1 || echo 'not built')"
  say "armed        : $(grep -q "layerfs-path=$LAYER_FILE" "$GRUB" 2>/dev/null && echo yes || echo no)"
  say "grub backup  : $([ -f "$MEDIA/boot/grub/grub.cfg.als-orig" ] && echo present || echo none)"
}

# The layer has two halves and they carry very different risk.
#
#   packages          pure file additions. /usr/bin/nvme and friends appear in
#                     the filesystem. Nothing reads them at boot; nothing about
#                     the session changes.
#
#   autostart + mask  writes /etc/xdg/autostart and masks a systemd USER unit,
#                     i.e. it changes how the graphical session starts. Two
#                     attempts at this ended in a machine that reached no
#                     desktop - first a text console, then a blank screen.
#
# So they are separable, and the safe half is the default. Ask for the other
# half explicitly, knowing it is the part with a history.
WANT_AUTOSTART=0
case "${2:-}" in
  --with-autostart) WANT_AUTOSTART=1 ;;
  '') : ;;
  *) die "Unknown option: $2 (only --with-autostart)" ;;
esac

case "${1:-status}" in
  build)  do_build ;;
  arm)    do_arm ;;
  undo)   do_undo ;;
  status) do_status ;;
  *) die "Usage: $0 {build|arm|undo|status}" ;;
esac
