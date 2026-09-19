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
#     kiosk               Full screen, no browser chrome, desktop hidden behind
#                         it. What an appliance should look like. Alt+F4 leaves.
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
# 3, not 12. The original number was a guess made while chasing a boot that
# would not start the app at all, and it was never revisited once it did. It is
# dead time on every single boot: the screen is up, the desktop is drawn, and
# this is sitting still. 3s still covers a slow GNOME finishing its own startup,
# and if a machine ever needs more, ALS_SETTLE overrides it without an edit.
# The kiosk session does not use this path at all - it waits on the backend
# answering, which is the right way round.
SETTLE="${ALS_SETTLE:-3}"
log "waiting ${SETTLE}s for the desktop to settle"
sleep "$SETTLE"

# Two places, home FIRST.
#
# The mode lives on the stick so it survives reboots, but /cdrom is mounted
# read-only, so changing it there means carrying the stick to a Windows machine
# and back. That is a slow loop for a one-word setting, and the point of this
# whole design was to stop paying for experiments in trips and reboots.
#
# So $HOME/als-autostart.mode wins when present. It is RAM on a live session, so
# it lasts exactly as long as the session - which is what you want while you are
# trying modes out. Once you know which one you want, put it on the stick.
MODE="probe"
MODE_SRC="default"
for f in "${HOME:-/root}/als-autostart.mode" "$MEDIA/gui/autostart.mode"; do
    if [ -r "$f" ]; then
        MODE=$(tr -d '\r\n\t ' <"$f" | tr 'A-Z' 'a-z')
        MODE_SRC="$f"
        break
    fi
done
case "$MODE" in
    probe|backend|full|kiosk) : ;;
    *) log "unrecognised mode '$MODE' in $MODE_SRC - falling back to probe"; MODE="probe" ;;
esac
log "mode=$MODE   (from $MODE_SRC)"
log "  to change it for THIS SESSION ONLY, no stick trip needed:"
log "      echo full > ${HOME:-/root}/als-autostart.mode   then log out and back in"
log "  to make it permanent, put the same word in $MEDIA/gui/autostart.mode from Windows"

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
# kiosk: one fullscreen window, no browser chrome, no desktop behind it.
#
# This was avoided for a while on the theory that a fullscreen window was what
# produced the blank screens. It was not - those were the /lib symlink bug in
# the overlay layer, which dangled display-manager.service so gdm never
# started. That is fixed and proven: the machine now boots, shows the ALS
# splash and reaches a desktop. The theory that kiosk mode hides failures died
# with it, so fullscreen is back.
#
# The safety that made a normal window attractive is kept anyway, and it costs
# nothing: this only runs AFTER the backend has answered on the port. A kiosk
# window is opened onto a URL already known to respond, never onto a hope.
#
# firefox-esr FIRST. A layer built by make-als-layer.sh bakes in Mozilla's
# firefox-esr .deb and masks snapd, because seeding the snaps was the slowest
# thing in the whole boot (~95 s, ~1.4 GB copied into RAM every time). On such
# a layer the snap Firefox does not exist; `firefox` is Mozilla's wrapper that
# execs firefox-esr, so it would work too, but naming the real binary means
# the process we start IS the browser, with no wrapper in between. On an older
# layer (or ALS_ESR=0) there is no firefox-esr, and `firefox` - the snap - is
# used exactly as before.
if [ "$MODE" = "kiosk" ]; then
    BROWSER=""
    for b in ${ALS_BROWSER:-} firefox-esr firefox chromium chromium-browser google-chrome-stable epiphany-browser; do
        [ -n "$b" ] && command -v "$b" >/dev/null 2>&1 && { BROWSER="$b"; break; }
    done
    if [ -z "$BROWSER" ]; then
        log "kiosk: no browser found - falling back to a normal window"
        note "ALS Audit Station" "No browser found for kiosk mode. Opening normally."
    else
        case "$BROWSER" in
            firefox|firefox-esr)
                # $HOME, never /tmp. The SNAP Firefox has its own private /tmp,
                # so a --profile under /tmp is invisible to it, and the snap
                # home interface does not reliably cover hidden directories -
                # hence no leading dot. firefox-esr is a plain .deb with no
                # such confinement; the same path works for it, so both share
                # one rule rather than two code paths.
                #
                # A SEPARATE directory per browser. Firefox refuses a profile
                # last written by a NEWER version ("You've launched an older
                # version of Firefox"), and the snap Firefox is always newer
                # than ESR. $HOME is RAM on a live boot so today they never
                # meet, but a persistent home, or switching browsers within a
                # session, would otherwise stop the kiosk on a dialog.
                PROFILE="${HOME:-/tmp}/als-kiosk-profile"
                [ "$BROWSER" = "firefox-esr" ] && PROFILE="${HOME:-/tmp}/als-kiosk-profile-esr"
                mkdir -p "$PROFILE"
                cat > "$PROFILE/user.js" <<'PREFS'
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("app.update.auto", false);
user_pref("browser.startup.upgradeDialog.enabled", false);
PREFS
                ARGS="--profile $PROFILE --kiosk"
                ;;
            *)  ARGS="--kiosk --start-fullscreen --no-first-run --window-position=0,0 --user-data-dir=${HOME:-/tmp}/als-kiosk-profile" ;;
        esac
        log "kiosk: $BROWSER $ARGS $URL"
        # No "Starting full screen" popup. It was the ONE note this script
        # raised on a successful kiosk boot, and it was wrong twice over: the
        # kiosk session has no notification service, so note() fell back to a
        # zenity dialog with an OK button that sat on screen until someone
        # clicked it; and "Press Alt+F4 to leave it" is false here - Alt+F4 is
        # a window-manager shortcut and this session has no window manager.
        # An appliance does not announce itself. The error notes above stay:
        # when something is BROKEN the operator needs telling.
        # shellcheck disable=SC2086
        setsid "$BROWSER" $ARGS "$URL" >>"${HOME:-/tmp}/als-browser.log" 2>&1 &
        log "kiosk pid $! - done"
        exit 0
    fi
fi

log "opening a normal (non-kiosk) browser window at $URL"
note "ALS Audit Station is ready" "Opening $URL in a normal window."
# firefox-esr by name when the layer carries it. xdg-open picks the desktop's
# DEFAULT browser, which on this image is firefox_firefox.desktop - the snap's
# entry, which does not exist once snapd is masked - and dpkg -x never ran
# update-desktop-database for firefox-esr.desktop, so what xdg-open would fall
# back to is not something to leave to chance.
if command -v firefox-esr >/dev/null 2>&1; then
    setsid firefox-esr --new-window "$URL" >>"${HOME:-/tmp}/als-browser.log" 2>&1 &
    log "firefox-esr pid $! - done"
    exit 0
fi
setsid xdg-open "$URL" >>"${HOME:-/tmp}/als-browser.log" 2>&1 &
log "xdg-open pid $! - done"
exit 0
