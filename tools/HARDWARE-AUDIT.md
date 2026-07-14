# Hardware Audit — bootable USB capture tool

Automatically read a device's hardware (CPU / RAM / storage / serial / battery) and
**save it into a lot** in Als Inventory — even on a wiped, OS-less machine — by
booting it from a Linux USB and running one script.

This is a **collection** tool, not verification. It does **not** check whether a
device was expected or received, or compare serials against any list. It simply
**creates the audited device inside the lot you're working on** (or re-audits it if
the same serial comes through again).

The script runs on **SystemRescue** and on **Ubuntu** live USBs — it detects which
Wi-Fi stack is present (`iwd` on SystemRescue, NetworkManager on Ubuntu) and needs
no `jq` or other extras.

## Workflow

```
Create a lot  →  Select it (Set audit target)  →  Run the script  →  device saved into that lot
```

1. **Create your lots** in the web app (Lots → New Lot), e.g. `BATCH-000020`.
2. *(Optional)* **Set a default lot**: Lots → **"Set audit target"**. The script
   pre-selects it, so a run of machines into one lot is just Enter each time.
3. **Run the script** on each device (below). It lists every lot and lets you
   **pick which one this device goes into** (press Enter for the default target,
   or type a number to switch) — and optionally a sub-lot — so you can send
   different machines to different lots without touching the web between them.

Devices then appear under that lot (expand the lot on the Lots page). Cosmetic grade
and functional tests stay a human call — finish those on the device's page.

---

## 1. Make the USB (once)

You don't need a custom image — a standard **SystemRescue** or **Ubuntu** live USB is enough.

1. Download **SystemRescue** (`.iso`, systemrescue.org) — or Ubuntu Desktop LTS.
2. Flash it to an 8GB+ USB with **Rufus** (Windows), **balenaEtcher**, or **Ventoy**.
3. Copy **`hardware-audit.sh`** onto the stick, and next to it create an
   **`audit.conf`** with your server, login, **and Wi-Fi** so runs are fully hands-off:
   ```
   AUDIT_URL="https://als-inventory-software-production.up.railway.app"
   AUDIT_EMAIL="you@company.com"
   AUDIT_PASSWORD="your-password"

   # Connected automatically at the start of each run.
   # Leave WIFI_SSID blank if you use wired Ethernet.
   WIFI_SSID="YOUR_WIFI_NAME"
   WIFI_PASSWORD="YOUR_WIFI_PASSWORD"
   ```
   Put `audit.conf` in the **root of the USB** (or beside the script) — the tool looks
   in both places, plus the SystemRescue boot mount, automatically.

## 2. Boot the device off the USB

1. Power on and open the **boot menu** (`F12` / `F9` / `Esc` / `F2` by make); pick the USB.
2. If it won't boot, disable **Secure Boot** in BIOS/UEFI and retry.
3. On SystemRescue, let it boot to the default option (root auto-login, text console).

## 3. Run the audit

No network setup needed — the script connects to the Wi-Fi in `audit.conf` itself.

1. Find the stick (SystemRescue auto-mounts USBs under `/run/archiso/bootmnt` or
   `/mnt`). Run it, e.g.:
   ```bash
   bash /run/archiso/bootmnt/hardware-audit.sh
   ```
   (On Ubuntu: `sudo bash /media/*/*/hardware-audit.sh`.)
2. It brings up Wi-Fi (**"Connecting to Wi-Fi …"** → **"Wi-Fi connected."**) and reads
   the specs, then lists your lots:
   ```
   Available lots:
     1) BATCH-000020  ← current audit target
     2) BATCH-000021
   File this device into which lot? [number, or Enter for BATCH-000020]
   ```
   Press Enter for the default, or type a number to send this machine elsewhere;
   optionally pick a sub-lot; confirm **`Start audit into … ? [Y/n]`** and it uploads.

Repeat per machine: shut down, move the USB to the next device, boot, run — choosing
each machine's lot on the spot, no web round-trip.

### Optional — run it fully automatically at boot (SystemRescue autorun)

SystemRescue can run a script the moment it boots, so the operator does nothing at all:
name a copy of the script `autorun` in the USB root and boot with the `ar_nowait`
option (Tab/`e` at the boot menu, append `ar_nowait=1`). The script connects Wi-Fi and
audits with no typing. Keep the interactive confirm off for this mode by answering `Y`
by default (it already defaults to Yes on Enter). Most operators prefer the one-command
run above so they can eyeball the specs before uploading.

---

## What it fills vs. what you finish

The tool captures a **full hardware profile** and stores it verbatim (extensible —
new fields need no software change). Warehouse/manual fields are kept separate and
are **never overwritten** by an audit.

| Filled automatically by the tool | You finish on the device's page |
|---|---|
| Manufacturer, family, model, device type, serial, **Dell express code**, BIOS UUID | Cosmetic grade (A/B/C/D/scrap) |
| BIOS version/date, UEFI/Legacy, Secure Boot, TPM | Functional tests (keyboard, ports, webcam, Wi-Fi…) |
| CPU model/cores/threads/clock, RAM size/type/speed/slots | Data-wipe status + method, disposition |
| Per-drive model/capacity/type/interface/**SMART**/serial | Grade, cost, location, notes, resale value |
| Graphics, battery (design/full/cycle/health), network + MAC | |

Some fields depend on the machine and boot: **OS/build** (usually none — units are
wiped), **BitLocker / BIOS-password state**, and **display EDID** may come back blank.
That's expected — the profile simply omits what it can't read.

### Check a machine without uploading

To see exactly what a device reports (handy for a new model), run:
```bash
AUDIT_DEBUG=1 bash /run/archiso/bootmnt/hardware-audit.sh
```
It prints the captured JSON and exits — no Wi-Fi, no login, no upload.

## Troubleshooting

- **"Could not reach the server over Wi-Fi"** — check `WIFI_SSID` / `WIFI_PASSWORD` in
  `audit.conf` (case-sensitive), that the network is 2.4/5GHz WPA2 (not a captive
  portal), and that the machine has a working Wi-Fi adapter. Plug in Ethernet as a fallback.
- **"No audit lot selected"** — set the target on a lot in the web (step 2), then re-run.
- **Wi-Fi adapter not found** — some laptops need a firmware package not on the live
  image; use a USB Ethernet or a well-supported Wi-Fi dongle.
- **Won't boot the USB** — disable Secure Boot; put USB above the internal disk in boot order.
- **Battery n/a** — expected on desktops.
- **Serial "To be filled by O.E.M."** — the device gets a generated tag; still saved to the lot.

The tool posts to `POST /devices/hardware-audit`. Nothing is stored on the USB beyond
your `audit.conf`; the login is used only to get a token per run.
