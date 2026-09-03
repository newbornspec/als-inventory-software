#!/usr/bin/env bash
#
# ALS Audit Station — start the graphical interface.
#
# Starts the local backend (which drives hardware-audit.sh) and opens the UI
# full-screen in a browser. No terminal interaction is needed afterwards.
#
# Put the gui/ folder in the USB root next to hardware-audit.sh and audit.conf:
#     /hardware-audit.sh
#     /audit.conf
#     /gui/server.py  /gui/index.html  /gui/start-gui.sh
#
# Then run:  bash /run/archiso/bootmnt/gui/start-gui.sh
# (or call this from autorun to boot straight into the GUI).
#
# Full-screen strategy (resolution-independent, works on ANY monitor):
#     Firefox --kiosk hides the toolbar but opens the window at ~90% and never
#     truly fullscreens, and no window manager auto-fills it. So in the X path we
#     start a bare (undecorated) kiosk browser and run gui/fullscreen-x.py — a
#     tiny python3 + libX11 resizer that fills the window to the exact screen.
#     It uses only packages guaranteed on any X system: no xdotool, no cage, no
#     window manager, no internet. If a Cage compositor happens to be present it
#     is used instead.
#
# Useful overrides:
#     ALS_GUI_PORT=8800     port for the local backend
#     ALS_BROWSER=firefox   force a particular browser binary
#     ALS_NO_CAGE=1         ignore Cage even if present
#     ALS_NO_X=1            skip the browser, just serve (headless/debug)

PORT="${ALS_GUI_PORT:-8800}"
URL="http://127.0.0.1:${PORT}"

# --- display fit ------------------------------------------------------------
# Force the active output to its HIGHEST-resolution mode so the kiosk fills the
# whole panel on any machine, instead of sitting inside a lower-res border.
# `xrandr --auto` only picks the "preferred" mode, which some panels report
# smaller than native — so we choose the largest mode by pixel area explicitly.
fit_display() {
  # ALS_NO_FIT=1 skips this entirely.
  #
  # Forcing a mode is right when a person runs this on a desktop that has
  # already settled. It is NOT right when the script is launched by an XDG
  # autostart entry at session start, because it then races GNOME's own display
  # configuration - and losing that race blanks the screen, with the desktop
  # otherwise running fine underneath. That is what an autostarted kiosk looked
  # like on a Dell here: no text, no error, just a lit panel showing nothing.
  [ "${ALS_NO_FIT:-0}" = "1" ] && { echo "fit_display: skipped (ALS_NO_FIT=1)"; return 0; }
  command -v xrandr >/dev/null 2>&1 || { echo "fit_display: xrandr not present — skipping"; return 0; }
  out=$(xrandr 2>/dev/null | awk '/ connected/{print $1; exit}')
  [ -n "$out" ] || { echo "fit_display: no connected output"; return 0; }
  mode=$(xrandr 2>/dev/null | awk -v o="$out" '
      $0 ~ "^"o" " {g=1; next}                     # start of our output block
      /^[^ ]/       {g=0}                            # a new output header ends it
      g && $1 ~ /^[0-9]+x[0-9]+$/ {print $1}         # collect its mode names
    ' | awk -Fx '{print ($1*$2)"\t"$0}' | sort -n | tail -1 | cut -f2)
  if [ -n "$mode" ] && xrandr --output "$out" --mode "$mode" 2>/dev/null; then
    echo "fit_display: $out set to $mode"
  else
    xrandr --output "$out" --auto 2>/dev/null && echo "fit_display: $out set to auto (preferred)"
  fi
}

# Let the xinit RC reuse this exact logic:  bash start-gui.sh --fit-display
if [ "${1:-}" = "--fit-display" ]; then fit_display; exit 0; fi

DIR=""
# The media may be an archiso stick (tools at the boot mount) or an Ubuntu stick
# (tools on a separate labelled partition) — ask the helper rather than guess.
_ALS_HELPER="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/find-media.sh"
_ALS_MEDIA=""
[ -r "$_ALS_HELPER" ] && { . "$_ALS_HELPER"; _ALS_MEDIA=$(als_find_media 2>/dev/null); }
for d in "${_ALS_MEDIA:-/nonexistent}/gui" /run/archiso/bootmnt/gui /cdrom/gui /mnt/usb/gui          "$(cd "$(dirname "$0")" && pwd)"; do
  [ -f "$d/server.py" ] && DIR="$d" && break
done
[ -n "$DIR" ] || { echo "server.py not found on the boot media."; exit 1; }
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"   # absolute path, for the xinit RC

command -v python3 >/dev/null 2>&1 || { echo "python3 is required but not installed."; exit 1; }

# ------------------------------------------------------------ what we have ---
# Find a browser we can run full-screen. Firefox first, then the usual others.
BROWSER=""
for b in ${ALS_BROWSER:-} firefox firefox-esr chromium chromium-browser google-chrome-stable falkon epiphany midori qutebrowser; do
  [ -n "$b" ] && command -v "$b" >/dev/null 2>&1 && { BROWSER="$b"; break; }
done

# Find a way to start X if we are not already inside a session.
XSTART=""
for x in xinit startx; do
  command -v "$x" >/dev/null 2>&1 && { XSTART="$x"; break; }
done

# Cage — used only if it happens to be present (see header).
CAGE=""
if [ "${ALS_NO_CAGE:-0}" != "1" ] && command -v cage >/dev/null 2>&1; then
  CAGE="cage"
fi

# The full-screen enforcer: a tiny python+libX11 resizer that fills the screen
# using ONLY packages guaranteed on any X system (no xdotool/cage/WM, no
# internet). Path is baked into the xinit RC below.
XFILL="$DIR/fullscreen-x.py"

kiosk_args() {   # per-browser full-screen flags
  case "$1" in
    firefox|firefox-esr)
      # NOT /tmp. On Ubuntu, Firefox is a snap, and a snap gets its OWN PRIVATE
      # /tmp - a fresh tmpfs inside its mount namespace. A profile path under
      # /tmp is written here, on the host, and is simply absent from the browser's
      # point of view, so the user.js below never applied and Firefox started on
      # a blank profile it had to invent. $HOME is reachable through the snap
      # home interface. No leading dot: the home interface does not reliably
      # cover hidden directories.
      PROFILE="${HOME:-/tmp}/als-ff-profile"
      mkdir -p "$PROFILE"
      # Suppress the first-run tour / import wizard on a fresh profile.
      cat > "$PROFILE/user.js" <<'PREFS'
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
PREFS
      printf '%s' "--profile $PROFILE --kiosk"
      ;;
    chromium|chromium-browser|google-chrome-stable)
      # Same private-/tmp trap as Firefox above - Chromium ships as a snap too.
      printf '%s' "--kiosk --start-fullscreen --window-position=0,0 --no-first-run --no-sandbox --user-data-dir=${HOME:-/tmp}/als-cr-profile"
      ;;
    *) printf '%s' "" ;;
  esac
}

start_browser() {  # runs in the foreground of whatever X we are in
  # Snap Firefox writes a page of GTK/canberra module warnings to stderr on
  # every start. None of it is fatal, all of it looks alarming, and it is the
  # last thing on screen while the operator waits for a window to appear - so
  # it goes to a log and the operator gets one line they can act on instead.
  local log="${HOME:-/tmp}/als-browser.log"
  echo
  echo "  Opening the interface … (first start can take up to a minute)"
  echo "  If no window appears, open a browser and go to:  $URL"
  echo "  Browser messages: $log"
  echo
  # shellcheck disable=SC2046
  "$BROWSER" $(kiosk_args "$BROWSER") "$URL" >"$log" 2>&1
  local rc=$?
  # It exited. Say why, and leave the operator somewhere to go.
  echo
  echo "  The kiosk browser exited (status $rc)."
  echo "  The backend is STILL RUNNING - open $URL in any browser."
  [ -s "$log" ] && { echo "  Last lines of $log:"; tail -5 "$log" | sed 's/^/    /'; }
  return $rc
}

launch_cage() {  # PRIMARY path: Cage owns the display and full-screens us on any monitor
  # Cage needs a Wayland runtime dir for its socket; create a private one if the
  # boot environment hasn't set one up.
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/als-xdg}"
  mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
  echo "cage · $BROWSER" > /tmp/als-launch
  echo "Launching kiosk under Cage (Wayland — auto full-screen at native resolution) …"
  case "$BROWSER" in
    chromium|chromium-browser|google-chrome-stable)
      # Run Chromium as a native Wayland client so it scales crisply to the panel.
      cage -- "$BROWSER" --kiosk --ozone-platform=wayland \
        --no-first-run --no-sandbox --user-data-dir=/tmp/als-cr-profile "$URL"
      ;;
    firefox|firefox-esr)
      # shellcheck disable=SC2046
      MOZ_ENABLE_WAYLAND=1 cage -- "$BROWSER" $(kiosk_args "$BROWSER") "$URL"
      ;;
    *)
      # shellcheck disable=SC2046
      cage -- "$BROWSER" $(kiosk_args "$BROWSER") "$URL"
      ;;
  esac
}

# ---------------------------------------------------------------- backend ----
echo "Starting ALS Audit Station backend on $URL …"
ALS_GUI_PORT="$PORT" python3 "$DIR/server.py" &
SRV=$!
trap 'kill "$SRV" 2>/dev/null' EXIT

# Wait for the backend before opening the browser. Poll /api/health, which is
# deliberately trivial (no hardware, no network), so this measures only whether
# the server is accepting connections. Opening the browser too early is what
# produces Firefox's "Unable to connect to 127.0.0.1:8800" page and makes the
# whole stick look dead, so the window is generous.
READY=0
for _ in $(seq 1 120); do          # up to 60s
  if command -v curl >/dev/null 2>&1; then
    curl -sf -o /dev/null --max-time 2 "$URL/api/health" && { READY=1; break; }
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$URL/api/health" <<'PY' && { READY=1; break; }
import sys, urllib.request
try:
    urllib.request.urlopen(sys.argv[1], timeout=2); sys.exit(0)
except Exception:
    sys.exit(1)
PY
  else
    sleep 3; READY=1; break
  fi
  sleep 0.5
done
[ "$READY" = "1" ] || echo "WARNING: backend did not answer in 60s — opening anyway."

# --------------------------------------------------------------- frontend ----
if [ "${ALS_NO_X:-0}" = "1" ]; then
  BROWSER=""            # explicitly headless
fi

if [ -n "$BROWSER" ] && { [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; }; then
  # Already inside a graphical session — fit the screen, then open the kiosk.
  echo "session · $BROWSER" > /tmp/als-launch
  fit_display
  start_browser

  # The kiosk browser exiting must NOT take the backend down with it.
  #
  # This branch used to fall straight off the end of the script, which fired
  # the EXIT trap above and killed the server. On Ubuntu that happens within
  # seconds: Firefox is a snap and a single-instance application, so when one
  # is already running our invocation hands the URL over and returns
  # immediately. The operator was left with browser tabs open and nothing
  # listening on the port - "Unable to connect" to a server that had been
  # killed by its own launcher.
  #
  # The backend is the actual product here; the kiosk is only a window onto it.
  # So outlive the browser and let the operator close this deliberately.
  echo
  echo "  The interface is still running at $URL"
  echo "  Leave this terminal open. Press Ctrl+C to stop the backend."
  wait "$SRV"

elif [ -n "$BROWSER" ] && [ -n "$CAGE" ]; then
  # PRIMARY: no session yet — Cage brings up the display itself at native
  # resolution and runs us full-screen. No xrandr guessing, no border, any panel.
  launch_cage
  echo
  echo "  The interface is still running at $URL"
  echo "  Leave this terminal open. Press Ctrl+C to stop the backend."
  wait "$SRV"

elif [ -n "$BROWSER" ] && [ -n "$XSTART" ]; then
  # No session yet — start a bare X session (no window manager, so the kiosk
  # window is undecorated) and run the python+libX11 resizer to fill the screen.
  echo "xinit(X) · $BROWSER +xfill" > /tmp/als-launch
  RC="/tmp/als-xinitrc"
  cat > "$RC" <<RCEOF
#!/bin/sh
xset s off -dpms 2>/dev/null
bash "$SELF" --fit-display
# Force the kiosk window to fill the screen using only python3 + libX11
# (guaranteed present; no packages to install, no internet, any resolution).
python3 "$XFILL" >/dev/null 2>&1 &
exec $BROWSER $(kiosk_args "$BROWSER") '$URL'
RCEOF
  chmod +x "$RC"
  if [ "$XSTART" = "startx" ]; then
    startx "$RC" -- :0 vt1
  else
    xinit "$RC" -- :0 vt1
  fi
  echo
  echo "  The interface is still running at $URL"
  echo "  Leave this terminal open. Press Ctrl+C to stop the backend."
  wait "$SRV"

else
  # Nothing to display with — say precisely what is missing so it can be fixed.
  echo
  echo "======================================================================"
  echo " The GUI backend is RUNNING, but no browser could be opened."
  echo "======================================================================"
  echo
  echo " On this machine:"
  if [ -n "$BROWSER" ]; then
    echo "   browser .......... $BROWSER (found)"
  else
    echo "   browser .......... NOT FOUND (looked for firefox, chromium, …)"
  fi
  if [ -n "$CAGE" ]; then
    echo "   cage (kiosk) ..... available (preferred full-screen path)"
  else
    if command -v apt-get >/dev/null 2>&1; then
      echo "   cage (kiosk) ..... not installed  →  apt-get install -y cage"
    else
      echo "   cage (kiosk) ..... not installed  →  pacman -Sy --noconfirm cage"
    fi
  fi
  if [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; then
    echo "   session .......... already running"
  elif [ -n "$XSTART" ]; then
    echo "   X session ........ not running, but '$XSTART' is available"
  else
    echo "   X session ........ NOT AVAILABLE (no cage/xinit/startx)"
  fi
  echo
  if [ -z "$BROWSER" ]; then
    echo " To install Firefox (needs internet — the audit Wi-Fi works):"
    if command -v apt-get >/dev/null 2>&1; then
      echo "     apt-get install -y firefox"
    else
      echo "     pacman -Sy --noconfirm firefox"
    fi
    echo " then run this script again."
    echo
  fi
  if [ -z "$CAGE" ]; then
    echo " For rock-solid full-screen on any monitor, install the Cage kiosk:"
    echo "     bash \"$DIR/install-cage.sh\"      (needs internet)"
    echo
  fi
  echo " Meanwhile the interface is fully usable from any browser on the"
  echo " network or on this machine at:"
  echo "     $URL"
  echo
  echo " Press Ctrl+C to stop."
  wait "$SRV"
fi
