# Hardware Audit — bootable USB capture tool

Automatically read a device's hardware (CPU / RAM / storage / serial / battery) and
file it as an audit in Als Inventory — even on a **wiped, OS-less machine** — by
booting it from a Linux USB and running one script.

It matches the device by the **asset tag** you enter (the label on the unit), so the
device must already exist in Als Inventory (received into a lot). Cosmetic grade and
functional tests stay a human call — record those on the device's page afterwards.

---

## 1. Make the USB (once)

You do **not** need a custom image — a standard Ubuntu live USB is enough.

1. Download **Ubuntu Desktop LTS** (the `.iso`) from ubuntu.com.
2. Flash it to an 8GB+ USB stick with **Rufus** (Windows), **balenaEtcher**, or the
   **Raspberry Pi Imager** ("Use custom image").
3. Copy **`hardware-audit.sh`** (this folder) onto the same stick, or a second stick,
   so you can reach it after booting.

## 2. Boot the device off the USB

1. Insert the USB, power on, and open the **boot menu** (usually `F12`, `F9`, `Esc`,
   or `F2` depending on make) and pick the USB.
2. If it refuses to boot, enter BIOS/UEFI and **disable Secure Boot**, then retry.
3. At the Ubuntu screen choose **"Try Ubuntu"** (do **not** install).

## 3. Run the audit

1. Connect to **Wi-Fi** (network icon, top-right) — or plug in Ethernet.
2. Open **Terminal** (Activities → search "Terminal").
3. Run the script from wherever you copied it, e.g.:
   ```bash
   sudo bash /media/ubuntu/*/hardware-audit.sh
   ```
4. Check the detected specs, then enter:
   - the **asset tag** on the device,
   - your Als Inventory **email + password**.
5. It uploads and prints **✓ filed** (or **✗ no device with that tag** — create it in
   Als Inventory first, then re-run).

Repeat per machine: shut down, move the USB to the next unit, boot, run.

---

## What it fills vs. what you finish

| Filled automatically by the tool | You complete on the device's page |
|---|---|
| Manufacturer, model, serial | Cosmetic grade (A/B/C/D/scrap) |
| CPU, RAM, storage | Functional tests (keyboard, ports, webcam, Wi-Fi…) |
| Battery health % | Data-wipe status + method, disposition |

## Troubleshooting

- **Wi-Fi adapter not found** — some laptops need extra firmware; use a USB Ethernet
  adapter, or a USB Wi-Fi dongle with in-kernel drivers.
- **Won't boot the USB** — disable Secure Boot; make sure USB is above the internal
  disk in boot order.
- **Battery shows n/a** — expected on desktops / units with no battery.
- **Serial shows "To be filled by O.E.M."** — the manufacturer never programmed it;
  the tag you enter is what links the audit to the device regardless.

The tool talks to `POST /assets/hardware-audit`. Nothing is stored on the USB; the
only data sent is the specs above plus your login (used once to get a token).
