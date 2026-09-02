#!/usr/bin/env bash
#
# Install the Cage kiosk compositor so the ALS Audit GUI boots truly
# full-screen on ANY monitor (auto native-resolution, no border, no per-screen
# tweaking). Run this ONCE on a booted stick that has internet — the audit
# Wi-Fi is enough. After it succeeds, reboot (or re-run start-gui.sh) and the
# GUI launches under Cage automatically.
#
#   bash gui/install-cage.sh
#
# ---------------------------------------------------------------------------
# Making it PERMANENT (survive reboots):
#   A plain SystemRescue USB runs from a read-only image with a RAM overlay, so
#   packages installed at runtime vanish on reboot. Pick one:
#     * Enable SystemRescue write-persistence (a writable overlay partition/file
#       on the stick) so this install sticks — see the SystemRescue manual,
#       "Persistent storage". Recommended.
#     * Or just run this script once per session before the first boot-to-GUI.
#   Either way, if Cage is ever missing the GUI still boots via the built-in
#   X + xrandr fallback, so the stick is never dead — Cage only makes the
#   full-screen behaviour bullet-proof.
# ---------------------------------------------------------------------------

set -e

if command -v cage >/dev/null 2>&1; then
  echo "cage is already installed:  $(command -v cage)"
  echo "Nothing to do — the GUI will use it automatically."
  exit 0
fi

# Works on either live base: SystemRescue (pacman) or Ubuntu (apt). The Ubuntu
# stick is the one that boots with Secure Boot enabled — see DEVICE-LOCKS.md.
if command -v pacman >/dev/null 2>&1; then
  ALS_PKG=pacman
elif command -v apt-get >/dev/null 2>&1; then
  ALS_PKG=apt
else
  echo "No supported package manager found (expected pacman on SystemRescue or"
  echo "apt-get on Ubuntu). Install the 'cage' package by hand and re-run the GUI."
  exit 1
fi

# Confirm we actually have a route to the internet before hammering a mirror.
if ! ping -c1 -W2 8.8.8.8 >/dev/null 2>&1 && ! ping -c1 -W2 1.1.1.1 >/dev/null 2>&1; then
  echo "No internet detected. Connect to Wi-Fi/Ethernet first (the audit Wi-Fi works),"
  echo "then run this again:  bash gui/install-cage.sh"
  exit 1
fi

echo "Installing Cage (Wayland kiosk compositor) and its dependencies …"
if [ "$ALS_PKG" = pacman ]; then
  pacman -Sy --noconfirm cage
else
  apt-get update -qq
  apt-get install -y -qq cage
fi

echo
echo "Installed:  $(command -v cage)"
echo "Reboot, or run  bash gui/start-gui.sh  — the GUI will now open under Cage,"
echo "full-screen at the monitor's native resolution on any display."
