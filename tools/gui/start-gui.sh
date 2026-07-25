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
#     start a bare (undecorated) kiosk browser and resize its window to the exact
#     screen geometry with xdotool — a borderless, full-screen fit on any panel.
#     xdotool is installed at boot if missing (Wi-Fi is brought up first). If a
#     Cage kiosk compositor happens to be present, that is used instead.
#
# Useful overrides:
#     ALS_GUI_PORT=8800     port for the local backend
#     ALS_BROWSER=firefox   force a particular browser binary
#     ALS_NO_CAGE=1         ignore Cage even if present
#     ALS_NO_AUTOSETUP=1    don't auto-install xdotool at boot
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

# The audit engine (for bringing Wi-Fi up early, before we install kiosk tools).
ENGINE=""
for e in "$DIR/../hardware-audit.sh" /run/archiso/bootmnt/hardware-audit.sh /cdrom/hardware-audit.sh /mnt/usb/hardware-audit.sh; do
  [ -f "$e" ] && ENGINE="$e" && break
done

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

# Cage — the preferred, resolution-independent full-screen path (see header).
CAGE=""
if [ "${ALS_NO_CAGE:-0}" != "1" ] && command -v cage >/dev/null 2>&1; then
  CAGE="cage"
fi

# Lightweight WM, only used as a last-resort fallback if xdotool is unavailable.
WM=""
for w in ${ALS_WM:-} openbox matchbox-window-manager jwm fluxbox icewm marco xfwm4; do
  [ -n "$w" ] && command -v "$w" >/dev/null 2>&1 && { WM="$w"; break; }
done

# ------------------------------------------------------- ensure kiosk tools ---
# The definitive full-screen fix. Firefox --kiosk hides the toolbar but opens at
# ~90% and never requests true fullscreen, and no WM auto-fills it — so we resize
# the window to the exact screen ourselves with xdotool. If xdotool (or cage)
# isn't on the live media yet, bring Wi-Fi up (the stick needs it for audits
# anyway) and install them. Fully gated + best-effort; never blocks boot.
online() { ping -c1 -W2 archlinux.org >/dev/null 2>&1 || ping -c1 -W2 8.8.8.8 >/dev/null 2>&1; }
if [ "${ALS_NO_AUTOSETUP:-0}" != "1" ] && command -v pacman >/dev/null 2>&1 \
   && ! command -v xdotool >/dev/null 2>&1; then
  if ! online && [ -n "$ENGINE" ]; then
    echo "Bringing Wi-Fi up for one-time full-screen setup …"
    bash "$ENGINE" --connect-wifi >/dev/null 2>&1 || true
  fi
  if online; then
    echo "Installing kiosk full-screen support (xdotool) …"
    pacman -Sy --noconfirm xdotool >/dev/null 2>&1 || true
  fi
fi

# xdotool is the linchpin of the X-fallback full-screen fix; note if we have it.
XTOOL=""
command -v xdotool >/dev/null 2>&1 && XTOOL="xdotool"

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

if [ -n "$BROWSER" ] && { [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; }; then
  # Already inside a graphical session — fit the screen, then open the kiosk.
  echo "session · $BROWSER" > /tmp/als-launch
  fit_display
  start_browser

elif [ -n "$BROWSER" ] && [ -n "$CAGE" ]; then
  # PRIMARY: no session yet — Cage brings up the display itself at native
  # resolution and runs us full-screen. No xrandr guessing, no border, any panel.
  launch_cage

elif [ -n "$BROWSER" ] && [ -n "$XSTART" ]; then
  # No session yet — start one just for the kiosk browser. A window manager is
  # not required: the browser is the only client and takes the whole screen.
  if [ -n "$XTOOL" ]; then
    echo "xinit(X) · $BROWSER +xdotool" > /tmp/als-launch
  else
    echo "xinit(X) · $BROWSER${WM:+ +$WM}" > /tmp/als-launch
  fi
  RC="/tmp/als-xinitrc"
  cat > "$RC" <<RCEOF
#!/bin/sh
xset s off -dpms 2>/dev/null
bash "$SELF" --fit-display
if command -v xdotool >/dev/null 2>&1; then
  # No WM: the --kiosk window is undecorated, so sizing it to the exact display
  # geometry gives a borderless, full-screen fit. Deterministic — this is the
  # fix. Loops because Firefox settles its window a moment after it loads.
  ( sleep 2
    G=\$(xdotool getdisplaygeometry 2>/dev/null); SW=\${G% *}; SH=\${G#* }
    [ -n "\$SW" ] || SW=1366; [ -n "\$SH" ] || SH=768
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
      WID=\$(xdotool search --name "ALS Audit" 2>/dev/null | head -n1)
      if [ -n "\$WID" ]; then
        xdotool windowmove "\$WID" 0 0 2>/dev/null
        xdotool windowsize "\$WID" "\$SW" "\$SH" 2>/dev/null
      fi
      sleep 2
    done ) &
else
  # No xdotool available — at least run a WM so a fullscreen request is honoured.
  ${WM:+$WM &}
fi
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
  if [ -n "$CAGE" ]; then
    echo "   cage (kiosk) ..... available (preferred full-screen path)"
  else
    echo "   cage (kiosk) ..... not installed  →  pacman -Sy --noconfirm cage"
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
    echo "     pacman -Sy --noconfirm firefox"
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
