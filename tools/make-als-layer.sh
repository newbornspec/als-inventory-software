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
# --with-autostart: THE HISTORY, because it cost three boots and the notes are
# worth more than the code.
#
#   attempt 1  text console after plymouth-quit.
#              CAUSE, FOUND AND FIXED: mktemp -d made the staging directory
#              0700 and mksquashfs preserved that as the layer's ROOT. Overlayfs
#              takes a merged directory's mode from the topmost layer, so "/"
#              became drwx------ and no non-root process could traverse it.
#              Build and arm both refuse such a layer now, and every directory
#              is normalised to 0755 before packing - not just "/", which is
#              what made this failure move rather than disappear.
#
#   attempt 2  blank lit panel. A DIFFERENT failure, which is how we know
#              attempt 1's fix was real.
#              HYPOTHESIS: start-gui.sh forces the display mode with xrandr.
#
#   attempt 3  blank lit panel again, with ALS_NO_FIT=1. HYPOTHESIS DEAD.
#
# WHAT THE INVESTIGATION THEN ESTABLISHED, by parsing the stick's own squashfs
# layers rather than reading documentation:
#
#   THE SESSION WAS PROBABLY NEVER DYING. On GNOME exactly one thing hides the
#   top bar AND the dock: a fullscreen window. start-gui.sh's session branch
#   runs Firefox --kiosk, which is precisely that, and a kiosk that maps but
#   never paints looks identical to a dead machine. It also explains attempt 3:
#   the kiosk still opened. Moderate confidence only - index.html's background
#   is near-white and the panel was grey-blue, and nobody could reconcile that.
#
#   THE INSTALLER MASK IS EXONERATED. The unit's PartOf and After point OUTWARD,
#   it is Type=oneshot Restart=no, and a grep of every unit, symlink target and
#   session file across all three layers finds exactly ONE reference to it.
#   Masking it cannot take a session down. It is no longer shipped - not because
#   it was guilty, but because an unexplained variable is not worth carrying for
#   a cosmetic win.
#
#   A THIRD VARIABLE NOBODY HAD LISTED. server.py's main() starts a boot thread
#   that sets the system clock with `date -u -s` and mounts the image server.
#   The working packages-only boot never ran server.py; all three failures did.
#   "Autostart versus mask" was the wrong framing from the start.
#
#   Terminal=true WOULD NOT HAVE HELPED. String-scanning gnome-session-binary
#   out of the image shows it honours X-GNOME-Autostart-enabled/-Phase/-Delay
#   and TryExec, and does NOT honour Terminal. Any design resting on it fails
#   silently.
#
#   THE TEXT-CONSOLE FAILURES WERE /lib, AND HAD NOTHING TO DO WITH AUTOSTART.
#   nvme-cli ships five units at literal /lib/systemd/system paths. /lib is a
#   SYMLINK to usr/lib on this image, and a directory in our layer replaces a
#   symlink below rather than merging with it - so /lib became five nvme files
#   and nothing else, and
#   /etc/systemd/system/display-manager.service -> /lib/systemd/system/gdm3.service
#   went dangling. No gdm, no desktop, text console. See the fold step in
#   do_build. The timing identifies it: a text console right after plymouth-quit
#   is a SYSTEM failure, before gnome-session exists to read any autostart entry.
#
#   AND THE COMPARISON THAT DROVE THREE ATTEMPTS WAS FALSE. "packages only
#   works, packages plus autostart fails" was never established, because
#   apt-get download is allowed to fetch nothing and the build continues. An
#   empty layer boots perfectly. That reconciles the whole history:
#       blank lit panel (attempts 2, 3)  = GNOME started = no /lib = nothing
#                                          downloaded = the Firefox kiosk
#       text console    (attempts 1,4,5) = /lib present = packages downloaded
#   The build now writes a manifest of exactly what went in, so the next
#   comparison is between two known things instead of two assumptions.
#
# SO THE CURRENT DESIGN DOES NOT DEPEND ON THE DIAGNOSIS BEING RIGHT. Nothing it
# starts can go fullscreen. Three files:
#
#   /etc/xdg/autostart/als-audit-station.desktop   in the layer, never changes
#   /usr/local/bin/als-autostart                   in the layer, never changes
#   gui/als-autostart.sh                           ON THE STICK, edit from Windows
#
# Everything tunable is on the FAT32 partition, so changing behaviour costs a
# file copy, not a mksquashfs rebuild and a reboot. Three boots went into that
# loop; it should never have been the unit of iteration.
#
# Default mode is `probe`: fire, log, notify that autostart works, start nothing
# else. Then `backend`, then `full` - a NORMAL browser window, never a kiosk.
# One word in gui/autostart.mode selects it; that file is deliberately not
# synced, so a sync cannot overwrite the operator's choice.
#
# WHAT EACH HALF IS WORTH. The autostart saves one command per boot:
#     bash /cdrom/gui/start-gui.sh
# The packages half - nvme-cli, smartmontools, partclone, pigz - saves a
# download on every boot and is what makes an offline NVMe erase possible at
# all. That half has never been implicated in any failure, and it is the
# default. Do not risk it to chase the other.
#
# RUN THIS FROM THE UBUNTU LIVE SESSION on the audit machine. mksquashfs does
# not exist on Windows, and the packages have to be fetched for this release.
#
#   bash /cdrom/make-als-layer.sh build     # packages only - the safe half
#   bash /cdrom/make-als-layer.sh build --with-autostart   # + app autostart
#   bash /cdrom/make-als-layer.sh build --with-session     # + kiosk SESSION,
#                                                         #   GNOME never draws
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
# libhivex-bin, ntfs-3g and tpm2-tools are NOT optional extras. Without them
# lock_win_blocked() returns UNKNOWN for Autopilot, Intune/MDM and Entra - the
# three checks the business actually sells on - and hardware-audit.sh only
# apt-installs them at runtime, which needs internet.
#
# So on an offline bench the commercially critical feature silently reported
# nothing, while the wipe tools were baked in and worked fine. That is exactly
# backwards: a machine can be re-wiped tomorrow, but a lock missed today is a
# device sold that bricks at the buyer's first OOBE.
#
# This is what the layer is FOR. The autostart was always the smaller prize.
# ntfs-3g is NOT here, and that is deliberate. It is ALREADY on the Ubuntu
# live image, so downloading it is an UPGRADE rather than an addition -
# baking it in would drop an older copy of ntfs-3g and libntfs-3g89t64 on
# top of the one the running system is already using. It was on this list
# only because ensure_tools() names it, and nobody had checked whether the
# image already had it. The lock checks mount NTFS with the stock copy.
PACKAGES="${ALS_PACKAGES:-nvme-cli smartmontools partclone pigz libhivex-bin tpm2-tools}"

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

  # ... and every directory underneath it, at the end of staging. Overlayfs
  # takes a merged directory's mode from the TOPMOST layer, which is ours - so
  # /etc, /etc/xdg, /etc/xdg/autostart and /usr/local/bin all inherit whatever
  # WE give them, overriding the stock 0755. The earlier fix corrected only "/",
  # which is why that failure moved from a text console to something shallower
  # rather than going away. See stage_perms below.

  if [ "$WANT_AUTOSTART" = "0" ]; then
    say ""
    say "  Packages only: no autostart entry, no installer mask."
    say "  Nothing in this layer touches how the desktop session starts."
  else
  # ALS_NO_FIT=1 and a 10-second delay, both for the same reason. start-gui.sh
  # normally forces the display to its highest mode with xrandr, which is
  # correct for a person running it on a settled desktop and wrong here: at
  # session start it races GNOME's own display setup, and losing that race
  # leaves a lit panel showing nothing while the desktop runs fine underneath.
  # That is the second failure this layer produced on real hardware.
  step "Staging the autostart entry"
  # Three files, and the split between them is the whole point.
  #
  #   /etc/xdg/autostart/als-audit-station.desktop   in the layer, never changes
  #   /usr/local/bin/als-autostart                   in the layer, never changes
  #   gui/als-autostart.sh                           ON THE STICK, edit from Windows
  #
  # Everything you might want to tune lives on the FAT32 partition, so changing
  # behaviour costs a file copy instead of a mksquashfs rebuild and a reboot.
  # Three boots were spent on that loop already.
  #
  # The .desktop Exec is ONE absolute path with no reserved characters. The old
  # one was a bash -lc one-liner containing ; $ * ' " and [ - all reserved by
  # the desktop-entry spec, unescaped, and read back through two layers of
  # unescaping. It may have survived; it had no business being relied on.
  #
  # NOT shipped any more: the ubuntu-desktop-installer mask. Reading the unit
  # out of the live layer settles it - PartOf and After point outward, it is
  # Type=oneshot Restart=no, and exactly one thing in the whole image references
  # it. Masking it cannot take a session down. It was never the cause, so it is
  # not worth carrying as an unexplained variable.
  for f in als-audit-station.desktop als-autostart-shim.sh; do
    [ -r "$SELF_DIR/gui/$f" ] || die "$SELF_DIR/gui/$f is missing - re-sync the stick."
  done
  mkdir -p "$STAGE/etc/xdg/autostart" "$STAGE/usr/local/bin"
  cp "$SELF_DIR/gui/als-audit-station.desktop" "$STAGE/etc/xdg/autostart/als-audit-station.desktop"
  cp "$SELF_DIR/gui/als-autostart-shim.sh"     "$STAGE/usr/local/bin/als-autostart"
  chmod 0755 "$STAGE/usr/local/bin/als-autostart"
  chmod 0644 "$STAGE/etc/xdg/autostart/als-audit-station.desktop"
  say "  /etc/xdg/autostart/als-audit-station.desktop"
  say "  /usr/local/bin/als-autostart (0755)"
  say "  behaviour lives on the stick at gui/als-autostart.sh - edit it from Windows"

  if [ "$WANT_SESSION" = "1" ]; then
    step "Staging the kiosk session"
    # Four files, and each one was checked against the real image rather than
    # against a desktop-install guide:
    #
    #   gdm3/custom.conf   every key UNCOMMENTED, so casper's 15autologin sed -
    #                      which is anchored to a leading '#' on all four of its
    #                      expressions - becomes a no-op and our file survives.
    #   AccountsService    uncontested: casper never references it and the stock
    #                      users/ directory is empty. This is what actually
    #                      picks the session for autologin.
    #   xsessions/         NOT wayland-sessions/. casper uncomments
    #                      WaylandEnable=false every live boot, so GDM runs X11
    #                      and a Wayland session file would never be offered.
    #   als-session        the launcher. Off unless gui/kiosk.mode says "on",
    #                      and every failure path ends in the stock desktop.
    for f in gdm3-custom.conf accountsservice-ubuntu als-kiosk.desktop als-session.sh; do
      [ -r "$SELF_DIR/gui/layer/$f" ] || die "$SELF_DIR/gui/layer/$f is missing - re-sync the stick."
    done
    mkdir -p "$STAGE/etc/gdm3" "$STAGE/var/lib/AccountsService/users" \
             "$STAGE/usr/share/xsessions" "$STAGE/usr/local/bin"
    cp "$SELF_DIR/gui/layer/gdm3-custom.conf"       "$STAGE/etc/gdm3/custom.conf"
    cp "$SELF_DIR/gui/layer/accountsservice-ubuntu" "$STAGE/var/lib/AccountsService/users/ubuntu"
    cp "$SELF_DIR/gui/layer/als-kiosk.desktop"      "$STAGE/usr/share/xsessions/als-kiosk.desktop"
    cp "$SELF_DIR/gui/layer/als-session.sh"         "$STAGE/usr/local/bin/als-session"
    chmod 0644 "$STAGE/etc/gdm3/custom.conf" "$STAGE/var/lib/AccountsService/users/ubuntu" \
               "$STAGE/usr/share/xsessions/als-kiosk.desktop"
    chmod 0755 "$STAGE/usr/local/bin/als-session"
    say "  /etc/gdm3/custom.conf"
    say "  /var/lib/AccountsService/users/ubuntu   (Session=als-kiosk)"
    say "  /usr/share/xsessions/als-kiosk.desktop"
    say "  /usr/local/bin/als-session (0755)"

    # The SHUTDOWN splash is a separate problem and is easy to miss.
    #
    # On the way up, plymouthd runs from /casper/initrd and reads its theme from
    # inside that initramfs - which is why the splash is delivered as a second
    # cpio archive appended on the GRUB initrd line. On the way DOWN, the
    # plymouth-reboot and plymouth-poweroff services run in the REAL root, and
    # by then plymouthd has chroot()ed into it. It reads the theme from there,
    # not from the initramfs. So a theme that exists only in the cpio gives the
    # ALS splash at boot and Ubuntu's logo at shutdown.
    #
    # Same theme, two places, one source: boot/dist/theme/ is written by
    # make-splash.py alongside the cpio.
    THEME_SRC="$SELF_DIR/boot/theme"
    [ -d "$THEME_SRC" ] || THEME_SRC="$SELF_DIR/boot/dist/theme"
    if [ -d "$THEME_SRC/usr/share/plymouth/themes/als" ]; then
      mkdir -p "$STAGE/usr/share/plymouth/themes"
      cp -a "$THEME_SRC/usr/share/plymouth/themes/als" "$STAGE/usr/share/plymouth/themes/"
      # bgrt is what plymouthd falls back to, so override it here as well - the
      # same belt-and-braces the boot archive uses.
      if [ -d "$THEME_SRC/usr/share/plymouth/themes/bgrt" ]; then
        cp -a "$THEME_SRC/usr/share/plymouth/themes/bgrt" "$STAGE/usr/share/plymouth/themes/"
      fi
      mkdir -p "$STAGE/etc/plymouth"
      printf '[Daemon]\nTheme=als\nShowDelay=0\n' > "$STAGE/etc/plymouth/plymouthd.conf"
      say "  /usr/share/plymouth/themes/als  (shutdown splash)"
    else
      say "  no theme at $THEME_SRC - shutdown will show Ubuntu's splash"
      say "  (run tools/boot/make-splash.py on Windows and re-sync to fix)"
    fi
    say ""
    say "  INERT until you switch it on. Put the word  on  in gui/kiosk.mode"
    say "  on the stick, from Windows. Anything else means the normal desktop."
  fi
  fi

  # Gate: every package must be a NEW install. Our layer outranks the base, so
  # an "upgraded" package would silently shadow a library the running system is
  # already using - a way to break the desktop that would look nothing like this
  # script when it surfaced.
  # The gate: refuse to bake in a package that would SHADOW a newer library the
  # live system is already using.
  #
  # But be precise about what we actually do. The build runs `apt-get download`
  # on the NAMED packages only - it never installs their dependencies. So an
  # `apt-get install -s` simulation reporting "2 upgraded" is usually reporting
  # dependency upgrades that will never happen here, and refusing on that count
  # blocks a build for a reason that does not apply.
  #
  # What genuinely matters is whether one of OUR packages is itself an upgrade
  # of something already installed. That is the case where our copy lands on top
  # of a newer one and something breaks in a way nobody will connect to this
  # script. Anything else is reported and allowed.
  #
  # apt marks an upgrade in its simulation as:  Inst pkg [old-ver] (new-ver ...)
  # and a fresh install as:                     Inst pkg (new-ver ...)
  # The bracketed old version is the discriminator.
  step "Checking the packages only ADD (nothing of ours upgraded)"
  sim=$(apt-get install -s --no-install-recommends $PACKAGES 2>/dev/null)
  if [ -z "$sim" ]; then
    say "  (could not simulate - no package lists? continuing without the gate)"
  else
    say "  $(printf '%s' "$sim" | grep -E '^[0-9]+ upgraded' | head -1)"

    upgrades=$(printf '%s' "$sim" | grep -E '^Inst [^ ]+ \[' | awk '{print $2}')
    if [ -n "$upgrades" ]; then
      say "  would upgrade (dependencies, NOT downloaded by this build):"
      for u in $upgrades; do say "      $u"; done
    fi

    # Only OUR named packages appearing in that list is a problem.
    bad=""
    for want in $PACKAGES; do
      for u in $upgrades; do
        [ "$want" = "$u" ] && bad="$bad $want"
      done
    done
    [ -z "$bad" ] || die "these are UPGRADES of packages already on the live image:$bad
      Baking one in puts an older or duplicate copy on top of what the running
      system is already using. Drop it and re-run:
          sudo env ALS_PACKAGES=\"$(echo $PACKAGES | sed "s/$(echo $bad | tr -d ' ')//")\" bash $0 build --with-session"
    say "  none of ours is an upgrade - safe to bake in"
  fi

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
  # MERGED-/usr: fold /lib back into /usr/lib, and refuse any other alias dir.
  #
  # THIS IS THE ONE THAT COST FIVE BOOTS, and it is invisible unless you look.
  #
  # On this image /bin, /lib, /lib64 and /sbin are SYMLINKS into /usr - in
  # minimal.squashfs, /lib is literally `symlink 0777 -> usr/lib`. Of the four
  # packages we bake in, nvme-cli ALONE still ships five units at literal
  # /lib/systemd/system paths, so `dpkg -x` creates a REAL DIRECTORY at
  # $STAGE/lib.
  #
  # Overlayfs merges a directory with a DIRECTORY. Where the higher layer has a
  # directory and the lower has a NON-directory, there is no merge: the higher
  # wins outright and the symlink underneath is hidden. Our layer is the topmost
  # lowerdir - attempt 1 proved that, when our 0700 root won at "/" - so the
  # booted system gets a /lib containing five nvme unit files AND NOTHING ELSE.
  # /lib stops pointing at /usr/lib.
  #
  # Two things then break, and the second is the one that was actually seen:
  #   - /etc/ld.so.cache names 833 libraries, every one under
  #     /lib/x86_64-linux-gnu and none under /usr/lib. They survive only via
  #     ld.so's built-in fallback path.
  #   - /etc/systemd/system/display-manager.service is a symlink to the ABSOLUTE
  #     path /lib/systemd/system/gdm3.service. That target ceases to exist, the
  #     unit will not load, gdm never starts, nothing displaces
  #     plymouth-quit.service, and the machine stops at a TEXT CONSOLE with no
  #     desktop and nothing in the journal pointing anywhere near this script.
  #
  # The timing is what identifies it. A text console right after plymouth-quit
  # is a SYSTEM-level failure - it happens before gnome-session exists to read
  # /etc/xdg/autostart and before anything could exec /usr/local/bin/als-autostart.
  # Neither of those files can run at the point of failure, so neither was ever
  # the cause, and three attempts were spent blaming them.
  #
  # Folding the files into /usr/lib puts them exactly where the symlink would
  # have landed them, and leaves the stock symlink free to merge normally.
  step "Folding merged-/usr alias directories into /usr"
  for d in lib bin sbin lib64; do
    if [ -e "$STAGE/$d" ] && [ ! -L "$STAGE/$d" ]; then
      say "  /$d was unpacked as a real directory - folding into /usr/$d"
      mkdir -p "$STAGE/usr/$d"             || die "mkdir /usr/$d failed"
      cp -a "$STAGE/$d/." "$STAGE/usr/$d/" || die "could not fold /$d into /usr/$d"
      rm -rf "$STAGE/$d"                   || die "could not remove the staged /$d"
    fi
  done
  alias_left=""
  for d in lib bin sbin lib64; do
    [ -e "$STAGE/$d" ] && alias_left="$alias_left /$d"
  done
  [ -z "$alias_left" ] || die "these are still real paths in the layer:$alias_left
      They are symlinks into /usr on this image. A directory here REPLACES that
      symlink on the booted system, which breaks /etc/ld.so.cache and leaves
      /etc/systemd/system/display-manager.service dangling - no gdm, no desktop,
      a text console after plymouth-quit. Refusing to build."
  say "  no real /lib /bin /sbin /lib64 in the layer"

  # Every directory 0755 root:root, matching the stock layers - EXCEPT the ones
  # that are deliberately NOT 0755 in stock. /tmp is 1777 and /root is 0700 in
  # minimal.squashfs, and forcing either to 0755 would be a fresh version of the
  # attempt-1 failure: a world-unwritable /tmp takes the desktop down on its own.
  # No package in the current list ships them, so this prunes nothing today - it
  # is here so that adding one to ALS_PACKAGES cannot quietly reintroduce it.
  step "Normalising directory permissions"
  find "$STAGE" -type d \( -path "$STAGE/tmp" -o -path "$STAGE/root" \
       -o -path "$STAGE/var/tmp" \) -prune -o -type d -exec chmod 0755 {} + \
       || die "chmod failed"
  n=$(find "$STAGE" -type d ! -perm 0755 \
       ! -path "$STAGE/tmp" ! -path "$STAGE/root" ! -path "$STAGE/var/tmp" | wc -l)
  [ "$n" = "0" ] || die "$n directories are still not 0755"
  say "  every directory 0755 (except stock-special /tmp /root /var/tmp)"

  # State it explicitly, because a silent UNKNOWN on these three is the failure
  # this whole layer exists to prevent, and it is invisible until a locked
  # machine has already been sold.
  step "Offline lock detection"
  for b in hivexget hivexsh tpm2_getcap; do
    if [ -x "$STAGE/usr/bin/$b" ] || [ -x "$STAGE/usr/sbin/$b" ]; then
      say "  $b baked in"
    else
      say "  $b NOT in the layer - Autopilot/Intune/Entra will report UNKNOWN offline"
    fi
  done

  # Record exactly what went in, next to the layer on the stick.
  #
  # The two builds that were compared - "packages only, works" and "packages
  # plus autostart, fails" - were never PROVEN to differ by only the autostart,
  # because apt-get download is allowed to fetch nothing and the build carries
  # on regardless. An empty layer boots perfectly, and that is not evidence that
  # a populated one does. Three attempts were reasoned on that false comparison.
  # Write the list down so the next one is between two known things.
  MANIFEST="$STAGE.manifest"
  ( cd "$STAGE" && find . -mindepth 1 \
      \( -type d -printf 'd %04m %p\n' \
      -o -type l -printf 'l ---- %p -> %l\n' \
      -o -printf 'f %04m %p\n' \) | LC_ALL=C sort ) > "$MANIFEST" 2>/dev/null
  say "  manifest: $(wc -l < "$MANIFEST" 2>/dev/null || echo 0) entries"

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
  [ -f "$MANIFEST" ] && cp "$MANIFEST" "$CASPER/$LAYER_NAME.manifest" 2>/dev/null
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
WANT_SESSION=0
case "${2:-}" in
  --with-autostart) WANT_AUTOSTART=1 ;;
  # The kiosk SESSION: GDM stops launching gnome-session and launches ours
  # instead, so GNOME never draws at all - no shell, no top bar, no dock, no
  # wallpaper. Implies --with-autostart, because the session runs als-autostart.
  #
  # Installing it is deliberately INERT: als-session reads gui/kiosk.mode from
  # the stick and, with anything other than "on" there, hands straight over to
  # the stock Ubuntu session. So this can be built, armed and booted with no
  # change in behaviour at all, and switched on afterwards by editing one word
  # from Windows. That ordering exists because a session that has to work first
  # time on a machine nobody can test is how a whole evening disappears.
  --with-session) WANT_AUTOSTART=1; WANT_SESSION=1 ;;
  '') : ;;
  *) die "Unknown option: $2 (--with-autostart or --with-session)" ;;
esac

case "${1:-status}" in
  build)  do_build ;;
  arm)    do_arm ;;
  undo)   do_undo ;;
  status) do_status ;;
  *) die "Usage: $0 {build|arm|undo|status}" ;;
esac
