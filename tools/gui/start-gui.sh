#!/usr/bin/env bash
#
# ALS Audit Station — start the graphical interface.
#
# Starts the local backend (which drives hardware-audit.sh) and opens the UI
# full-screen in Firefox. No terminal interaction is needed afterwards.
#
# Put the gui/ folder in the USB root next to hardware-audit.sh and audit.conf:
#     /hardware-audit.sh
#     /audit.conf
#     /gui/server.py  /gui/index.html  /gui/start-gui.sh
#
# Then run:  bash /run/archiso/bootmnt/gui/start-gui.sh
# (or call this from autorun to boot straight into the GUI).

PORT="${ALS_GUI_PORT:-8800}"
URL="http://127.0.0.1:${PORT}"

DIR=""
for d in /run/archiso/bootmnt/gui /cdrom/gui /mnt/usb/gui "$(cd "$(dirname "$0")" && pwd)"; do
  [ -f "$d/server.py" ] && DIR="$d" && break
done
[ -n "$DIR" ] || { echo "server.py not found on the boot media."; exit 1; }

command -v python3 >/dev/null 2>&1 || { echo "python3 is required but not installed."; exit 1; }

# Backend
echo "Starting ALS Audit Station backend on $URL …"
ALS_GUI_PORT="$PORT" python3 "$DIR/server.py" &
SRV=$!
trap 'kill "$SRV" 2>/dev/null' EXIT

# Wait for it to answer before opening the browser.
for _ in $(seq 1 40); do
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null "$URL" && break
  else
    sleep 1; break
  fi
  sleep 0.5
done

# Frontend — full-screen Firefox. Under X if we have it, otherwise start X for it.
if [ -n "$DISPLAY" ] && command -v firefox >/dev/null 2>&1; then
  firefox --kiosk "$URL"
elif command -v xinit >/dev/null 2>&1 && command -v firefox >/dev/null 2>&1; then
  xinit "$(command -v firefox)" --kiosk "$URL" -- :0 vt1
else
  echo
  echo "Firefox/X not available — open this address in a browser instead:"
  echo "    $URL"
  echo "Press Ctrl+C to stop."
  wait "$SRV"
fi
