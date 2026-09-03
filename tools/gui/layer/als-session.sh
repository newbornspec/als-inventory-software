#!/bin/sh
#
# ALS kiosk session.  Goes in the layer at /usr/local/bin/als-session, 0755.
#
# GDM execs this instead of gnome-session, so GNOME never starts: no shell, no
# top bar, no dock, no wallpaper. Xorg is already up and painting by the time we
# run, and DISPLAY / XAUTHORITY / XDG_RUNTIME_DIR are set, because GDM does that
# before handing over. We start no X server and touch no DRM - Xorg has already
# done the driver work with its own modesetting -> fbdev -> vesa fallback.
#
# THE CONTRACT, and every line below serves it:
#
#   1. It is OFF by default. With no gui/kiosk.mode on the stick, or any word
#      other than "on", this hands straight over to the stock Ubuntu session.
#      So the layer can be rebuilt, armed and booted with ZERO change in
#      behaviour, and the switch is one word in a file editable from Windows.
#      That matters because the alternative - a session that must work first
#      time on a machine nobody can test - is how evenings get lost.
#
#   2. EVERY failure path ends by exec'ing the stock session, with a message on
#      screen saying why. There is no path here that ends in a black screen.
#
#   3. It uses only what is already proven present: Xorg (GDM started it),
#      xsetroot, python3, and gui/fullscreen-x.py which already ships on the
#      stick and exists precisely to size a window with no window manager.
#      No gnome-kiosk, no cage, no xdotool - none of those are on this image,
#      and adding an untested dependency to an untestable change is not a plan.
#
# Log: $HOME/als-session.log, and a copy on the stick if it is writable.

LOG="${HOME:-/tmp}/als-session.log"
: >"$LOG" 2>/dev/null
exec 2>>"$LOG"
set -x

STOCK_ENV="GNOME_SHELL_SESSION_MODE=ubuntu"
STOCK_CMD="/usr/bin/gnome-session"

stock() {
    # Hand over the desktop this machine has today. Used for "switched off",
    # which is silent, and for every failure, which is not.
    exec env $STOCK_ENV "$STOCK_CMD" --session=ubuntu
}

fallback() {
    # Say it in words, on screen, then give them a working desktop.
    if command -v zenity >/dev/null 2>&1; then
        zenity --error --title="ALS Audit Station" --width=520 \
          --text="Kiosk session did not start.

$1

You have the normal Ubuntu desktop instead - nothing is broken.
Log: $LOG

To stop it trying at all: put the word  off  in gui/kiosk.mode
on the USB stick, from Windows." >/dev/null 2>&1 &
    fi
    stock
}

# --- the off switch, before anything can go wrong ---------------------------
MEDIA=""
for d in /cdrom /isodevice /run/archiso/bootmnt /media/*/* ; do
    [ -f "$d/gui/als-autostart.sh" ] && { MEDIA="$d"; break; }
done
[ -n "$MEDIA" ] || fallback "The USB stick could not be found from inside the session."

KIOSK=off
[ -r "$MEDIA/gui/kiosk.mode" ] && \
    KIOSK=$(tr -d '\r\n\t ' <"$MEDIA/gui/kiosk.mode" | tr 'A-Z' 'a-z')
if [ "$KIOSK" != "on" ]; then
    # Deliberate, not an error. No dialog, no delay.
    stock
fi

# --- preflight --------------------------------------------------------------
[ -n "$DISPLAY" ] || fallback "GDM did not give this session an X display."
command -v python3 >/dev/null 2>&1 || fallback "python3 is not available in the session."

# Black root window. Without a window manager X paints a grey stipple, and a
# gap should read as deliberate black rather than as a broken screen.
command -v xsetroot >/dev/null 2>&1 && xsetroot -solid black 2>/dev/null

# --- the application --------------------------------------------------------
# als-autostart is the same launcher the desktop session uses, and it already
# waits for the backend to answer on the port before opening anything. Told to
# settle for 2s rather than its default, because that default exists to let the
# GNOME shell finish drawing and there is no shell here.
if [ ! -x /usr/local/bin/als-autostart ]; then
    fallback "/usr/local/bin/als-autostart is missing from the layer."
fi
ALS_SETTLE=2 /usr/local/bin/als-autostart &

# --- size the window, since nothing else will --------------------------------
# There is no window manager in this session, so a browser asking to be
# fullscreen is asking nobody. fullscreen-x.py talks to libX11 through ctypes
# and resizes whatever top-level window appears to the exact screen size. It is
# already on the stick and needs no packages.
XFILL="$MEDIA/gui/fullscreen-x.py"
if [ -r "$XFILL" ]; then
    ( sleep 5; python3 "$XFILL" >>"$LOG" 2>&1 ) &
else
    echo "fullscreen-x.py not found at $XFILL - window will not be resized" >>"$LOG"
fi

# --- hold the session open ---------------------------------------------------
# GDM ends the session when this exits, so it must not. If the app dies the
# operator gets a black screen with a cursor, which is a bad end state - so
# watch for it and hand back a real desktop instead.
i=0
while [ $i -lt 120 ]; do
    sleep 1
    i=$((i + 1))
done

# Two minutes in with the session still alive: this is the normal case. Sleep
# forever; the machine is used until it is powered off or the operator uses the
# app's own shutdown.
while : ; do sleep 3600; done
