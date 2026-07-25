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
# Useful overrides:
#     ALS_GUI_PORT=8800     port for the local backend
#     ALS_BROWSER=firefox   force a particular browser binary
#     ALS_NO_X=1            skip the browser, just serve (headless/debug)

PORT="${ALS_GUI_PORT:-8800}"
URL="http://127.0.0.1:${PORT}"

# --- display fit ------------------------------------------------------------
# Force the active output to its HIGHEST-resolution mode so the kiosk fills the
# whole panel on any machine, instead of sitting inside a lower-res border.
# `xrandr --auto` only picks the "preferred" mode, which some panels report
# smaller than native — so we choose the largest mode by pixel area explicitly.
fit_display() {
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
for d in /run/archiso/bootmnt/gui /cdrom/gui /mnt/usb/gui "$(cd "$(dirname "$0")" && pwd)"; do
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

kiosk_args() {   # per-browser full-screen flags
  case "$1" in
    firefox|firefox-esr)
      PROFILE="/tmp/als-ff-profile"
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
      printf '%s' "--kiosk --start-fullscreen --window-position=0,0 --no-first-run --no-sandbox --user-data-dir=/tmp/als-cr-profile"
      ;;
    *) printf '%s' "" ;;
  esac
}

start_browser() {  # runs in the foreground of whatever X we are in
  # shellcheck disable=SC2046
  "$BROWSER" $(kiosk_args "$BROWSER") "$URL"
}

# ---------------------------------------------------------------- backend ----
echo "Starting ALS Audit Station backend on $URL …"
ALS_GUI_PORT="$PORT" python3 "$DIR/server.py" &
SRV=$!
trap 'kill "$SRV" 2>/dev/null' EXIT

# Wait for it to answer before opening the browser.
for _ in $(seq 1 40); do
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null "$URL" && break
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$URL" <<'PY' && break
import sys, urllib.request
try:
    urllib.request.urlopen(sys.argv[1], timeout=1); sys.exit(0)
except Exception:
    sys.exit(1)
PY
  else
    sleep 2; break
  fi
  sleep 0.5
done

# --------------------------------------------------------------- frontend ----
if [ "${ALS_NO_X:-0}" = "1" ]; then
  BROWSER=""            # explicitly headless
fi

if [ -n "$BROWSER" ] && [ -n "$DISPLAY" ]; then
  # Already inside a graphical session — fit the screen, then open the kiosk.
  fit_display
  start_browser

elif [ -n "$BROWSER" ] && [ -n "$XSTART" ]; then
  # No session yet — start one just for the kiosk browser. A window manager is
  # not required: the browser is the only client and takes the whole screen.
  RC="/tmp/als-xinitrc"
  cat > "$RC" <<RCEOF
#!/bin/sh
xset s off -dpms 2>/dev/null
bash "$SELF" --fit-display
exec $BROWSER $(kiosk_args "$BROWSER") '$URL'
RCEOF
  chmod +x "$RC"
  if [ "$XSTART" = "startx" ]; then
    startx "$RC" -- :0 vt1
  else
    xinit "$RC" -- :0 vt1
  fi

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
  if [ -n "$DISPLAY" ]; then
    echo "   X session ........ already running (DISPLAY=$DISPLAY)"
  elif [ -n "$XSTART" ]; then
    echo "   X session ........ not running, but '$XSTART' is available"
  else
    echo "   X session ........ NOT AVAILABLE (no xinit/startx)"
  fi
  echo
  if [ -z "$BROWSER" ]; then
    echo " To install Firefox (needs internet — the audit Wi-Fi works):"
    echo "     pacman -Sy --noconfirm firefox"
    echo " then run this script again."
    echo
  fi
  echo " Meanwhile the interface is fully usable from any browser on the"
  echo " network or on this machine at:"
  echo "     $URL"
  echo
  echo " Press Ctrl+C to stop."
  wait "$SRV"
fi
