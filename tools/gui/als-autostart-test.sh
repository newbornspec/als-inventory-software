#!/usr/bin/env bash
#
# Try the autostart in RAM, without touching the stick or rebuilding anything.
#
#   bash /cdrom/gui/als-autostart-test.sh          install, mode probe
#   bash /cdrom/gui/als-autostart-test.sh full     install and set mode full
#   bash /cdrom/gui/als-autostart-test.sh backend  install and set mode backend
#   bash /cdrom/gui/als-autostart-test.sh remove   take it back out
#
# A REBOOT WIPES THIS. The live session's home directory is a RAM overlay, so a
# reboot takes the shim, the autostart entry and the mode file with it and
# nothing fires. That is not a fault, it is the amnesia this whole exercise
# exists to work around - but it has already cost one "it stopped working".
# After any reboot, run this again. Between logouts it persists fine, and a
# logout is all that is needed to test.
#
# WHY THIS EXISTS
# The setup was originally five lines to type by hand, containing tildes and
# nested quotes. Typed off a screen the tilde came out as a hyphen -
# "mkdir -p -/.config/autostart" - and mkdir read it as an option. That is not
# an operator error, it is a bad instruction: anything transcribed by hand
# should have no character that is easy to mistype and no quoting to balance.
#
# What it does is exactly what gnome-session does at login, using the SAME
# .desktop and the SAME shim that the overlay layer would install - only in the
# live session's RAM, where a mistake costs a logout instead of a boot.
#
# NOTHING here can blank the screen. The default mode is "probe", which starts
# no backend and opens no window; it only proves the mechanism fires.

set -u

# No tildes anywhere. $HOME is set in any login session and cannot be mistyped.
BIN="$HOME/.local/bin"
AUTO="$HOME/.config/autostart"
SHIM="$BIN/als-autostart"
ENTRY="$AUTO/als-audit-station.desktop"

say() { printf '%s\n' "$*"; }

ARG="${1:-}"
MODEFILE="$HOME/als-autostart.mode"

if [ "$ARG" = "remove" ]; then
  rm -f "$ENTRY" "$SHIM" "$MODEFILE"
  say "Removed. Log out and back in and nothing of ours will run."
  exit 0
fi

case "$ARG" in
  ''|install) WANT_MODE="" ;;
  probe|backend|full) WANT_MODE="$ARG" ;;
  *) say ""
     say "  !!  Unknown argument: $ARG"
     say "      Use one of: probe | backend | full | remove"
     say ""
     exit 1 ;;
esac

if [ "$(id -u)" = "0" ]; then
  say ""
  say "  !!  Do NOT run this with sudo."
  say "      It installs into your own home so the desktop session picks it up."
  say "      Run it again without sudo:   bash $0"
  say ""
  exit 1
fi

# Find the stick the same way everything else does.
MEDIA=""
for d in /cdrom /isodevice /run/archiso/bootmnt /media/*/*; do
  [ -f "$d/gui/als-autostart-shim.sh" ] && { MEDIA="$d"; break; }
done
if [ -z "$MEDIA" ]; then
  say ""
  say "  !!  Could not find the audit media (looked for gui/als-autostart-shim.sh)."
  say "      Re-sync the stick from Windows and try again."
  say ""
  exit 1
fi
say "media: $MEDIA"

mkdir -p "$BIN" "$AUTO" || exit 1

install -m 0755 "$MEDIA/gui/als-autostart-shim.sh" "$SHIM" || exit 1
say "shim:  $SHIM"

# The layer's copy points at /usr/local/bin, which only exists once the layer is
# built. For this RAM test it has to point at the shim we just installed.
sed "s|/usr/local/bin/als-autostart|$SHIM|g" \
    "$MEDIA/gui/als-audit-station.desktop" > "$ENTRY" || exit 1
chmod 0644 "$ENTRY"
say "entry: $ENTRY"

if command -v desktop-file-validate >/dev/null 2>&1; then
  if desktop-file-validate "$ENTRY"; then
    say "valid: desktop-file-validate found no problems"
  else
    say ""
    say "  !!  desktop-file-validate complained (above). Stopping - gnome-session"
    say "      would likely ignore the entry. Nothing has been left running."
    say ""
    exit 1
  fi
else
  say "valid: desktop-file-validate not installed, skipped"
fi

if [ -n "$WANT_MODE" ]; then
  printf '%s\n' "$WANT_MODE" > "$MODEFILE" || exit 1
  say "mode:  $WANT_MODE   ->  $MODEFILE"
fi

# Same precedence als-autostart.sh uses: home first, then the stick.
MODE="probe"
for f in "$MODEFILE" "$MEDIA/gui/autostart.mode"; do
  [ -r "$f" ] && { MODE=$(tr -d '\r\n\t ' < "$f"); break; }
done

cat <<EOF

  Installed for this session only. Nothing on the stick was changed.

  mode: ${MODE:-probe}
        (one word in $MEDIA/gui/autostart.mode - edit it from Windows)

  NOW: log out and log back in.  Do NOT reboot.
       A logout exercises exactly the path a boot would - and a reboot would
       erase all of this, because the live session's home is held in RAM.

  In probe mode you should see a notification saying the autostart is working,
  and nothing else should start. If no notification appears, read the log:

      journalctl -b -t als-autostart

  To take it back out:

      bash $0 remove

EOF
