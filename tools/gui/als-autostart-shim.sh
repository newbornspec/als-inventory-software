#!/bin/sh
#
# ALS autostart shim  ->  goes in the layer at /usr/local/bin/als-autostart, 0755
#
# This is the ONLY moving part baked into the squashfs. It is deliberately tiny
# and contains no policy, because changing anything in here costs a mksquashfs
# rebuild plus a reboot. All behaviour lives in gui/als-autostart.sh ON THE
# STICK, which is a FAT32 file editable from Windows in Notepad.
#
# Two things it is careful about:
#
#   1. CRLF. The stick is FAT32 and will be edited on Windows. A single save in
#      an editor that writes CRLF turns `fi` into `fi\r`, bash reports a syntax
#      error nobody ever sees, and the autostart silently does nothing. So the
#      script is piped through sed to strip carriage returns before bash parses
#      it. This is why it is piped rather than executed: the fix has to happen
#      before the shebang would.
#
#   2. It never starts anything that can take over the screen. It hands off and
#      exits. If nothing is found it says so to the journal and exits 0, which
#      leaves the operator on a completely normal desktop.
#
# Read the handoff back with:  journalctl -b -t als-autostart

MEDIA=""
for d in /cdrom /isodevice /run/archiso/bootmnt /media/*/* ; do
    if [ -f "$d/gui/als-autostart.sh" ]; then MEDIA="$d"; break; fi
done

if [ -z "$MEDIA" ]; then
    logger -t als-autostart "no gui/als-autostart.sh on any medium - doing nothing"
    exit 0
fi

logger -t als-autostart "handing off to $MEDIA/gui/als-autostart.sh"

# bash -s reads the script from stdin and puts the remaining word in $1.
sed 's/\r$//' "$MEDIA/gui/als-autostart.sh" | bash -s "$MEDIA"

exit 0
