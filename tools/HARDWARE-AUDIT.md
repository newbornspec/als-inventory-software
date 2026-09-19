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

> **The station in use is the Ubuntu stick** (Secure Boot capable, graphical
> kiosk) — see **`UBUNTU-STICK.md`**. No SystemRescue stick is in use any more
> (owner decision D41); the SystemRescue steps below (auto-run, `/run/archiso`
> paths) are kept for reference only. For `audit.conf`, start from
> **`audit.conf.example`**: it has every setting, with a dedicated station
> account rather than a person's login. **Wiping is done on the kiosk screen
> only** — see "Secure data wipe" below.
>
> **Testing a new stick or a new release on real hardware:** follow
> **`HARDWARE-TESTS.md`** — the owner's on-station checklist, most important
> checks first.

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
   (On Ubuntu: `sudo bash /cdrom/hardware-audit.sh` — casper mounts the boot
   medium at `/cdrom`, and udisks does not re-mount an already-mounted boot
   device under `/media`, so the old `/media/*/*` glob here never expanded and
   left the operator with "No such file or directory" and no hint where to look.)
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

## Run it without typing the command

You don't have to type `bash …/hardware-audit.sh`. Two ways, pick one:

### A. Auto-run at boot (recommended — no typing at all)

Per SystemRescue's manual, it runs scripts found **inside an `autorun` folder** at the
boot-device root — **not** a file named `autorun` in the root. Autorun is on by
default and doesn't pause (`ar_nowait` defaults to true), so no boot options are
needed. Set it up once per stick, at the console:

```bash
mount -o remount,rw /run/archiso/bootmnt
mkdir -p /run/archiso/bootmnt/autorun
printf '#!/bin/bash\nexec bash /run/archiso/bootmnt/hardware-audit.sh\n' > /run/archiso/bootmnt/autorun/autorun
cat /run/archiso/bootmnt/autorun/autorun   # should show the two lines
sync && reboot
```

After the reboot the machine launches the audit on its own — connect Wi-Fi → read
specs → lot menu — and the operator only picks the lot and confirms.

The `autorun/autorun` script is just a one-line wrapper that runs `hardware-audit.sh`
from the USB. `hardware-audit.sh` and `audit.conf` still live in the USB **root**.
(A ready-made copy of the wrapper is `tools/autorun` in this repo; place it at
`autorun/autorun` on the stick.) Reference:
<https://www.system-rescue.org/manual/Run_your_own_scripts_with_autorun/>

> Quick reference for operators: see **`SETUP-AUTORUN.txt`** (plain text) in this
> folder — copy it onto the USB so the steps are always to hand.

### B. Fully baked custom image (advanced)

For a fleet, you can rebuild a custom SystemRescue ISO with the script, `audit.conf`
and `ar_nowait` compiled in, so a written USB just works. This is a lot more effort
than option A for the same end result, so only do it at scale.

---

## Secure data wipe (DESTRUCTIVE) — kiosk screen only

The station securely erases a machine's **internal** drives and records each one
automatically: the record lands on the device's audit and feeds the
**Certificate of Data Erasure**.

**Wiping is done on the kiosk screen, and nowhere else.** The text-mode script
used to have its own wipe (`AUDIT_WIPE="1"` in `audit.conf`, then type `WIPE`).
It erased every drive in turn and filed them all as **one** result, so a machine
with one wiped and one failed drive got a single record that could not say which
was which. It is **retired** (owner decision D9, 19 Sep 2026): with
`AUDIT_WIPE="1"` the text-mode script now only prints that wiping is done from
the kiosk screen, and erases nothing. Delete the line from old `audit.conf`
files; leaving it is harmless.

### How a wipe runs

1. **Read the machine first.** The kiosk will not start a wipe until it has
   captured this machine's hardware profile (and not while a capture is still
   running). Without it there is nothing to file the wipe under, and an erase
   with no record is worse than no erase. If the screen says so, press
   **Rescan** and wait.
2. **Pick the drive(s) and the method**, then confirm. The confirm dialog names
   the drives and the batch the records will go to. Several drives of one
   machine can be picked at once; each still runs as **its own job, with its
   own result and its own record** — one record per drive, never a merged one.
3. **The drive is checked against the capture, twice, before anything is
   written.**
   - The kiosk only offers internal, fixed drives (never USB, never removable,
     never the stick you booted from), re-reads the drive list at the moment
     you press start, and refuses a drive whose serial was **not in the
     captured profile** — it may have been plugged in or swapped since. Press
     **Rescan**, then try again.
   - The engine then reads the drive's own serial and refuses if it is **not
     the drive you picked** (`/dev` names are handed out at boot and can move
     to a different disk).
   - A drive that reports **no serial at all** is allowed (owner decision D18):
     it is wiped and its record carries no drive serial (identity unknown).
     The certificate does **not** yet say so: today it prints only the
     machine's own serial and the method, with no line per drive. A
     per-drive certificate is planned (owner decisions D18/D23).
4. **Read the result** for each drive. There are exactly three:

   | Result | What it means | What is recorded |
   |---|---|---|
   | **Wiped** | The erase ran and the drive read back as zeros afterwards — **or** it was a firmware erase the drive reported as done, which is accepted without that check ("controller-confirmed", see *The check afterwards* below). | A wipe record for **that drive** (serial, model, method, start and finish time, tool version). Makes the certificate for the **whole machine** available — see *Wipe EVERY internal drive* below. |
   | **Failed** | The erase was attempted but did not complete or did not pass its check (a drive that stalls, errors, or does not read back clean; a job that dies without a result counts as failed). Treat the drive as **still holding data**, possibly partly erased. | A **failed** record for that drive, so the asset shows the failure. Wipe it again before it can be resold. |
   | **Refused** | **Nothing was written to the drive.** It was the wrong drive (serial mismatch), a USB / removable / boot disk, or not a real disk. | **Nothing.** A refusal is not filed, because the drive was never touched. |

   With no network the wipe still completes: the record is saved on the stick
   and uploaded automatically later, with the time the wipe actually happened.
   Each finished wipe is also marked on the stick straight away, so restarting
   the kiosk cannot lose a record.

**Wipe EVERY internal drive of the machine before relying on its
certificate.** Today the certificate is for the whole device and is issued as
soon as **one** drive is recorded as wiped. A drive that was never wiped has no
record at all, so nothing blocks the certificate: pick only the NVMe of a
laptop that also has a SATA disk, and the kiosk says "Erasure certificate now
available" while the SATA disk still holds the customer's data. Check the drive
list against the captured profile and wipe each one. (A per-machine roll-up
that withholds the certificate until every drive of the machine is wiped is
planned, owner decision D23; it is not on the station yet.)

**Certificates.** A drive recorded as wiped makes the certificate available —
unless the same asset also has a **failed** wipe record that is newer than the
wiped one, or less than 24 hours older than it. Then no certificate is issued,
because one of the machine's drives may still hold data (owner decision D11, an
interim guard until the certificate lists every drive of the machine). The
accepted cost: a drive that failed and was re-wiped successfully within the same
day stays without a certificate until it is wiped once more, more than 24 hours
after the failure.

### Methods

The method the kiosk pre-selects comes from `AUDIT_WIPE_METHOD` in `audit.conf`
(changing that default from the Settings screen needs the admin PIN); the
operator can pick another for each wipe.

- `auto` (default) — the drive's own **cryptographic erase** if it supports one,
  else its firmware **secure erase**, else an overwrite.
- `crypto` — cryptographic erase (self-encrypting drives / NVMe), else overwrite.
- `secure` — firmware secure erase (ATA `hdparm` / NVMe), else overwrite.
- `overwrite` — one random pass and one zero pass (`shred`), read back.
- `zero` — a single zero pass, read back (NIST "Clear", half the time).

Firmware secure / crypto erase is NIST 800-88 **"Purge"** (it also reaches spare
and reallocated areas); an overwrite is **"Clear"**, and on flash it reaches only
the blocks the operating system can address — the recorded method says so. There
is **no TRIM step**: TRIM is a hint to the drive, not an erase, and a TRIMmed SSD
reads back as zeros whether or not its data is gone.

**Frozen SATA drives:** the BIOS usually marks SATA drives security-frozen at
boot, which blocks ATA secure erase, so such a drive is overwritten instead.
`AUDIT_WIPE_UNFREEZE="1"` suspends/resumes briefly to unfreeze, but some
machines never resume, so it stays off (owner decision D42). NVMe has no frozen
state.

**The check afterwards.** Every wipe ends with a read-back of the drive (start,
middle and end), and what happens when it does not read as zeros depends on how
the drive was erased:

- **Overwrite** (`overwrite` / `zero`, or any drive whose firmware erase was
  unavailable): the drive is overwritten in full once more and read back again;
  if it still does not read as zeros, the result is **Failed**.
- **Any firmware erase** — NVMe crypto erase, NVMe secure erase
  (`nvme format -s1`), NVMe block-erase sanitize, ATA secure erase, enhanced or
  not: **today the result is Wiped anyway.** The erase is accepted on the
  drive's word, labelled **"controller-confirmed"** in the recorded method, and
  **no overwrite is run**. That is right for a genuine crypto erase (it leaves
  unreadable ciphertext, not zeros), but the same label is given to a plain
  secure erase or block erase whose firmware reported success and left the data
  where it was. **Treat a method ending "— controller-confirmed" as the drive's
  own claim, not as a checked result**; "— verified (reads as zeros)" is the
  checked one. If a controller-confirmed result is not good enough for a
  machine, wipe that drive again with `overwrite`.

A stricter read-back after firmware erases is planned (plan step 31, owner
decision D31: a read-back that cannot confirm the erase will be recorded as
**Failed**). Until it ships, the above is what the station does.

> ⚠️ This permanently destroys data. Check the drive's **size and model** (and
> its serial, on a kiosk version that shows it) against the drive you mean
> before confirming, and test on a **sacrificial drive** first after any change
> to the stick.

---

## Rebuild the layer once for the pending boot changes (Ubuntu stick)

The Ubuntu stick boots through an overlay layer,
`casper/minimal.standard.live.als.squashfs`, built **on the station** by
`make-als-layer.sh`. The boot changes shipped in September 2026 — Firefox ESR
baked in, snapd switched off (only when ESR really went in), and the update
stamps that stop ldconfig re-running every boot — live **in that layer**, so
copying new files onto the stick is not enough: the layer has to be rebuilt
**once**. The why and the detail are in `UBUNTU-STICK.md`, "Boot speed".

The kiosk and the engine (`gui/`, `hardware-audit.sh`) are read from the stick
at every boot, so they do **not** need a rebuild — a sync is enough for those.

1. **On Windows, sync the stick** so it carries the current
   `make-als-layer.sh`:
   ```powershell
   .\tools\sync-usb.ps1 -Drive <letter> -Apply
   ```
2. **Keep a copy of the current layer** — it is the quickest way back. Copy
   `<letter>:\casper\minimal.standard.live.als.squashfs` to a folder on the PC.
   The build overwrites it and keeps no backup of its own.
3. **Boot the stick on a station machine, with internet** (the build downloads
   the packages and Firefox ESR). From the live session open a terminal and run:
   ```sh
   sudo bash /cdrom/make-als-layer.sh build --with-session
   ```
   It takes several minutes. Read the end of its output:
   - `firefox-esr baked in` and `masked: snapd…` — the full change went in.
   - `ESR skipped, snapd left alone` (no internet, or the key or download did
     not check out) — the layer is still good and boots exactly as before, only
     without the speed-up. Fix the cause and build again. If it says the
     **Mozilla key did not match**, do not work around it (see
     `UBUNTU-STICK.md`).
   - An error **before** the step `Copying onto the stick` stops the build
     with the stick untouched.
   - `copy failed` is the exception: it comes **during** that copy, which
     overwrites the layer on the stick in place. The layer on the stick is
     then **damaged** and the stick is still armed, so the next boot from it
     would fail. Do not boot the stick again until you have put back the copy
     from step 2 from Windows (see *Going back*). The usual cause is the stick
     running out of space: the new layer is larger than the old one.
4. **Check and reboot:**
   ```sh
   sudo bash /cdrom/make-als-layer.sh status
   ```
   The `ALS layer` line should show a size and the `armed` line `yes`. The
   build does not touch `grub.cfg`, so a stick that was armed stays armed. If
   `armed` says `no`, run `sudo bash /cdrom/make-als-layer.sh arm`. Then reboot and check the
   kiosk comes up.

Do this **once**. Rebuild again only when `make-als-layer.sh` itself or the
package list changes.

### Going back

Any one of these:

- **Put the copy from step 2 back** from Windows over
  `<letter>:\casper\minimal.standard.live.als.squashfs`. The layer file is the
  whole change; the next boot behaves like the old one.
- **Build without the change:**
  `sudo env ALS_ESR=0 bash /cdrom/make-als-layer.sh build --with-session` —
  no Firefox ESR, snapd left on (snaps seed as before). Add
  `ALS_UPDATE_STAMPS=0` to leave the update stamps out as well.
- **Remove the layer entirely:** `sudo bash /cdrom/make-als-layer.sh undo` —
  deletes the layer and takes it out of `grub.cfg`; the stick boots plain
  Ubuntu (no baked-in packages, no kiosk session) until you build and arm again.

---

## What it fills vs. what you finish

The tool captures a **full hardware profile** and stores it verbatim (extensible —
new fields need no software change). Warehouse/manual fields are kept separate and
are **never overwritten** by an audit.

| Filled automatically by the tool | You finish on the device's page |
|---|---|
| Manufacturer, family, model, device type, serial, **Dell express code**, BIOS UUID | Cosmetic grade (A/B/C/D/scrap) |
| BIOS version/date, UEFI/Legacy, Secure Boot, TPM | Functional tests (keyboard, ports, webcam, Wi-Fi…) |
| CPU model/cores/threads/clock, RAM size/type/speed/slots | Data-wipe status + method only for a wipe done **outside** the station (kiosk wipes are recorded automatically), disposition |
| Per-drive model/capacity/type/interface/serial + **SMART health** (status, power-on hours, reallocated/pending sectors, SSD life used) | Grade, cost, location, notes, resale value |
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
