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
# clonezilla is here for one reason: gui/install-os.sh runs `ocs-sr`, and the
# audit stick can only run programs that are inside it. Without clonezilla in
# the layer, Load OS Image stops at "Clonezilla (ocs-sr) is not installed on
# this boot media" and no image can ever be restored - on a bench with no
# internet, permanently.
#
# partclone alone is not a substitute, and it is an easy mistake to make. A
# Clonezilla image is a FOLDER - partition table, boot record, one partclone
# file per partition, and a clonezilla-img descriptor. partclone restores one
# partition from one file and knows nothing about the rest. ocs-sr writes the
# partition table, restores each partition, recovers the hidden data before
# the first partition (-j2), resizes the last partition to fill the target
# disk (-r), fixes NTFS geometry so Windows boots on different hardware (-e2)
# and reinstalls the bootloader. partclone is the engine; ocs-sr is the
# conductor, and we shipped only the engine.
#
# The separate Clonezilla USB used to CAPTURE images does not help: when a
# customer machine is being restored it is booted from THIS stick, and only
# one stick boots at a time.
PACKAGES="${ALS_PACKAGES:-nvme-cli smartmontools partclone pigz libhivex-bin tpm2-tools clonezilla}"

say()  { printf '%s\n' "$*"; }
die()  { printf '\n  !!  %s\n\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

# =============================================================================
# BOOT SPEED: Firefox ESR instead of the snap, and no per-boot update jobs.
#
# MEASURED on the station (boot-report.txt, Latitude 3310): APP READY at 82 s,
# and the biggest single cost was snapd.seeded.service at 95 s - snapd copying
# 11 seeded snaps, ~1.4 GB (gnome-42-2204 541 MB, firefox 271, thunderbird 221,
# ubuntu-desktop-bootstrap 118, gtk-common-themes 96, core22 77, snapd 47, ...)
# into the RAM overlay on EVERY boot, because a live session forgets that it
# ever seeded them. The kiosk only needed one of those: Firefox, which on 24.04
# exists only as a snap.
#
# So the layer carries Mozilla's own firefox-esr .deb, and - only when that
# browser really is in the layer - masks snapd, so nothing is seeded at all.
# Owner-approved; reversible by ALS_ESR=0 at build time, or by putting an older
# layer file back on the stick (see UBUNTU-STICK.md).
#
# Every function below is also exercised off the station by
# tools/test-layer-*.sh, which source this file with ALS_LAYER_LIB=1 and stop
# just before the root check - nothing below that line runs in a test.
# =============================================================================

# The key that signs packages.mozilla.org. The fingerprint is Mozilla's own
# published value (their "install Firefox .deb on Debian/Ubuntu" instructions,
# e.g. blog.nightly.mozilla.org 2023-10-30), and it was also read back out of
# the key file served at MOZ_KEY_URL on 2026-09-19: ONE primary RSA-2048 key,
# no subkeys, 35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3. A key that does not
# match is not "probably fine": it means the download was tampered with or
# replaced, and apt would then trust whatever it signs. The build stops.
MOZ_FPR="35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3"
MOZ_KEY_URL="https://packages.mozilla.org/apt/repo-signing-key.gpg"
MOZ_REPO="https://packages.mozilla.org/apt mozilla main"

# The real ESR binary. /usr/bin/firefox-esr is only a symlink to it, and a
# dangling symlink must not count as "ESR is in the layer".
ESR_BIN="usr/lib/firefox-esr/firefox"

# Every snapd unit in noble's snapd package, read out of the .debs: 2.66.1+24.04
# (the version in the stick's 24.04.2 manifest) and 2.76.3+ubuntu24.04 (noble-
# updates today) ship the same eleven services/sockets/timer and the same
# dependency edges; 2.76 only adds a third target. Units a given stick's snapd
# does not ship cost nothing to mask - a /dev/null link for a unit nobody
# defines is simply never consulted.
#
# The three snapd TARGETS (snapd.mounts.target, snapd.mounts-pre.target,
# snapd.gpio-chardev-setup.target) are deliberately NOT masked: they have no
# ExecStart, so they cost nothing, and a target is exactly the kind of unit
# something else might Requires= - masking one is the only way this could take
# down a unit that has nothing to do with snaps.
#
# WHY MASKING CANNOT BREAK A Requires= CHAIN: a unit that Requires=/BindsTo=/
# Requisite= a masked unit fails with it. Every unit, drop-in and .wants
# symlink shipped by the 129 packages in the 24.04.2 desktop manifest that
# carry systemd files (their current noble .debs, 2026-09-19) was extracted and
# searched: NOTHING outside snapd itself
# names a snapd unit in any dependency directive - not gdm3 (whose After= list
# is getty@tty1, plymouth-quit, rc-local, plymouth-start,
# systemd-user-sessions, cloud-config), not casper, not systemd. Inside snapd
# the only hard edges are snapd.service and snapd.seeded.service
# Requires=snapd.socket, which are masked together, and the user unit
# snapd.session-agent.service Requires= its own socket, also masked together.
# casper's 55disable_snap_refresh writes /run/systemd/system/snapd.hold.service
# with After=snapd.service and WantedBy=snapd.service only - soft edges from a
# masked unit, so it simply never starts.
SNAPD_SYSTEM_UNITS="snapd.service snapd.socket snapd.seeded.service snapd.apparmor.service
  snapd.autoimport.service snapd.core-fixup.service snapd.failure.service
  snapd.recovery-chooser-trigger.service snapd.snap-repair.service
  snapd.snap-repair.timer snapd.system-shutdown.service"
SNAPD_USER_UNITS="snapd.session-agent.service snapd.session-agent.socket"

# Fetch a URL to a file. curl is NOT on this image (checked against every
# casper layer), wget is; python3 is the fallback because it is always there.
als_fetch() {
  local url="$1" out="$2"
  if command -v wget >/dev/null 2>&1; then
    wget -q -T 30 -O "$out" "$url" 2>/dev/null && [ -s "$out" ]
    return
  fi
  command -v python3 >/dev/null 2>&1 || return 1
  python3 - "$url" "$out" <<'PY' 2>/dev/null
import sys, urllib.request
with urllib.request.urlopen(sys.argv[1], timeout=30) as r, open(sys.argv[2], "wb") as f:
    f.write(r.read())
PY
  [ -s "$out" ]
}

# Print the fingerprint of every PRIMARY key in a key file, one per line.
# --show-keys reads the file without importing it anywhere; GNUPGHOME is a
# throwaway so root's own keyring is never touched.
als_key_fprs() {
  local key="$1" home
  home=$(mktemp -d) || return 1
  chmod 0700 "$home"
  GNUPGHOME="$home" gpg --batch --quiet --with-colons --show-keys "$key" 2>/dev/null \
    | awk -F: '$1=="pub"{want=1; next} $1=="fpr" && want {print toupper($10); want=0; next} {want=0}'
  rm -rf "$home"
}

# 0 only if the file holds EXACTLY ONE primary key and it is the expected one.
# "Exactly one" matters: signed-by= trusts EVERY key in the file, so a file with
# Mozilla's key plus one more would pass a "does it contain the fingerprint"
# check and still let the extra key sign packages.
als_key_ok() {
  local key="$1" want="${2:-$MOZ_FPR}" fprs n
  command -v gpg >/dev/null 2>&1 || { say "  gpg is not available - cannot verify the key"; return 1; }
  fprs=$(als_key_fprs "$key")
  n=$(printf '%s\n' "$fprs" | grep -c .)
  say "  key file holds $n primary key(s): $(echo $fprs)"
  [ "$n" = "1" ] && [ "$fprs" = "$want" ]
}

# Download firefox-esr into $2 from Mozilla's signed repository, touching
# NOTHING on the build host's apt configuration and nothing in the stage.
#
#   $1  a private work directory OUTSIDE the stage (key, source list, lists)
#   $2  where the .deb goes (the stage's .debs directory, which do_build
#       unpacks with dpkg -x and deletes)
#
# The key and the source line live only in $1, and apt is pointed at them with
# -o options for these two commands alone, so:
#   - the host's /etc/apt is never written - no mozilla.list is left behind to
#     be picked up by a later `apt-get upgrade` on the station;
#   - Dir::Cache and Dir::State::Lists are private too, so the host's package
#     lists and caches are not replaced by a Mozilla-only view;
#   - nothing here is under the stage, so no key or source can be packed into
#     the layer. Only the .deb's own files are.
#
# Returns 0 with a deb in $2, 1 when ESR was skipped for a benign reason (no
# network, no gpg) - then the build carries on without ESR and snapd is left
# alone. A key that does not match is NOT benign: it dies.
als_fetch_esr() {
  local work="$1" debs="$2" apt_moz n
  mkdir -p "$work/lists/partial" "$work/cache/archives/partial" "$work/parts.d" || return 1
  if ! als_fetch "$MOZ_KEY_URL" "$work/mozilla.asc"; then
    say "  could not download Mozilla's signing key (no internet?) - ESR skipped,"
    say "  snapd left as it is. Re-run with a connection to bake it in."
    return 1
  fi
  command -v gpg >/dev/null 2>&1 || {
    say "  gpg is missing, so the key cannot be verified - ESR skipped, snapd left alone"
    return 1
  }
  als_key_ok "$work/mozilla.asc" "$MOZ_FPR" || die "Mozilla's signing key did NOT verify.
      Expected exactly one key, fingerprint $MOZ_FPR.
      Either the download was altered or Mozilla has rotated its key. Do not
      work around this. Check https://support.mozilla.org/kb/install-firefox-linux
      from a trusted machine; to build without Firefox ESR meanwhile:
          sudo env ALS_ESR=0 bash $0 build ..."
  say "  Mozilla signing key verified ($MOZ_FPR)"
  printf 'deb [signed-by=%s] %s\n' "$work/mozilla.asc" "$MOZ_REPO" > "$work/mozilla.list"
  apt_moz="-o Dir::Etc::SourceList=$work/mozilla.list -o Dir::Etc::SourceParts=$work/parts.d
           -o Dir::State::Lists=$work/lists -o Dir::Cache=$work/cache"
  # shellcheck disable=SC2086
  if ! apt-get $apt_moz update >/dev/null 2>&1; then
    say "  could not read Mozilla's repository (no internet, or its signature"
    say "  did not verify) - ESR skipped, snapd left alone"
    return 1
  fi
  # shellcheck disable=SC2086
  ( cd "$debs" && apt-get $apt_moz download firefox-esr >/dev/null 2>&1 )
  n=$(find "$debs" -maxdepth 1 -name 'firefox-esr_*.deb' | wc -l)
  if [ "$n" != "1" ]; then
    say "  firefox-esr did not download ($n files) - ESR skipped, snapd left alone"
    rm -f "$debs"/firefox-esr_*.deb
    return 1
  fi
  say "  downloaded $(basename "$(find "$debs" -maxdepth 1 -name 'firefox-esr_*.deb')")"
  return 0
}

# "Is ESR in the layer?" has to mean "is ALL of it in the layer", not "does
# the binary exist". A HALF-UNPACKED ESR IS WORSE THAN NONE, and it is the
# likely way this goes wrong: the build runs on the live station, the stage is
# on the RAM-backed casper overlay that already holds ~1.4 GB of seeded snaps,
# and the ESR .deb unpacks to ~311 MB. The .deb's tar order puts
# usr/lib/firefox-esr/firefox at entry 31 of 99 and libxul.so (185 MB) at
# entry 90, so an overlay that fills up mid-unpack leaves an executable
# `firefox` next to a truncated libxul.so. A review reproduced exactly that
# (200 MB tmpfs stage, the real 153.3.0esr .deb): dpkg -x failed, the old
# `dpkg -x ... 2>/dev/null && ...` swallowed it, the old `-x firefox` gate
# masked snapd, and the staged binary died with "Couldn't load XPCOM". That
# station boots to NO browser at all: ESR is broken and the snap Firefox can
# no longer seed.
#
# So the proof is the .deb's own file list: every regular file it ships must be
# in the stage at exactly the size the .deb says.

# List a .deb's contents, one entry per line: "<type> <size> <path>", where
# type is dpkg-deb's first mode character (- d l h ...) and path has no
# leading "./" and no " -> target" / " link to target" suffix.
als_deb_entries() {
  dpkg-deb -c "$1" 2>/dev/null | awk '{
    t = substr($1, 1, 1); s = $3; p = $0
    for (i = 1; i <= 5; i++) sub(/^[^ ]+ +/, "", p)
    if (t == "l") sub(/ -> .*$/, "", p)
    if (t == "h") sub(/ link to .*$/, "", p)
    sub(/^\.\//, "", p); sub(/\/$/, "", p)
    if (p != "" && p != ".") print t, s, p
  }'
}

# 0 only if $1 (a stage, or the mounted layer) holds a COMPLETE firefox-esr:
# $2 is the list als_deb_entries wrote for its .deb, it names ESR_BIN, and
# every regular file in it is present, regular, and exactly the listed size.
# No list, or an empty one, is "not complete" - never guess.
als_esr_complete() {
  local root="$1" list="$2" t s p n=0
  [ -n "$list" ] && [ -s "$list" ] || return 1
  [ -x "$root/$ESR_BIN" ] && [ ! -L "$root/$ESR_BIN" ] || return 1
  grep -q "^- [0-9]* $ESR_BIN\$" "$list" || return 1
  while read -r t s p; do
    [ "$t" = "-" ] || continue
    [ -f "$root/$p" ] && [ ! -L "$root/$p" ] || return 1
    [ "$(stat -c %s "$root/$p" 2>/dev/null)" = "$s" ] || return 1
    n=$((n + 1))
  done < "$list"
  [ "$n" -gt 0 ]
}

# Take every trace of a firefox-esr unpack back out of the stage: each
# non-directory entry the .deb lists, then its private directory. Used when the
# unpack failed or came out incomplete, so the layer carries no half browser -
# als-autostart prefers firefox-esr, and Mozilla's /usr/bin/firefox (a script
# that execs firefox-esr) would shadow Ubuntu's snap wrapper. With all of it
# gone, the stage is as if ESR had never been fetched: snap Firefox, snapd on.
als_remove_esr() {
  local stage="$1" list="$2" t s p
  if [ -n "$list" ] && [ -f "$list" ]; then
    while read -r t s p; do
      [ "$t" = "d" ] && continue
      rm -f "$stage/$p"
    done < "$list"
  fi
  rm -rf "$stage/usr/lib/firefox-esr"
  rm -f "$stage/usr/bin/firefox-esr" "$stage/usr/share/applications/firefox-esr.desktop"
}

# Unpack the firefox-esr .deb $1 into stage $2, writing its entry list to $3
# (OUTSIDE the stage - it must not land in the layer; the mount-time check
# reads it again). 0 = complete and in place. Anything else - a list that
# cannot be read, dpkg -x failing (ENOSPC on the RAM overlay is the likely
# one), or a result that does not match the list - removes what did land and
# returns 1, and the build carries on WITHOUT ESR and with snapd untouched.
als_unpack_esr() {
  local deb="$1" stage="$2" list="$3" rc
  if ! als_deb_entries "$deb" > "$list" || ! grep -q "^- [0-9]* $ESR_BIN\$" "$list"; then
    say "  could not read the file list of $(basename "$deb") - ESR skipped, snapd left alone"
    als_remove_esr "$stage" ""; rm -f "$list"
    return 1
  fi
  dpkg -x "$deb" "$stage"; rc=$?
  if [ "$rc" != "0" ]; then
    say "  dpkg -x $(basename "$deb") FAILED (exit $rc - out of space on the live"
    say "  overlay?). Removing the partial unpack; ESR skipped, snapd left alone."
    als_remove_esr "$stage" "$list"; rm -f "$list"
    return 1
  fi
  if ! als_esr_complete "$stage" "$list"; then
    say "  $(basename "$deb") unpacked INCOMPLETE (a file is missing or the wrong"
    say "  size). Removing it; ESR skipped, snapd left alone."
    als_remove_esr "$stage" "$list"; rm -f "$list"
    return 1
  fi
  return 0
}

# Mask snapd in the stage - but ONLY if a COMPLETE ESR is really in it.
#
# That condition is the whole safety of this change. Masking snapd without a
# replacement browser would leave the kiosk with no browser at all (the stock
# /usr/bin/firefox is a wrapper that exits with "requires the firefox snap").
# So this looks at the stage itself, after unpacking, rather than at whether a
# download "succeeded" - and at every file of the package, not just the binary
# (see als_esr_complete: a binary with a truncated libxul.so is no browser).
#
# $1 = stage, $2 = the entry list als_unpack_esr wrote. No list, no mask.
#
# The masks go in /etc/systemd/system (and /etc/systemd/user), which outranks
# /usr/lib/systemd - and, for the record, is NOT under /lib, so the merged-/usr
# trap in the fold step cannot bite here. Directory modes are normalised to
# 0755 with the rest of the stage, matching stock.
als_mask_snapd() {
  local stage="$1" list="${2:-}" u
  if ! als_esr_complete "$stage" "$list"; then
    say "  a complete firefox-esr is NOT in the layer - snapd left alone (the snap"
    say "  Firefox is still the only browser, and it needs snapd to seed)"
    return 1
  fi
  mkdir -p "$stage/etc/systemd/system" "$stage/etc/systemd/user" || die "mkdir for the snapd masks failed"
  for u in $SNAPD_SYSTEM_UNITS; do
    ln -sfn /dev/null "$stage/etc/systemd/system/$u" || die "could not mask $u"
  done
  for u in $SNAPD_USER_UNITS; do
    ln -sfn /dev/null "$stage/etc/systemd/user/$u" || die "could not mask user unit $u"
  done
  say "  masked: $(echo $SNAPD_SYSTEM_UNITS)"
  say "  masked (user): $SNAPD_USER_UNITS"
  return 0
}

# ConditionNeedsUpdate: why ldconfig ran on EVERY boot, and why it stops now.
#
# ldconfig.service, systemd-sysusers, systemd-hwdb-update and
# systemd-update-done carry ConditionNeedsUpdate=/etc; journal-catalog-update
# and update-done carry ConditionNeedsUpdate=/var. systemd (v255,
# condition_test_needs_update) runs them when /usr's mtime is NEWER than
# /etc/.updated (or /var/.updated): seconds first; only on equal seconds does
# it look at nanoseconds, and only when /usr has nanoseconds and the stamp has
# none does it read TIMESTAMP_NSEC from inside the stamp.
#
# Overlayfs reports a merged directory's mtime from the TOPMOST layer that has
# it - ours, for /usr - and our /usr is days or months newer than the stock
# image's stamps. So every boot "needed an update": ldconfig alone was 8.3 s on
# the critical path, and on a live system nothing it writes survives, so it
# ran again next time. Forever.
#
# The fix is to ship stamps that are never older than our /usr: one time T,
# written as /usr's mtime AND as both stamps' mtime AND as TIMESTAMP_NSEC, in
# the file format systemd-update-done itself writes. squashfs stores whole
# seconds only (nsec reads back 0 on both), so the comparison is decided on
# seconds, T == T, not newer: nothing reruns. Setting /usr's mtime explicitly
# (rather than trusting "the stamps were written last") also covers a build
# host whose clock is behind, and a stage that had no /usr of its own.
#
# WHY SKIPPING ldconfig IS SAFE HERE. ldconfig only rebuilds /etc/ld.so.cache.
# The stock cache already lists every stock library, and the no-upgrade gate
# means our layer adds libraries, never replaces them. A soname that misses
# the cache is looked up in ld.so's built-in system search path, which on
# noble is /lib/x86_64-linux-gnu, /usr/lib/x86_64-linux-gnu, /lib and /usr/lib
# (`ld.so --help`) - exactly where dpkg -x puts packaged libraries, soname
# symlinks included. firefox-esr's own libraries live in /usr/lib/firefox-esr
# and are found by its RPATH, never through the cache. The cache only ADDS
# value for directories listed in /etc/ld.so.conf(.d) that are not on that
# built-in path - so if the stage ships an ld.so.conf entry, or a library in
# such a directory, the /etc stamp is not written and ldconfig runs as before.
# Same rule for the other jobs: hwdb.d or sysusers.d files in the stage keep
# the /etc stamp out; a journal catalog keeps the /var stamp out. The stamp is
# an optimisation, and it steps aside whenever the job it skips has work to do.

# Print, one per line, anything in the stage that a skipped update job would
# have consumed. $1 = stage, $2 = the host root whose ld.so.conf to read ("/").
als_stamp_blockers_etc() {
  local stage="$1" root="${2:-/}" d f
  for f in "$stage"/etc/ld.so.conf "$stage"/etc/ld.so.conf.d/* \
           "$stage"/usr/lib/udev/hwdb.d/* "$stage"/etc/udev/hwdb.d/* "$stage"/etc/udev/hwdb.bin \
           "$stage"/usr/lib/sysusers.d/* "$stage"/etc/sysusers.d/*; do
    [ -e "$f" ] || [ -L "$f" ] && printf '%s\n' "${f#"$stage"/}"
  done
  # Library directories the cache covers but ld.so's built-in path does not.
  for d in $(cat "$root"/etc/ld.so.conf "$root"/etc/ld.so.conf.d/*.conf 2>/dev/null \
             | sed 's/#.*//' | grep -v '^[[:space:]]*include' | tr -s ' \t' '\n\n' | grep '^/'); do
    case "${d%/}" in
      /lib/x86_64-linux-gnu|/usr/lib/x86_64-linux-gnu|/lib|/usr/lib) continue ;;
    esac
    [ -d "$stage$d" ] || continue
    find "$stage$d" -maxdepth 1 \( -name '*.so' -o -name '*.so.*' \) 2>/dev/null \
      | sed "s|^$stage/||"
  done
}
als_stamp_blockers_var() {
  local stage="$1" f
  for f in "$stage"/usr/lib/systemd/catalog/*; do
    [ -e "$f" ] && printf '%s\n' "${f#"$stage"/}"
  done
}

# Write /etc/.updated and /var/.updated, in systemd-update-done's own format.
# $1 = stage, $2 = time T in epoch seconds (default: now). MUST run after every
# other change to the stage - it pins /usr's mtime.
als_write_update_stamps() {
  local stage="$1" t="${2:-}" blk_etc blk_var dir wrote=""
  [ -n "$t" ] || t=$(date +%s)
  blk_etc=$(als_stamp_blockers_etc "$stage" "${ALS_HOST_ROOT:-/}")
  blk_var=$(als_stamp_blockers_var "$stage")
  # /usr must be OURS, so the merged /usr at boot has exactly this mtime rather
  # than a lower layer's.
  # And 0755 whether we made it or not: overlayfs takes a merged directory's
  # mode from the topmost layer, so a group-writable /usr here (a stage built
  # under umask 002) would be the booted system's /usr. The build's permission
  # pass already normalises the stage; this function does not rely on it.
  [ -d "$stage/usr" ] || mkdir -m 0755 "$stage/usr" || die "mkdir usr failed"
  chmod 0755 "$stage/usr" || die "chmod usr failed"
  for dir in etc var; do
    if [ "$dir" = "etc" ] && [ -n "$blk_etc" ]; then
      say "  /etc/.updated NOT written - the layer ships input for ldconfig/hwdb/sysusers:"
      printf '%s\n' "$blk_etc" | head -5 | sed 's/^/      /'
      continue
    fi
    if [ "$dir" = "var" ] && [ -n "$blk_var" ]; then
      say "  /var/.updated NOT written - the layer ships a journal catalog:"
      printf '%s\n' "$blk_var" | head -5 | sed 's/^/      /'
      continue
    fi
    [ -d "$stage/$dir" ] || mkdir -m 0755 "$stage/$dir" || die "mkdir $dir failed"
    chmod 0755 "$stage/$dir" || die "chmod $dir failed"
    printf '%s\n%s\n%s\nTIMESTAMP_NSEC=%s000000000\n' \
      "# This file was created by systemd-update-done. Its only " \
      "# purpose is to hold a timestamp of the time this directory" \
      "# was updated. See man:systemd-update-done.service(8)." \
      "$t" > "$stage/$dir/.updated" || die "could not write $dir/.updated"
    chmod 0644 "$stage/$dir/.updated"
    touch -h -d "@$t" "$stage/$dir/.updated" || die "could not set the $dir/.updated time"
    wrote="$wrote /$dir/.updated"
  done
  # Last, so nothing above can move it: /usr gets the same second.
  touch -d "@$t" "$stage/usr" || die "could not set the /usr time"
  if [ -n "$wrote" ]; then
    say "  wrote$wrote at $(date -u -d "@$t" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "$t") UTC,"
    say "  /usr pinned to the same second - ldconfig and friends stay idle at boot"
  fi
}

# =============================================================================
# cloud-init: switched off with its own documented marker file.
#
# MEASURED on the station after the ESR/stamps layer (Latitude 3310, APP READY
# 52 s): the chain gdm had to wait for ran
#     NetworkManager @8.7s -> NetworkManager-wait-online @12.1s +3.3s
#     -> cloud-init.service @15.45s +1.8s -> systemd-user-sessions @17.29s
#     -> plymouth-quit-wait -> multi-user -> graphical
# and cloud-init-local.service took another 5.45 s. cloud-init.service is
# Before=systemd-user-sessions.service (read out of the unit), and in the
# station's critical chain it only started once NetworkManager-wait-online had
# finished - so the desktop waited on cloud-init, and cloud-init on a network
# the kiosk does not need at that point. The kiosk never uses cloud-init: no
# datasource, no user-data, nothing it configures is ours. How much of the
# wait-online time also leaves the chain depends on what ELSE wants
# network-online.target on the stick; only the next boot report can say.
#
# HOW, and why not a mask. Every noble cloud-init (24.1.3 release, 24.4 in the
# 24.04.2 image, 26.1 in noble-updates - each .deb installed and its generator
# run by hand, with and without the file) does the same thing:
#   - ds-identify's is_disabled() checks `[ -f /etc/cloud/cloud-init.disabled ]`
#     FIRST, before probing any datasource, and returns 2;
#   - cloud-init-generator then does NOT link cloud-init.target into
#     multi-user.target.wants, so none of cloud-init's services is pulled in;
#   - and, independently, every cloud-init unit (cloud-init-local, cloud-init,
#     cloud-config, cloud-final, hotplugd, cloud-init.target itself) carries
#     ConditionPathExists=!/etc/cloud/cloud-init.disabled, so anything that
#     still pulls one in finds it skipped, not failed.
# Only EXISTENCE is checked (-f: a regular file), never content, so the file
# holds a comment saying who put it there. A mask would instead make every
# unit that Requires= a cloud-init unit fail with it; the marker file breaks
# no dependency chain at all - a skipped condition counts as success.
#
# LAYOUT. /etc/cloud is a real directory (0755 root) in the cloud-init package,
# so our etc/cloud MERGES with it in the overlay: everything the lower layers
# have there - cloud.cfg, cloud.cfg.d/, templates/ - stays visible, and we add
# exactly one file that no lower layer has. The build refuses to add a
# directory where the running system has a symlink or a file at /etc/cloud
# (a directory in our layer would REPLACE that, the /lib trap again), and
# skips cloud-init entirely where it is not installed.
#
# Owner-approved; reversible by ALS_CLOUD_INIT=1 at build time (cloud-init then
# runs exactly as stock), or by putting an older layer file back on the stick.
# =============================================================================
CLOUD_INIT_MARKER="etc/cloud/cloud-init.disabled"

# Stage the marker. $1 = stage, $2 = the host root to compare against
# (default "/", the running live system - i.e. the stock layers underneath).
# 0 = staged; 1 = deliberately not staged (opt-out, or not applicable).
als_disable_cloud_init() {
  local stage="$1" root="${2:-/}"
  if [ "${ALS_CLOUD_INIT:-0}" = "1" ]; then
    say "  cloud-init: left as it is (ALS_CLOUD_INIT=1)"
    return 1
  fi
  if [ -L "$root/etc/cloud" ] || { [ -e "$root/etc/cloud" ] && [ ! -d "$root/etc/cloud" ]; }; then
    say "  cloud-init: left as it is - /etc/cloud on this system is not a plain"
    say "  directory, and a directory in the layer would replace it"
    return 1
  fi
  if [ ! -d "$root/etc/cloud" ]; then
    say "  cloud-init: not installed here (no /etc/cloud) - nothing to switch off"
    return 1
  fi
  # Our own stage must not already hold something else at either path.
  if [ -L "$stage/etc/cloud" ] || { [ -e "$stage/etc/cloud" ] && [ ! -d "$stage/etc/cloud" ]; }; then
    die "the stage has a non-directory at /etc/cloud - refusing to stage cloud-init.disabled"
  fi
  if [ -L "$stage/$CLOUD_INIT_MARKER" ] || { [ -e "$stage/$CLOUD_INIT_MARKER" ] && [ ! -f "$stage/$CLOUD_INIT_MARKER" ]; }; then
    die "the stage has a non-file at /$CLOUD_INIT_MARKER - refusing"
  fi
  # 0755 explicitly, whatever the umask: overlayfs takes a merged directory's
  # mode from the topmost layer, so our /etc and /etc/cloud ARE the booted
  # system's. The build's permission pass normalises them too; this does not
  # rely on it.
  [ -d "$stage/etc" ] || mkdir -m 0755 "$stage/etc" || die "mkdir etc failed"
  [ -d "$stage/etc/cloud" ] || mkdir -m 0755 "$stage/etc/cloud" || die "mkdir etc/cloud failed"
  chmod 0755 "$stage/etc" "$stage/etc/cloud" || die "chmod etc/cloud failed"
  printf '%s\n' \
    "# Put here by the ALS Audit Station layer (tools/make-als-layer.sh)." \
    "# The kiosk never uses cloud-init, and it held up the desktop at every boot" \
    "# (cloud-init.service is Before=systemd-user-sessions and waited for the" \
    "# network). cloud-init's generator and every one of its units check only" \
    "# that this file EXISTS. To keep cloud-init, rebuild with ALS_CLOUD_INIT=1." \
    > "$stage/$CLOUD_INIT_MARKER" || die "could not write /$CLOUD_INIT_MARKER"
  chmod 0644 "$stage/$CLOUD_INIT_MARKER" || die "chmod /$CLOUD_INIT_MARKER failed"
  say "  cloud-init: switched off (/$CLOUD_INIT_MARKER)"
  return 0
}

# Test hook: stop here when sourced by tools/test-layer-*.sh.
if [ "${ALS_LAYER_LIB:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

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
  MOZ_WORK=""
  ESR_LIST="$STAGE.esr-files"
  trap 'rm -rf "$STAGE" "$ESR_LIST"; [ -n "$MOZ_WORK" ] && rm -rf "$MOZ_WORK"; media_ro' EXIT

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
      # two-step refuses a theme without these (plymouth two-step/plugin.c and
      # ply-entry.c) and falls through to bgrt. The first layer shipped without
      # them, and that - not /run/initramfs - is why shutdown showed Ubuntu.
      for f in lock.png entry.png bullet.png; do
        [ -f "$STAGE/usr/share/plymouth/themes/als/$f" ] || {
          say "  WARNING: themes/als has no $f - plymouth will NOT load it and"
          say "           shutdown falls back to Ubuntu's logo. Re-run"
          say "           tools/boot/make-splash.py --theme-only and re-sync."
        }
      done
      [ -f "$STAGE/usr/share/plymouth/themes/bgrt/bgrt.plymouth" ] \
        && say "  /usr/share/plymouth/themes/bgrt  (the fallback is ours too)"
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

  # Firefox ESR, from Mozilla's signed repository - see BOOT SPEED at the top.
  # Same gate as above, asked directly: firefox-esr must be a NEW install. It
  # is not in Ubuntu's archive at all, so on the stock image it never is
  # installed; if someone has apt-installed it into this live session, baking
  # ours in would shadow theirs, so stop and say so.
  #
  # One overlap is deliberate and worth knowing about. Mozilla's package ships
  # /usr/bin/firefox as well as /usr/bin/firefox-esr, and on a real install
  # its preinst dpkg-diverts Ubuntu's /usr/bin/firefox (the snap wrapper) out
  # of the way. dpkg -x runs no maintainer scripts, so in the layer ours simply
  # sits on top of Ubuntu's - and that is what we want: with snapd masked the
  # snap wrapper could only print "requires the firefox snap", while Mozilla's
  # wrapper runs `firefox.real` if present (it is not) and otherwise
  # `exec firefox-esr`. So `firefox` keeps working for start-gui.sh and anyone
  # typing it. It is a shell script with no libraries behind it - nothing else
  # on the system is shadowed.
  if [ "${ALS_ESR:-1}" = "0" ]; then
    say "  ALS_ESR=0: Firefox ESR not baked in; snapd will be left alone"
  elif dpkg-query -W -f='${Status}' firefox-esr 2>/dev/null | grep -q 'ok installed'; then
    die "firefox-esr is already INSTALLED in this live session. Baking ours in
      would shadow it. Reboot the stick (a fresh session has none) and re-run,
      or build without it:  sudo env ALS_ESR=0 bash $0 build ..."
  else
    MOZ_WORK=$(mktemp -d) || die "mktemp failed"
    als_fetch_esr "$MOZ_WORK" "$DEBS" || true
    rm -rf "$MOZ_WORK"; MOZ_WORK=""
  fi
  # firefox-esr is unpacked on its own and its exit status is CHECKED: a
  # partial unpack is removed again rather than left for the snapd mask to
  # mistake for a browser (see als_esr_complete). ESR_LIST is its file list,
  # kept beside the stage for the mount-time re-check.
  got=0
  ESR_LIST="$STAGE.esr-files"; rm -f "$ESR_LIST"
  for deb in "$DEBS"/*.deb; do
    [ -f "$deb" ] || continue
    case "$(basename "$deb")" in
      firefox-esr_*.deb)
        als_unpack_esr "$deb" "$STAGE" "$ESR_LIST" \
          && { got=$((got+1)); say "  unpacked $(basename "$deb") (complete: every file at its packaged size)"; }
        continue ;;
    esac
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

  # Before the permission pass, so the /etc/systemd directories it creates are
  # normalised with everything else.
  step "Kiosk browser and snapd"
  if als_esr_complete "$STAGE" "$ESR_LIST"; then
    say "  firefox-esr baked in (/$ESR_BIN)"
  fi
  als_mask_snapd "$STAGE" "$ESR_LIST" || true

  # Also before the permission pass (it creates etc/cloud), and before the
  # stamps, which must stay the last write. See "cloud-init" at the top.
  step "cloud-init"
  CLOUD_INIT_OFF=0
  als_disable_cloud_init "$STAGE" "${ALS_HOST_ROOT:-/}" && CLOUD_INIT_OFF=1

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

  # Same treatment for the restore tool, for the same reason: without it the
  # Load OS Image button fails on a bench with no internet, and it fails at the
  # point an operator has already chosen an image and a target disk.
  step "Offline OS restore"
  found_ocs=""
  for d in usr/sbin usr/bin usr/share/drbl/sbin; do
    [ -x "$STAGE/$d/ocs-sr" ] && found_ocs="/$d/ocs-sr"
  done
  if [ -n "$found_ocs" ]; then
    say "  ocs-sr baked in ($found_ocs)"
  else
    say "  ocs-sr NOT in the layer - Load OS Image will refuse to restore offline"
    say "  (install-os.sh checks for it first and stops with a clear message)"
  fi

  # LAST change to the stage - it pins /usr's mtime, so anything written into
  # the stage after this could make /usr newer than the stamps again. See
  # "ConditionNeedsUpdate" at the top. ALS_UPDATE_STAMPS=0 leaves them out
  # (ldconfig and friends then run every boot, as they did before).
  step "Update stamps (so ldconfig & co. do not rerun every boot)"
  if [ "${ALS_UPDATE_STAMPS:-1}" = "0" ]; then
    say "  ALS_UPDATE_STAMPS=0: not written"
  else
    als_write_update_stamps "$STAGE"
  fi

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

  # Read back from the squashfs itself, not the stage: a stamp older than our
  # /usr is exactly the every-boot ldconfig this layer is meant to remove.
  if [ -z "$fail" ]; then
    usr_t=$(stat -c %Y "$MP/usr" 2>/dev/null || echo 0)
    for s in etc/.updated var/.updated; do
      [ -f "$MP/$s" ] || continue
      s_t=$(stat -c %Y "$MP/$s")
      [ "$s_t" -ge "$usr_t" ] || fail="/$s ($s_t) is older than the layer's /usr ($usr_t)"
    done
  fi
  # And never a masked snapd without the browser that replaces it - ALL of it,
  # every file at its packaged size, read back from the squashfs itself.
  if [ -z "$fail" ] && [ -L "$MP/etc/systemd/system/snapd.seeded.service" ] \
     && ! als_esr_complete "$MP" "$ESR_LIST"; then
    fail="snapd is masked but firefox-esr is not in the layer complete - the kiosk would have no browser"
  fi
  # The cloud-init marker, read back: a regular file (ds-identify tests -f),
  # under a real 0755 /etc/cloud that will merge with the stock one.
  if [ -z "$fail" ] && [ "$CLOUD_INIT_OFF" = "1" ]; then
    if [ -L "$MP/etc/cloud" ] || [ ! -d "$MP/etc/cloud" ] \
       || [ "$(stat -c %a "$MP/etc/cloud")" != "755" ]; then
      fail="/etc/cloud in the layer is not a 0755 directory - it would not merge with the stock one"
    elif [ -L "$MP/$CLOUD_INIT_MARKER" ] || [ ! -f "$MP/$CLOUD_INIT_MARKER" ]; then
      fail="/$CLOUD_INIT_MARKER is not a regular file in the layer - cloud-init would still run"
    fi
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
