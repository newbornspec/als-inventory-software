# Hardware Audit — bootable USB capture tool

Automatically read a device's hardware (CPU / RAM / storage / serial / battery) and
**save it into a lot** in Als Inventory — even on a wiped, OS-less machine — by
booting it from a Linux USB and running one script.

This is a **collection** tool, not verification. It does **not** check whether a
device was expected or received, or compare serials against any list. It simply
**creates the audited device inside the lot you're working on** (or re-audits it if
the same serial comes through again).

## Workflow

```
Create a lot  →  Select it (Set audit target)  →  Run the script  →  device saved into that lot
```

1. **Create a lot** in the web app (Lots → New Lot), e.g. `BATCH-000020`.
2. **Select the lot** you're auditing into: Lots → **"Set audit target"** on that lot.
   The banner at the top shows the current target. The tool files every audit here
   until you change it.
3. **Run the script** on each device (below). Confirm, and it uploads.

Devices then appear under that lot (expand the lot on the Lots page). Cosmetic grade
and functional tests stay a human call — finish those on the device's page.

---

## 1. Make the USB (once)

You don't need a custom image — a standard Ubuntu live USB is enough.

1. Download **Ubuntu Desktop LTS** (`.iso`) from ubuntu.com.
2. Flash it to an 8GB+ USB with **Rufus** (Windows), **balenaEtcher**, or the
   **Raspberry Pi Imager** ("Use custom image").
3. Copy **`hardware-audit.sh`** onto the stick, and next to it create an
   **`audit.conf`** with your server + login so runs are one-touch:
   ```
   AUDIT_URL="https://als-inventory-software-production.up.railway.app"
   AUDIT_EMAIL="you@company.com"
   AUDIT_PASSWORD="your-password"
   ```

## 2. Boot the device off the USB

1. Power on and open the **boot menu** (`F12` / `F9` / `Esc` / `F2` by make); pick the USB.
2. If it won't boot, disable **Secure Boot** in BIOS/UEFI and retry.
3. Choose **"Try Ubuntu"** (don't install).

## 3. Run the audit

1. Connect **Wi-Fi** (top-right) — or plug in Ethernet.
2. Open **Terminal** and run the script from the USB, e.g.:
   ```bash
   sudo bash /media/ubuntu/*/hardware-audit.sh
   ```
3. It shows the detected specs and the target lot, then asks **`Start audit into
   BATCH-000020? [Y/n]`**. Press Enter — it uploads and prints **✓ added to
   BATCH-000020**.

Repeat per machine: shut down, move the USB to the next device, boot, run.

---

## What it fills vs. what you finish

| Filled automatically by the tool | You finish on the device's page |
|---|---|
| Manufacturer, model, serial, category | Cosmetic grade (A/B/C/D/scrap) |
| CPU, RAM, storage | Functional tests (keyboard, ports, webcam, Wi-Fi…) |
| Battery health % | Data-wipe status + method, disposition |

## Troubleshooting

- **"No audit lot selected"** — set the target on a lot in the web (step 2), then re-run.
- **Wi-Fi adapter not found** — use a USB Ethernet or Wi-Fi dongle with in-kernel drivers.
- **Won't boot the USB** — disable Secure Boot; put USB above the internal disk in boot order.
- **Battery n/a** — expected on desktops.
- **Serial "To be filled by O.E.M."** — the device gets a generated tag; still saved to the lot.

The tool posts to `POST /devices/hardware-audit`. Nothing is stored on the USB beyond
your `audit.conf`; the login is used only to get a token per run.
