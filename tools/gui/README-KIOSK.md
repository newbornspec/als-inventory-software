# ALS Audit Station — bootable kiosk GUI (Phase 1)

A full-screen interface that launches on boot and wraps the three core
workflows — **Audit · Secure Wipe · Install OS** — plus Settings and power,
so an operator never touches a terminal.

## Architecture (three layers)

```
Engine (bash)                 Backend (Python, localhost:8800)      UI (browser, --kiosk)
────────────────              ──────────────────────────────        ───────────────────
hardware-audit.sh   ── run ──►  gui/server.py  ── serves ──►  gui/index.html
  • capture profile             • drives the engine
  • upload to API               • talks to ALS Inventory API
  • --wipe-drive <dev>          • job runner (wipe / install)
gui/install-os.sh   ◄─ run ──   • reads images/manifest.json
  • Clonezilla restore
```

The backend only knows each engine through a small contract (progress lines +
a final `WIPE_RESULT {json}` / `INSTALL_RESULT {json}`), so engines can be
swapped or added without touching the UI or backend.

## USB layout (copy these to the USB root)

```
/hardware-audit.sh          audit + wipe engine
/audit.conf                 server URL, login, Wi-Fi, wipe + admin PIN
/autorun/autorun            boots straight into the GUI (SystemRescue)
/gui/server.py              kiosk backend
/gui/index.html             kiosk UI
/gui/start-gui.sh           starts backend + kiosk browser
/gui/install-os.sh          OS install driver (Clonezilla restore)
/images/manifest.json       the Install-OS list (edit to add/remove OSes)
/images/<dir>/              one Clonezilla image folder per OS
```

## Boot-to-GUI (one-time per stick)

Boot the USB to the SystemRescue prompt, then:

```bash
mount -o remount,rw /run/archiso/bootmnt
mkdir -p /run/archiso/bootmnt/autorun
cp /run/archiso/bootmnt/autorun /run/archiso/bootmnt/autorun/autorun   # if not already the folder form
sync && reboot
```

The provided `autorun` launches `gui/start-gui.sh`, which starts the backend and
opens the UI full-screen (Firefox/Chromium `--kiosk`, starting X itself if
needed). If no browser/X is present it falls back to the text-mode audit so the
operator is never stuck.

## audit.conf keys used by the GUI

```
AUDIT_URL, AUDIT_EMAIL, AUDIT_PASSWORD   # inventory API + login
WIFI_SSID, WIFI_PASSWORD                 # editable from Settings
AUDIT_WIPE, AUDIT_WIPE_METHOD            # wipe defaults
AUDIT_ADMIN_PIN                          # optional; gates Settings-save + power
```

## Secure Wipe

The GUI lists internal drives only (the boot USB is excluded by the engine),
shows the auto-selected method per drive, requires a typed confirmation, and
streams progress. Each drive runs `hardware-audit.sh --wipe-drive /dev/xxx`,
reusing the tested firmware-erase / TRIM / shred + verify logic.

## Install OS (Clonezilla restore)

The list comes from `images/manifest.json` (dynamic — add entries + image
folders, no code change). Selecting an image + a target drive and confirming
runs `gui/install-os.sh <image_id> <device>`, which restores the Clonezilla
image with `ocs-sr`.

> **Needs on-hardware validation.** `ocs-sr` (Clonezilla / partclone) is **not**
> included in SystemRescue by default. Either add it to the boot media, or base
> the stick on a Clonezilla-capable live image. Until an image folder exists
> under `/images`, that OS shows a "image missing" badge and can't be started.

## Testing note

This runs on a machine **booted from the USB** (Linux); it can't be exercised
from a normal desktop. Test on real hardware:

1. Flash SystemRescue to the USB (Rufus/Ventoy), copy the files above.
2. Set up boot-to-GUI (section above), reboot into the kiosk.
3. Verify: hardware card populates → Audit uploads to a lot → Wipe on a scratch
   drive → (once Clonezilla + an image are present) Install OS on a scratch drive.
