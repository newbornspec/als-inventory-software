# ALS Audit Station - autostart behaviour.   LIVES ON THE STICK: gui/als-autostart.sh
#
# Invoked by /usr/local/bin/als-autostart as:
#     sed 's/\r$//' this-file | bash -s <media-dir>
# so $0 is "bash" and $1 is the mount point of the stick. There is no shebang on
# purpose - this file is piped into bash, never executed directly.
#
# WHY THIS EXISTS IN THIS SHAPE
#   Three boots were lost to an autostart entry that ran gui/start-gui.sh, which
#   opens Firefox with --kiosk. A kiosk window is fullscreen and undecorated, and
#   a fullscreen window is the ONE thing on GNOME that hides the top bar and the
#   dock. So a kiosk that opens but never paints anything readable is, to the
#   operator, "a lit panel with a background and nothing on it" - which is
#   exactly what was reported, and is indistinguishable from a dead machine.
#
#   Nothing in this script can do that. It opens no kiosk, sets no display mode,
#   starts no X server, and never calls start-gui.sh. The worst case here is a
#   normal Ubuntu desktop plus a notification saying what went wrong.
#
# MODES - edit gui/autostart.mode on the stick from Windows. No rebuild, no
# reburn, no reflash. One word:
#
#     probe    (default)  Prove the autostart mechanism fires. Shows a
#                         notification and starts NOTHING else. This is the mode
#                         to boot first, because it separates "does autostart
#                         work" from "does the app work".
#     backend             Also start gui/server.py and wait for it to answer.
#                         No browser is opened.
#     full                Also open the UI in a NORMAL browser window.
#
# Log:  ~/als-autostart.log   and   journalctl -b -t als-autostart

MEDIA="${1:-}"
LOG="${HOME:-/tmp}/als-autostart.log"
PORT="${ALS_GUI_PORT:-8800}"
URL="http://127.0.0.1:${PORT}"

# Only ever one of these per session.
exec 9>"${HOME:-/tmp}/.als-autostart.lock"
if ! flock -n 9; then
    logger -t als-autostart "another instance already running - exiting"
    exit 0
fi

log() {
    printf '%s  %s\n' "$(date '+%H:%M:%S')" "$*" >>"$LOG" 2>/dev/null
    logger -t als-autostart -- "$*" 2>/dev/null
}

# A desktop notification: a normal, dismissable popup. It is incapable of
# covering the screen. notify-send and zenity are both present on this image.
note() {
    notify-send -a "ALS Audit Station" -- "$1" "${2:-}" 2>/dev/null && return 0
    ( zenity --info --title="ALS Audit Station" --text="$1
${2:-}" >/dev/null 2>&1 & ) 2>/dev/null
    return 0
}

: >"$LOG" 2>/dev/null
log "=== ALS autostart ==="
log "media=${MEDIA:-none} user=$(id -un) session=${XDG_SESSION_TYPE:-unknown}"
log "DISPLAY=${DISPLAY:-unset} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-unset}"

if [ -z "$MEDIA" ] || [ ! -d "$MEDIA/gui" ]; then
    log "no usable media directory - stopping, desktop left completely normal"
    note "ALS autostart: stick not found" "The desktop is normal. Nothing was started."
    exit 0
fi

# Let the shell finish drawing before we do anything at all. This is done here,
# in our own script where it is logged and under our control, rather than with
# the .desktop key X-GNOME-Autostart-Delay - no stock entry on this image uses
# that key, and an unexercised code path is not what this stick needs.
SETTLE="${ALS_SETTLE:-12}"
log "waiting ${SETTLE}s for the desktop to settle"
sleep "$SETTLE"

MODE="probe"
if [ -r "$MEDIA/gui/autostart.mode" ]; then
    MODE=$(tr -d '\r\n\t ' <"$MEDIA/gui/autostart.mode" | tr 'A-Z' 'a-z')
fi
case "$MODE" in
    probe|backend|full) : ;;
    *) log "unrecognised mode '$MODE' - falling back to probe"; MODE="probe" ;;
esac
log "mode=$MODE   (set one word in $MEDIA/gui/autostart.mode: probe | backend | full)"

# ---------------------------------------------------------------- probe -----
if [ "$MODE" = "probe" ]; then
    log "probe: autostart fired correctly. Starting nothing else."
    note "ALS autostart is working" "Mode is 'probe', so nothing else was started. Set gui/autostart.mode to 'backend' or 'full' on the stick."
    exit 0
fi

# -------------------------------------------------------------- backend -----
GUI="$MEDIA/gui"

if [ ! -f "$GUI/server.py" ]; then
    log "server.py not found in $GUI - stopping"
    note "ALS: server.py not found" "Looked in $GUI. The desktop is normal."
    exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
    log "python3 not present - stopping"
    note "ALS: python3 is missing" "The backend cannot start. The desktop is normal."
    exit 0
fi

# NOTE: server.py's main() does real work on a background thread as soon as it
# starts - it sets the system clock with `date -u -s`, mounts the image server,
# and runs a full hardware refresh. That is intended behaviour for the audit
# tool, but it is the reason 'backend' is a separate mode from 'probe': it is a
# genuinely different experiment and deserves its own boot.
log "starting backend: python3 $GUI/server.py (port $PORT)"
ALS_GUI_PORT="$PORT" setsid python3 "$GUI/server.py" \
    >>"${HOME:-/tmp}/als-backend.log" 2>&1 &
log "backend pid $!  (stdout -> ${HOME:-/tmp}/als-backend.log)"

# curl is NOT on this image - verified against every casper layer - so the
# health check is python3.
health() {
    python3 -c 'import sys,urllib.request
try:
    urllib.request.urlopen(sys.argv[1], timeout=2)
except Exception:
    sys.exit(1)
' "$URL/api/health" >/dev/null 2>&1
}

READY=0
for _ in $(seq 1 60); do
    if health; then READY=1; break; fi
    sleep 1
done

if [ "$READY" != "1" ]; then
    log "backend did not answer on $URL within 60s - NOT opening a browser"
    note "ALS backend did not start" "No browser was opened, deliberately. See $LOG"
    exit 0
fi
log "backend is answering on $URL"

if [ "$MODE" = "backend" ]; then
    note "ALS backend is running" "Open $URL in a browser. Mode is 'backend'."
    log "mode=backend: not opening a browser. Done."
    exit 0
fi

# ----------------------------------------------------------------- full -----
# A NORMAL window. No --kiosk, no --profile, no fullscreen, no xrandr. A normal
# window cannot hide the top bar or the dock, so if anything about the browser
# misbehaves the operator still has a usable desktop to work from.
log "opening a normal (non-kiosk) browser window at $URL"
note "ALS Audit Station is ready" "Opening $URL in a normal window."
setsid xdg-open "$URL" >>"${HOME:-/tmp}/als-browser.log" 2>&1 &
log "xdg-open pid $! - done"
exit 0
