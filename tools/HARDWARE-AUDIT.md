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
   **Rescan** (top right of the screen) and wait.
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
     The certificate lists that drive as *serial not reported by the drive*.
4. **Hidden areas (SATA drives).** Before anything is written, the engine asks
   the drive whether part of it is hidden from the system (an HPA or DCO,
   `hdparm -N` / `--dco-identify`). A wipe would not reach hidden sectors, so
   (owner decision D34):
   - **HPA** only: removed **temporarily** (until the next power cycle) and
     checked; if it cannot be removed, or comes back during the wipe, the
     result is **Failed**. A drive that only offers a permanent change
     (ACCESSIBLE MAX ADDRESS) is not changed and fails.
   - **DCO**: **Failed**, naming it. The station never runs `--dco-restore`.
   - **Could not be checked** (common behind RAID / RST controllers): the
     wipe goes ahead, and the record carries that as a limitation.
   NVMe and eMMC have no HPA / DCO.
5. **Read the result** for each drive. There are exactly three:

   | Result | What it means | What is recorded |
   |---|---|---|
   | **Wiped** | The erase ran **and the drive was read back afterwards with none of its old data recognisable** (see *The check afterwards* below). There is no result for "the drive said it worked". | A wipe record for **that drive**: serial, model, method asked for and achieved, sanitisation level (Purge / Clear), the read-back verdict, hidden areas, limitations, start and finish time, tool version. |
   | **Failed** | The erase did not complete, **or the read-back found old data, or the read-back could not be done** (owner decision D31: an erase nobody could check is not recorded as wiped). Also a job that dies without a result, and a hidden area that could not be dealt with. Treat the drive as **still holding data**, possibly partly erased. | A **failed** record for that drive, with the reason. Wipe it again before it can be resold. |
   | **Refused** | **Nothing was written to the drive.** It was the wrong drive (serial mismatch), a USB / removable / boot disk, or not a real disk. | **Nothing.** A refusal is not filed, because the drive was never touched. |

   With no network the wipe still completes: the record is saved on the stick
   and uploaded automatically later, with the time the wipe actually happened.
   Each finished wipe is also marked on the stick straight away, so restarting
   the kiosk cannot lose a record.

**Wipe EVERY internal drive of the machine.** The certificate is for the whole
machine, and the server now works it out **per drive** (owner decision D23): it
is issued only when every internal drive listed in the wipe-time hardware
profile has a **wiped** record, and each drive's latest record counts (a
drive that failed and was then wiped again is wiped). While any drive is
failed, or has no wipe on record, the asset shows **data wipe failed** and no
certificate is issued; the kiosk's run summary says which drive is holding it
up. One certificate lists every drive with its own
serial, method and result.

**Certificates for older records.** Records from a stick that predates
per-drive records carry no drive identity. They are still certified (owner
decision D20), labelled *Drive not individually recorded (record predates
per-drive tracking)* and dated *Date recorded*. For a machine that has only
such records, the old interim guard still decides (owner decision D11): no
certificate while a **failed** wipe record is newer than the wiped one, or
less than 24 hours older than it. A certificate that was downloaded before
this release keeps its number when downloaded again, but its wording is the
new one (per-drive sections, the labels above) - expected, not an error.

### Methods

The method the kiosk pre-selects comes from `AUDIT_WIPE_METHOD` in `audit.conf`
(changing that default from the Settings screen needs the admin PIN); the
operator can pick another for each wipe.

- `auto` (default) — the drive's own **cryptographic erase** if it supports one,
  else its firmware **secure / block erase**, else an overwrite.
- `crypto` — cryptographic erase (NVMe sanitize crypto erase, or
  `nvme format -s2`; on SATA the enhanced ATA secure erase), else overwrite.
- `secure` — firmware erase (ATA secure erase; NVMe block-erase sanitize or
  `nvme format -s1`), else overwrite.
- `overwrite` — one random pass and one zero pass (`shred`), read back.
- `zero` — a single zero pass, read back (NIST "Clear", half the time).

**NVMe order.** The engine finds the drive's controller from the kernel (it
never guesses it from the device name) and tries the **sanitize** first:
crypto erase, then block erase, as far as the drive says it supports them.
`nvme format` comes last, and only when it is known to cover the whole drive
(one namespace, or the drive says a format erases all of them). A sanitize
erases **every namespace** of the drive, ticked or not (owner decision D36);
the confirm dialog says so when a drive has more than one.

**Levels.** Every record says the level it reached (NIST SP 800-88):

- **Purge** — an NVMe sanitize or format, or an **enhanced** ATA secure erase,
  read back clean.
- **Clear** — an overwrite read back as zeros, or a **normal** (non-enhanced)
  ATA secure erase read back clean. On flash an overwrite reaches only the
  blocks the operating system can address; the record says so. A drive that
  reports reallocated or pending sectors (SMART 5 / 197) gets a limitation
  naming the counts, because a retired sector cannot be reached by an
  overwrite or a normal ATA erase (owner decision D38).

There is **no TRIM step**: TRIM is a hint to the drive, not an erase, and a
TRIMmed SSD reads back as zeros whether or not its data is gone. When a
stronger method was asked for but not used, the record says what was asked
for, what was achieved, and why (for example *the drive's security is frozen
by the BIOS*).

**Frozen SATA drives:** the BIOS usually marks SATA drives security-frozen at
boot, which blocks ATA secure erase, so such a drive is overwritten instead.
`AUDIT_WIPE_UNFREEZE="1"` suspends/resumes briefly to unfreeze, but some
machines never resume, so it stays off (owner decision D42). NVMe has no frozen
state.

**The check afterwards.** Every wipe ends with a read-back of the drive: the
first and last MiB, eight windows spread across the drive, and every place a
partition started **before** the erase (the partition table is recorded first,
because afterwards it may be gone while the volumes it pointed at are not). The
drive is read directly, not from the system's cache. The verdict is one of
three, recorded as `clean`, `found` or `unverified`:

- **Old data found** — a boot sector, a partition table (`EFI PART`), or an
  NTFS, BitLocker, FAT, LUKS or ext signature, anywhere it looked; or, after
  an overwrite, anything that is not zeros. After a **firmware** erase the
  drive said "done" and did not erase: the engine says so and falls back to a
  full **overwrite**, which is then read back in turn. After an overwrite the
  result is **Failed**.
- **Clean** — nothing of the old data. After an **overwrite** only zeros
  count as clean. After a **firmware** erase what a genuine erase leaves is
  accepted: zeros, all `0xFF`, a short repeated vendor fill, or random-looking
  data (the ciphertext a cryptographic erase leaves). The method on the record
  ends *— verified (reads as zeros / 0xFF / random / ...)*.
- **Could not verify** — a read that failed or came back short, the drive
  gone, no `python3`: the result is **Failed**, with the reason (owner
  decision D31). An erase that nobody could check is never recorded as wiped.

What the check cannot see: data that is already random-looking (compressed or
encrypted files) sitting between the windows looks the same as the ciphertext
of a crypto erase. The signature checks at every former partition start are
what catch a drive that lied.

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
| Per-drive model/capacity/type/interface/serial + **drive health** (`storage[].health`: a percentage 0-100 with status Good 90-100 / Caution 50-89 / Bad 0-49, the basis and reasons, temperature, power-on hours, life used, bad sectors / media errors, last self-test - or, when it cannot be measured, the reason and what to do; see "Drive health" below) | Grade, cost, location, notes, resale value |
| Graphics, battery (design/full/cycle/health), network + MAC | |

Some fields depend on the machine and boot: **OS/build** (usually none — units are
wiped), **BitLocker / BIOS-password state**, and **display EDID** may come back blank.
That's expected — the profile simply omits what it can't read.

### Drive health

Each internal drive's health is read once during the capture, as root, with
`smartctl -j -x` (30 s limit per drive), or `mmc extcsd read` for an eMMC.
The percentage is the drive's own data put through one formula
(DRIVE-HEALTH-CONTRACT C5, `als_health_py` in `hardware-audit.sh`):

1. **Life remaining** (SSD/NVMe/eMMC only): NVMe `100 - percentage_used`,
   or the available spare if lower; SATA SSD the Device Statistics
   "Percentage Used Endurance Indicator", else the normalised value of
   attribute 231/233/177/202/169 (id and name must both match); eMMC
   `100 - 10 x` the worse life-time estimate. Hard drives have no wear figure.
2. **Error score**, from 100: 2 per reallocated sector (max 40), 10 per
   pending sector (max 40), 10 per uncorrectable sector/error (198 + 187,
   max 50), 10 per NVMe media error (max 50), 10 for any spin retry. CRC
   errors are a cable fault and are only noted.
3. **Caps**: SMART FAILED or an attribute failing now 20; an attribute that
   failed in the past 49; NVMe critical warning 25; last self-test failed 25;
   eMMC pre-EOL urgent 25 / warning 89; running hot (NVMe limit, else HDD
   55 °C, SSD 70 °C) 89.
4. **Percent** = the lowest of the three; the status comes only from the
   percent (Good 90-100, Caution 50-89, Bad 0-49).

When a percentage cannot be measured the record says why and what to do
(behind a RAID/Intel RST controller → set AHCI in the BIOS and Rescan; the
drive reports no health data; SMART switched off; the read timed out; this
build cannot read it → update the stick). It never says "Unknown". Drives the
controller hides from Linux entirely are listed in `hiddenStorage`, not in
`storage[]`, so they cannot hold a machine's wipe certificate open.

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
