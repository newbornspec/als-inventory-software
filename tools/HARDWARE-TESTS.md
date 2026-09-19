# On-station hardware tests (owner checklist)

These are the checks that can only be done on a real machine, booted from the
stick. Nothing here can be tested from Windows or in CI. Each test says what
you need, what to press, what counts as a pass, and what to send back.

Do them **in this order**. The first two matter most: they prove that a wipe
really erases a drive, and that a machine with two drives gets a true record.

| # | Test | Time | Plan step |
|---|------|------|-----------|
| 1 | One SSD, wiped and read back | 1-2 h | 14, 33 |
| 2 | A machine with two drives | half a day | 25 |
| 3 | The new boot layer (Firefox ESR, no snaps, shutdown splash) | 1 h | boot |
| 4 | Operator sign-in at the station | 1 h | 27 |
| 5 | The step-13 query on the live database | 15 min | 13 |
| 6 | Certificate signing and public verify | 1 h | 29, 30 |
| 7 | Read-back on every kind of drive | 1-3 days | 33 |
| 8 | Hidden disk areas (HPA) | half a day | 35 |
| 9 | NVMe namespaces and two-NVMe laptops | half a day | 37 |
| 10 | Limitations on the record (frozen drive, bad sectors) | half a day | 40 |
| 11 | Optional: suspend to unfreeze | half a day | 42 |

> ⚠️ **Every wipe in this file destroys data.** Use **sacrificial drives
> only**. Before you confirm a wipe, check the model **and** serial on the
> screen against the label on the drive. If they do not match, stop.

---

## Before you start (every time)

### Equipment for all tests

- The stick, synced from `master` (below).
- A phone for photos. A photo of the screen is fine for anything on it.
- The Windows PC, to read files off the stick afterwards.
- The kiosk admin PIN (Settings needs it).
- A **test batch** in the web app, for example `TEST-ERASURE`. Use the
  **Goods In audit** workflow and pick this batch, so test records never mix
  with real stock.

### Sync the stick

On Windows, from the repo on `master`, with nothing uncommitted:

```powershell
.\tools\sync-usb.ps1 -Drive E -Apply
```

`gui\.stick-version` on the stick then holds the commit. If it ends in
`-dirty`, the stick was synced from uncommitted changes. Sync again from a clean
checkout before testing.

### Check which features the stick carries

Some tests need a change that may not be on the stick yet. Run this in
PowerShell (change `E:` if needed). It only reads files.

```powershell
$s = 'E:'
$e = Get-Content "$s\hardware-audit.sh" -Raw
$k = Get-Content "$s\gui\server.py" -Raw
$g = Get-Content "$s\gui\index.html" -Raw
"stick commit            : " + (Get-Content "$s\gui\.stick-version" -Raw).Trim()
"read-back (test 1, 7)   : " + ($e -match 'verify_erased')
"NVMe namespaces (9)     : " + ($k -match 'it is on the same NVMe drive')
"hidden areas (test 8)   : " + ($e -match 'ata_hidden_areas')
"limitations (test 10)   : " + ($e -match 'smart_counts')
"operator sign-in (4)    : " + ($k -match 'AUDIT_OPERATOR_SIGNIN')
"suspend guard (test 11) : " + ($e -match 'mem_sleep')
"Rescan button (2D)      : " + ($g -match 'onclick="rescan\(\)"')
"403 signs out (4, 7.2)  : " + ($k -match 'SESSION_ENDED_403')
```

`False` means that change is not on the stick. Skip that test for now. (The
names searched for are the ones the plan gives. If a release note says a
feature is in but this says `False`, trust the note and tell me.)

### Opening a terminal on the station

Some tests need a command typed on the station. The kiosk covers the whole
screen, so:

1. Press **Ctrl+Alt+F3**. A text login appears.
2. Log in as `ubuntu`. There is no password. If it asks, just press Enter.
3. When you are done, press **Ctrl+Alt+F1** to go back to the kiosk (try
   **Ctrl+Alt+F2** if F1 shows text).

Anything you change this way is in RAM only. It is gone after a restart.

### What to send back, and what never to send

- **Send:** photos, `boot-report.txt` and `boot-history.csv` from the root of
  the stick, certificate PDFs, and a line per test: pass or fail, the machine,
  and the stick commit.
- **Never send** `audit.conf` (it holds the Wi-Fi and server passwords), the
  signing key from test 6, or any password.

---

## Test 1 — One SSD, wiped and read back

**Why:** this proves the wipe no longer trusts the drive's word and never uses
TRIM. It is the most important test.

**Needs:** `read-back` = True in the feature check.

**Equipment:**
- A station machine (the Dell is ideal).
- **1A:** an NVMe SSD (or a SATA SSD the BIOS does not freeze) with old data
  on it. A Windows install is best: it gives the read-back something to find.
- **1B:** a SATA SSD that the BIOS **freezes**, and that reports
  *Deterministic read ZEROs after TRIM*.
- **1C:** any NVMe SSD.
- `AUDIT_WIPE_UNFREEZE="0"` in the stick's `audit.conf` (the default).

**Check the 1B drive first.** In a terminal:

```sh
lsblk -d -o NAME,MODEL,SERIAL,SIZE,TRAN
sudo hdparm -I /dev/sdX | grep -i -E 'frozen|TRIM'
```

(`sdX` is the SSD from the `lsblk` list.) You want `frozen` (not
`not frozen`) and `Deterministic read ZEROs after TRIM`. If it says
`not frozen`, this drive is fine for 1A but not for 1B.

### 1A — firmware erase, then read back

1. Boot the stick. Wait for the kiosk and for **Display all system hardware
   information** to fill in.
2. Pick **Goods In audit**, choose the test batch, press **Start audit**. Wait
   until it is filed.
3. In **Wipe drive**, tick the SSD. Check its model and serial against the
   label.
4. Method: **Automatic · best for this drive**. Press **Wipe**.
5. The confirm dialog lists the drive with its serial. Check it. Press
   **Confirm**.
6. Press **Show details** on the drive's block and watch.

**Pass:**
- The details show `Verifying: reading the drive back …`, then a line
  starting `✓` whose method ends `— verified (reads as …)`: zeros, 0xFF,
  random, or pattern.
- Next line: `Read back … MiB across the drive: no old data found.`
- **No overwrite ran**: no `Overwriting` line and no `[00:00:05]` progress
  lines.
- The block says `Wiped — … — recorded`.
- Nowhere does the log or the method say `TRIM`, `discard` or
  `controller-confirmed`.

**Fail:** `controller-confirmed` anywhere means the stick is out of date. Sync
it and repeat. `OLD DATA STILL PRESENT` followed by an overwrite is not a
failure of the tool: it means the drive's own erase did not work, and the tool
caught it. Note which drive did that; it is exactly what we want to know.

### 1B — frozen SATA SSD (step 14)

1. Same steps as 1A, on the frozen SSD, method **Automatic**.
2. Then wipe it again with **NIST 800-88 Clear · overwrite + verify**.

**Pass, both runs:**
- **Automatic run:** the details say the drive is still frozen and it will
  overwrite instead.
- **Overwrite run:** no firmware erase is tried, so there is no frozen line.
  The log goes straight to `Overwriting (this is the slow path) …`.
- Progress lines appear every few seconds, like `[00:00:05] shred: …`.
- The result is `Wiped — Overwrite — shred 1 pass + zero (NIST Clear; flash:
  user-addressable blocks only) — verified (reads as zeros) — recorded`.
- The level line says `clear`, not `purge`.
- **No `blkdiscard`, no `discard`, no `TRIM`** anywhere in the details or the
  method.

### 1C — NVMe with nvme-cli taken away (step 14)

1. Open a terminal. Hide the `nvme` tool for this session only:
   ```sh
   P=$(command -v nvme); echo "$P"; sudo mv "$P" "$P.off"
   ```
2. Go back to the kiosk. Wipe the NVMe drive with **Automatic**.
3. Afterwards put it back: `sudo mv "$P.off" "$P"` (or just restart).

**Pass:** no firmware erase is tried and there is no frozen line: without
`nvme` the station goes straight to `Overwriting (this is the slow path) …`.
Then the same as 1B: progress lines, the same `Wiped — Overwrite — …` result
with the flash note, level `clear`, and no TRIM anywhere.

**Send back (all of 1):** a photo of each finished drive block, a photo of
the details log for 1A and 1B, the `hdparm` output for 1B, and the
certificate PDF from the asset page.

---

## Test 2 — A machine with two drives (step 25)

**Why:** each drive must get its own record, with its own serial. A machine
must not get a certificate while one drive still holds data.

**Needs:** the kiosk with per-drive result blocks, and the API with the
per-drive verdict. If after 2B the certificate is still missing and the asset
page says *a drive in this device failed its wipe close to (or after) the wipe
on record*, the per-drive verdict is not deployed yet. Report that.

**Equipment:**
- A machine with two internal drives, e.g. SATA + NVMe. Both sacrificial.
- A photo of each drive's label, taken before you start (model and serial).
- An **Ethernet** cable, so you can pull it for 2C.
- For 2D: a spare SATA drive and a **hot-swap bay or eSATA port**. Not a USB
  dock: USB drives are never offered for wiping.

### 2A — both drives, one forced to fail

1. Boot, **Goods In audit**, test batch, **Start audit**.
2. In **Wipe drive**, tick **both** drives. Check each serial against your
   label photos.
3. Method: **Automatic**. **Wipe**, then **Confirm**.
4. One drive (usually the NVMe) finishes quickly. The other (a frozen SATA
   SSD, or an HDD) goes to the overwrite and shows progress lines.
5. On that slow drive, open **Show details**. When you see progress lines
   like `[00:00:10] shred: …`, press **■ Stop** on that drive.

> ⚠️ Press **Stop** only while the details show **overwrite progress
> lines**. Never during `ATA secure erase` or `sanitize`. The drive keeps
> erasing by itself, and an ATA erase stopped half way can leave the drive
> password-locked.
>
> If the slow drive shows `ATA secure erase` instead of progress lines, let
> it finish. Then run 2A again with the method **NIST 800-88 Clear ·
> overwrite + verify**, which always shows progress lines.

**Pass:**
- The quick drive's block: `Wiped — … — recorded`.
- The stopped drive's block: `FAILED — Cancelled by the operator. (the
  failure is recorded)`.
- Both results stay on screen until you press **Done**.
- The summary: `No erasure certificate from this run: 1 of 2 drives did not
  finish as wiped and recorded.`
- On the web asset page: two wipe records, one per drive. There is **no
  certificate link**, and the page says why.

### 2B — re-wipe the failed drive

1. Press **Done**. Tick only the drive that failed. **Automatic**. Let it
   finish.

**Pass:**
- The block says `Wiped — … — recorded`, and the summary says the erasure
  certificate is available.
- The certificate PDF lists **both** drives. Each has its own serial, and each
  serial matches its label photo.

### 2C — a wipe with no network, uploaded the next day

Do this **at the end of a day**. The certificate prints a date, not a time, so
the upload has to happen on a later day to show which date it uses.

1. Pull the Ethernet cable. The header should show it is not connected.
2. Wipe one drive (the quick NVMe is fine). **Write down the date and time.**
3. The block says `Wiped — … — NOT recorded yet: no connection.` The header
   shows `1 waiting to upload`.
4. Press the **restart** icon (top right) and let the machine come back. The
   header must still show `1 waiting to upload`: the record survived.
5. Press **Shutdown**. Leave it overnight.
6. The next day, boot the same machine from the stick **with** the cable in.
   Press **Retry connection** if the banner shows.

**Pass:**
- The header's `waiting to upload` goes away.
- The record is on the asset page.
- The certificate's date for that drive is **the day you wrote down**, not
  the day it uploaded. (If it shows the upload day, the change that prints the
  real wipe date is not deployed yet. Report it.)

### 2D — a drive plugged in after the capture

1. Boot and let the hardware capture finish.
2. Plug the spare SATA drive into the hot-swap bay or eSATA port. Wait until
   it shows in **Wipe drive**.
3. Tick **only** the new drive. **Wipe**, **Confirm**.

**Pass:** it is **refused** before anything is written, with a message that
the drive *was not in the hardware profile captured for this machine* and to
press Rescan.

Then press **Rescan** (top right of the screen, next to the Settings gear)
and wait until the hardware card is filled in again. That re-reads the
hardware and the drive list. (On a stick older than this change there is no
Rescan button: open **Settings**, enter the admin PIN, change nothing, press
**Save**; or restart the machine with the drive in.) Now the same wipe is
allowed.

**Send back (all of 2):** the label photos; a photo of the screen after 2A
showing both blocks and the summary; a screenshot of the asset page after 2A
and after 2C; the certificate PDFs after 2B and 2C; the date and time you
wrote down in 2C;
a photo of the refusal in 2D.

---

## Test 3 — The new boot layer

**Why:** the boot changes (Firefox ESR baked in, snapd switched off, the
update stamps, cloud-init switched off, and the fixed shutdown splash from commit `7eda9ea`) only take
effect after the layer is rebuilt once.

**Equipment:** a station machine with **internet** (the build downloads
packages), the Windows PC.

### Prepare (Windows)

1. From the repo on `master`, regenerate the splash theme, then sync:
   ```powershell
   python tools\boot\make-splash.py --theme-only
   .\tools\sync-usb.ps1 -Drive E -Apply
   ```
2. Check `E:\boot\theme\usr\share\plymouth\themes\als\` now holds
   `lock.png`, `entry.png` and `bullet.png`. Without them the shutdown splash stays Ubuntu's.
3. **Copy `E:\casper\minimal.standard.live.als.squashfs` to a folder on the
   PC.** It is your way back. The build overwrites it and keeps no copy.
4. Check `E:\gui\kiosk.mode` says `on` and `E:\gui\autostart.mode` says
   `kiosk`.

### Build (on the station)

1. Boot the stick. Open a terminal (Ctrl+Alt+F3, see above).
2. Run:
   ```sh
   sudo bash /cdrom/make-als-layer.sh build --with-session
   ```
3. Read the end of the output. You want `firefox-esr baked in` and
   `masked: snapd…`, `cloud-init: switched off (/etc/cloud/cloud-init.disabled)`,
   `compressor: lz4 -Xhc`, `superblock: compression id 5 (lz4)`,
   `profile template: /usr/share/als/firefox-profile-esr`,
   and **no** `WARNING: themes/als has no …` line.
   (`compressor: xz - …` is safe, it just means the faster Firefox start is
   not in this build. Photograph the reason it gives.)
   If it says `copy failed`, do **not** boot the stick again. Put back the
   copy you made in *Prepare*, step 3, from Windows first.
   If it says `not enough room` / `Not copied`, the old layer was not touched
   and the stick still boots as before: free some space on `E:` from Windows
   (the new layer is about 161 MB, 53 MB more than the old one) and build again.
4. Run `sudo bash /cdrom/make-als-layer.sh status`. `armed` must say `yes`.
5. Restart.

### Check the boot

1. **The kiosk comes up by itself**, full screen.
2. Leave the machine on for **5 minutes**, so the final boot report is
   written. Then open a terminal and run:
   ```sh
   journalctl -b -t als-autostart --no-pager | grep -i -E 'kiosk:|firefox'
   systemctl is-enabled snapd.service
   ls -l /etc/cloud/cloud-init.disabled
   grep -i template ~/als-autostart.log
   systemd-analyze blame | head -15
   systemd-analyze blame | grep -c cloud-
   ```
3. Go back to the kiosk. Open **Settings** → **Run network check**. It also
   shows the boot timing and the shutdown-splash checks. If the station has an
   Ethernet port, plug in a network cable once and run the network check again:
   with cloud-init off, the wired connection comes from NetworkManager alone,
   and it must still say it is connected.
4. Press **Shutdown** on the kiosk. **Watch the screen** as it powers off.
5. On Windows, open `E:\boot-report.txt`.

**Pass:**
- The browser line names `firefox-esr`, not plain `firefox`.
- `snapd.service` is `masked`.
- `systemd-analyze blame` has **no** `snapd.seeded.service` line.
- `/etc/cloud/cloud-init.disabled` exists, and `systemd-analyze blame` has
  **no** cloud-init line (`cloud-init-local`, `cloud-init`, `cloud-config`,
  `cloud-final`): the `grep -c cloud-` prints `0`. Write down the new
  `APP READY` separately from the old 52 s (the ESR-only layer).
- In `boot-report.txt`:
  - `APP READY` is lower than the old **82 s**. Write the number down. (How
    much lower is not known yet: that is what this measures.)
  - Firefox start: `APP READY` minus `browser launched` is well under the
    old **13.6 s** (34.8 s -> 48.4 s on 2026-09-19). Write both numbers down.
    `browser launched` is now logged *before* the profile template is
    copied, so this number includes the copy as well as Firefox's own start.
    The `grep -i template` line must say `started from the template ... in
    N ms`: write N down too (the copy reads ~19 MB off the stick).
    Off the station this part went from 6.7 s to 1.05 s, but those runs read
    the layer from the PC's memory, not from a USB stick: reading from the
    stick was never measured, and lz4 reads more off it than xz did. How much
    of the gain shows on the station is what this measures.
  - The timeline has **no** `snap seeding finished` line. (A `firefox snap
    mounted` line can still appear: the image mounts its snap files at start,
    which is quick. Seeding them - the slow part - is what snapd being masked
    removes. Seen on the station, 2026-09-19: mounted at 10.6 s, no seeding,
    APP READY 82 s -> 52 s.)
  - With cloud-init off, the network check still says connected (Wi-Fi, and
    Ethernet if you tried a cable).
  - `stage` says `final`. (If it says `EARLY`, the machine was not left on
    long enough. That is fine for APP READY, but leave it on longer next time.)
  - Under `shutdown splash`: `theme: present and complete - two-step can load
    it`, and `fallback: bgrt is OURS`.
- At shutdown the screen shows the **ALS splash**, not the Dell logo with the
  Ubuntu wordmark.

**Send back:** `boot-report.txt`, `boot-history.csv`, a photo of the terminal
output, and a photo (or short video) of the screen during shutdown.

### If the kiosk does not come up

Try these in order. Each one is safe.

1. **A normal Ubuntu desktop with a message "Kiosk session did not start".**
   Nothing is broken. Photograph the message. Open a terminal (Ctrl+Alt+T)
   and run
   `tail -40 ~/als-session.log`, and photograph that too. You can still work:
   run `bash /cdrom/gui/start-gui.sh` (no sudo) to open the app in a window.
2. **A black screen or a text console.** Hold the power button to turn off.
   On Windows, create an empty file `E:\als-menu.txt`. At the next boot a menu
   shows for 60 seconds. Choose **ALS Audit Station (verbose - show all boot
   messages)** and photograph where it stops. **Recovery: base system
   (verbose)** boots without the ALS layer at all. Delete `als-menu.txt`
   afterwards.
3. **Turn the kiosk session off:** put the word `off` in `E:\gui\kiosk.mode`.
   The stick then boots to the normal Ubuntu desktop.
4. **Go back to the old layer:** copy the saved
   `minimal.standard.live.als.squashfs` back over the one in `E:\casper\`.
   The next boot is exactly as before.
5. **Build without ESR:**
   `sudo env ALS_ESR=0 bash /cdrom/make-als-layer.sh build --with-session`.
   Snaps seed as before, but it boots the old way.
6. **Build the old way for Firefox only:** add `ALS_LAYER_COMP=xz` (xz as
   before) and/or `ALS_FF_SEED=0` (no profile template) after `env` above.

---

## Test 4 — Operator sign-in at the station (step 27)

**Why:** a certificate should name the real person who did the wipe, not a
shared station account.

**Needs:** `operator sign-in` = True in the feature check. If it is False,
**do not** add the setting: this kiosk version ignores it, and wipes are still
filed under the station account.

**Equipment:** the station; your own ALS login (the one you use on the web);
a second person's login; a sacrificial drive; an Ethernet cable.

### Switch it on

1. On Windows, open `E:\audit.conf` in Notepad. Add this line (or, if an
   `AUDIT_OPERATOR_SIGNIN="0"` line is already there, change its 0 to 1) and
   save:
   ```
   AUDIT_OPERATOR_SIGNIN="1"
   ```
   **Leave `AUDIT_EMAIL` and `AUDIT_PASSWORD` in place for now.** Remove them
   only after this whole test passes, and only if the release note for sign-in
   says the station no longer needs them.
2. Boot the stick.

### Steps

1. **Before anyone signs in**, try a wipe. It must be refused, with a message
   to sign in first.
2. Try to sign in with a wrong password. You should get a clear error, and
   still no wipe.
3. Sign in with **your** ALS email and password. The header should show your
   name.
4. Wipe a sacrificial drive. Download the certificate.
5. **Offline hand-over.** Signing in needs the network, so:
   1. While signed in as yourself, pull the Ethernet cable.
   2. Wipe a drive. It shows `waiting to upload`.
   3. Sign out. Plug the cable back in.
   4. The second person signs in. Wait two minutes.
   5. The second person signs out. You sign in again.
6. Restart the station.
7. Optional, session expiry:
   1. Stay signed in for more than 12 hours, with the network up. Then wipe
      a drive.
   2. On the web app, change the password of the account you are signed in
      with. Then, on the station, wipe another drive.

**Pass:**
- Steps 1 and 2: no wipe is possible.
- The certificate from step 4 names **you**, by name only (no job title, no
  contact details).
- Step 5: while the second person is signed in, your record is **not**
  uploaded. It stays `waiting to upload`. It uploads once **you** sign in
  again, and its certificate names you.
- After step 6 nobody is signed in: the station asks again.
- Step 7.1: the wipe works and uploads with **no** sign-in prompt. The
  12-hour sign-in is renewed in the background while the station is online.
  That is correct, not a fault.
- Step 7.2: the server now refuses your session (it answers "Your password
  was changed", as HTTP 403). The wipe itself usually still runs: the
  station only learns this when it next talks to the server. (If it already
  learned it, from a lookup such as the batch check, the wipe is refused
  with the sign-in prompt below instead. That is also a pass.) The upload
  is refused, and
  the station then signs you out: the sign-in panel opens with **The server
  ended your session: Your password was changed. Please sign in again.** The
  record shows `waiting to upload`, not an unclear error. Sign in again with
  the new password: it uploads, and its certificate names you. (The same
  happens, with "This account has been disabled", if an admin disables the
  account while you are signed in.)

**Send back:** photos of the sign-in screen, the step-1 refusal, the step-2
error, and the header with your name; the certificate PDFs from steps 4 and 5;
what happened in steps 5 and 7.

---

## Test 5 — The step-13 query on the live database (step 13)

**Why:** it counts the certificates already issued that may be wrong. The
decisions about notifying buyers, re-wiping or destroying depend on it.

**Equipment:** a browser logged in to Railway. No station needed.

The query is `apps/api/sql/remediation-step13-affected-certificates.sql` in
the repo. It is **read only**: every statement is a `SELECT`, inside a
read-only transaction, so the database refuses any write. It prints asset tags
and stock status only, no customer data.

### Steps

1. Open Railway → project **loving-abundance** → the **postgres** database
   (the cube icon, **not** the old "Postgres" elephant) → **Data** →
   **Query**.
2. Open the `.sql` file in Notepad. Copy all of it. Paste it into the query
   box. Run it.
3. If the tab shows only one result (or only `ROLLBACK`), run the queries
   one at a time instead: copy each block from its first line to its `;`,
   paste, run. Most blocks start with `SELECT`. Block **(c)** starts with
   `WITH latest AS (`: copy from that line, not from a `SELECT` inside or
   below it, or it will not run. Leave out `BEGIN READ ONLY;` and
   `ROLLBACK;`. Each block is read-only on its own.

**Pass:** it runs with no error, and you get five results:
- **Totals** — wiped rows, wiped assets, first and last wipe.
- **(a) TRIM** — machines where a TRIM was recorded as a wipe.
- **(b) controller-confirmed** — firmware erases taken on the drive's word.
- **(c) mixed** — machines with a failed and a wiped drive.
- **Manual** — wipes recorded by hand, by stock status.

For each of (a), (b) and (c), count how many are still **in stock** and how
many are **sold**.

**Run (a) again a week after every stick has been re-synced.** Its
`last_match` date must be **before** the re-sync. A newer row means a stick
somewhere is still out of date.

**Send back:** a screenshot of each result, or just the counts: rows in (a),
(b) and (c), each split into in stock and sold.

---

## Test 6 — Certificate signing and public verify (steps 29, 30)

**Why:** a signed certificate can be checked by anyone, and cannot be changed
without it showing.

**Needs:** the API release with signing and the verify page, deployed. Until
then, without these settings, everything works exactly as today: certificates
are unsigned and marked legacy.

> 🔒 **The signing key is a secret.** Make it on your own PC. Put it only in
> Railway. **Never paste it into a chat with Claude**, an email, Slack, a
> ticket, the repo or the stick. If you need help, share the **public** key
> only (step 5 below). The public key is safe to share.

### Make the key (on your own PC)

1. Make a private folder **outside the repo**, e.g.
   `C:\Users\<you>\Documents\als-keys`. Never inside
   `Als_Inventory_Software`: a file there could be committed by accident.
2. Open **Git Bash** in that folder. Either of these makes an Ed25519 key in
   PKCS8 PEM form:
   - **openssl** (comes with Git for Windows):
     ```sh
     openssl genpkey -algorithm ed25519 -out als-cert-signing.pem
     ```
   - **node** (if you prefer, in PowerShell in that folder):
     ```powershell
     node -e "const c=require('crypto');const k=c.generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'});require('fs').writeFileSync('als-cert-signing.pem',k)"
     ```
3. Check it (Git Bash): `openssl pkey -in als-cert-signing.pem -noout -text | head -1`
   should say `ED25519 Private-Key:`.
4. **Back it up** somewhere safe and offline, e.g. your password manager. If
   it is lost you must make a new key.
5. The public key, safe to share: `openssl pkey -in als-cert-signing.pem -pubout`.

### Put it in Railway

The plan (owner decision D29) stores the PEM file **base64-encoded on one
line**. If the release note for signing asks for a different form, follow the
release note.

1. In PowerShell, in the key folder, copy the one-line form to the clipboard
   (it is never shown on screen):
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\als-cert-signing.pem")) | Set-Clipboard
   ```
2. Railway → project **loving-abundance** → the **API** service →
   **Variables** → **New Variable**. Name `CERT_SIGNING_KEY`. Paste the value.
   Save.
3. Clear the clipboard: `Set-Clipboard -Value ' '`.
4. Add two more variables on the same service:
   - `PUBLIC_VERIFY_ENABLED` = `1`
   - `PUBLIC_VERIFY_BASE_URL` = the public address the QR code should open,
     with no `/` at the end. Use the one the release note gives. (The API
     itself is at `https://als-inventory-software-production.up.railway.app`.)
5. Railway redeploys the API. Wait until the deploy is green.

### Check it

1. Look at the API's deploy log. There must be no error that mentions the
   signing key.
2. Wipe a sacrificial drive at the station (or use any new wipe). Download its
   certificate from the asset page.
3. Download it a second time.
4. Scan the QR code on the PDF with your phone.
5. In the phone's browser, change one character of the certificate id in the
   address and load it again.
6. Download a certificate issued **before** today.
7. Optional: set `PUBLIC_VERIFY_ENABLED` to `0`, wait for the deploy, scan the
   QR code again. Then set it back to `1`.

**Pass:**
- The new PDF shows a certificate id and a QR code, and is not marked legacy.
- Both downloads carry the **same** number and the same issued date.
- The phone shows the certificate as **valid**, with only: certificate number,
  issued date, device make and model, number of drives, and sanitisation
  level. **No serials, no names, no customer.**
- The changed id shows **not found**. It does not show another certificate.
- The old certificate is marked **legacy / unsigned**.
- With `PUBLIC_VERIFY_ENABLED=0` the verify page is not available.

**Send back:** the new certificate PDF, a phone screenshot of the verify page,
a screenshot of the changed-id result. **Not the key.**

---

## Test 7 — Read-back on every kind of drive (step 33)

**Why:** each brand of drive reads back differently after an erase. This
proves the check passes genuine erases and does not slow down.

**Needs:** `read-back` = True.

**Equipment:** as many of these as you have, all sacrificial:
- NVMe drives from **two different brands**.
- An NVMe drive that has **no sanitize** support (for the format paths).
- A SATA SSD that supports **enhanced** ATA secure erase.
- A SATA **HDD**.
- A drive with **Windows installed**.
- A **1 TB** drive, for the timing.
- A stopwatch (the phone).

### Before each NVMe wipe

In a terminal, note what the drive says it reads as after an erase, and what
it supports:

```sh
sudo nvme list -v
sudo nvme id-ns -H /dev/nvme0n1 | grep -i -A3 dlfeat
sudo nvme id-ctrl -H /dev/nvme0 | grep -i -A5 sanicap
```

`dlfeat` says what a cleared block reads as: zeros, `0xFF`, or not reported.

### Steps, for each drive

1. Boot, **Goods In audit**, test batch, **Start audit**.
2. Wipe the drive with **Automatic**. Open **Show details**.
3. Start the stopwatch at `Verifying: reading the drive back …`. Stop it at
   the `✓` line.
4. For the Windows drive: before wiping, check a Windows partition is mounted
   (the audit mounts it to read the registry):
   `lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINTS`. Note if one is. Then wipe.
5. **Force the other NVMe methods.** Automatic always tries the crypto
   sanitize first, so on its own it never reaches the others. On an NVMe
   drive whose `sanicap` shows **both** crypto erase and block erase, wipe it
   once with **Automatic** (you should get `NVMe cryptographic erase
   (sanitize)`), then again with **NIST 800-88 Purge · secure erase** (you
   should get `NVMe block-erase sanitize`). The `nvme format` methods only
   appear on the drive with no sanitize support.

**Pass:**
- Every drive whose own erase works gives `Wiped`, with **no overwrite** run.
- Across your drives you see these methods (which one a drive gets depends on
  what it supports): `NVMe cryptographic erase (sanitize)`,
  `NVMe block-erase sanitize`, `NVMe cryptographic erase (nvme format -s2)`,
  `NVMe secure erase (nvme format -s1)`, `ATA enhanced secure erase`, and
  `ATA secure erase` on the HDD.
- The `reads as …` in the method matches `dlfeat`: zeros for "read zeros",
  0xFF for "read 0xFF". A crypto erase may read as `random`; that is correct.
- The 1 TB drive's read-back takes **under a minute**.
- The Windows drive gives `Wiped`, not a failure caused by the mounted
  partition. If it fails, the reason is what we need.

**Record the four NVMe methods.** Write down which of these you actually saw:
crypto sanitize, block-erase sanitize, `format -s2`, `format -s1`. Any you did
not see is **not yet proved** on real hardware. Say so in your report, so step
33 is not marked done for it.

**Send back:** per drive: the three `nvme` outputs (for NVMe), the method line,
the read-back time, and a photo of the finished block. Plus the list of NVMe
methods seen and not seen.

---

## Test 8 — Hidden disk areas, HPA (step 35)

**Why:** a drive can hide its last sectors (a Host Protected Area). A wipe
that only erases the visible part leaves data behind. The station must either
erase the whole drive or say it failed.

**Needs:** `hidden areas` = True.

**Equipment:** a **spare SATA HDD** you can change settings on; a hot-swap
bay helps (see "frozen" below).

> ⚠️ These commands change the drive itself. Triple-check the device name
> against the model and serial every time. **Never run `--dco-restore`.**

### Set a hidden area by hand

In a terminal:

1. Find the drive: `lsblk -d -o NAME,MODEL,SERIAL,SIZE,TRAN`. Call it `sdX`.
2. `sudo hdparm -N /dev/sdX` prints `max sectors = A/B`. **B** is the full
   (native) size. Write it down.
3. Write a marker into the last sectors:
   ```sh
   B=<the number B>
   yes ALS-HPA-MARKER | head -c 4096 > /tmp/marker
   sudo dd if=/tmp/marker of=/dev/sdX bs=512 seek=$((B-8)) count=8 conv=fsync
   sudo dd if=/dev/sdX bs=512 skip=$((B-8)) count=8 2>/dev/null | head -c 60; echo
   ```
   The last command must print `ALS-HPA-MARKER…`.
4. Hide the last 2048 sectors (the `p` makes it last across power-offs):
   ```sh
   sudo hdparm -N p$((B-2048)) --yes-i-know-what-i-am-doing /dev/sdX
   ```
   If `hdparm` says the drive is **frozen**, unplug and replug the drive's
   power in the hot-swap bay, or do this step on another machine.
5. **Power the machine off fully**, then boot the stick again.
6. `sudo hdparm -N /dev/sdX` must now say `HPA is enabled`.

### Wipe it

1. Kiosk, **Goods In audit**, test batch, **Start audit**.
2. Wipe the HDD with **Automatic**.

### Check the marker is gone

The hidden area comes back after a power-off. So, in a terminal, show it for
this session only (no `p`) and read the marker spot.

The machine has restarted since you set `B`, and the terminal forgets
everything on a restart. So the first line sets `B` again, from the number you
wrote down. Do not skip it.

```sh
B=<the number B you wrote down>
[ -n "$B" ] || echo 'B is not set - STOP, set it first'
sudo hdparm -N $B --yes-i-know-what-i-am-doing /dev/sdX
echo 1 | sudo tee /sys/block/sdX/device/rescan
lsblk -b -d -o NAME,SIZE /dev/sdX
sudo dd if=/dev/sdX bs=512 skip=$((B-8)) count=8 2>/dev/null | head -c 60 | od -c | head -3
```

**First check the read itself is real:**
- `lsblk` must show a size of exactly `B` × 512. If it is smaller, the area is
  still hidden and the read shows nothing about it.
- The `od` output must have rows of characters after `0000000`. Only
  `0000000` on its own means nothing was read. That is **not a pass**: set `B`
  again and repeat.
- The marker must have shown before the wipe (step 3 printed
  `ALS-HPA-MARKER…`). If you did not see it then, this test proves nothing.

**Pass:** one of these, and nothing else:
- `Wiped`, the method mentions the hidden area being removed, and the marker
  spot reads as zeros (no `A L S - H P A`).
- `Failed`, with a reason that names the hidden area.

**It is a fail** if the result is `Wiped` and the marker is still there, or the
record shows the smaller size.

**Also try it frozen:** repeat with the HPA set and the drive frozen by the
BIOS, `AUDIT_WIPE_UNFREEZE="0"`. Expect `Failed` naming the hidden area, or
`Wiped` at the full size. Never `Wiped` at the smaller size.

**Clean up:** give the drive its full size back for good. Set `B` again first
if the machine has restarted since:
```sh
B=<the number B you wrote down>
[ -n "$B" ] || echo 'B is not set - STOP, set it first'
sudo hdparm -N p$B --yes-i-know-what-i-am-doing /dev/sdX
```

**Send back:** the `hdparm -N` output before and after, the result line, the
`od` output, and the certificate PDF.

---

## Test 9 — NVMe namespaces and two-NVMe laptops (step 37)

**Why:** one NVMe drive can show up as several parts (namespaces). The
drive's own sanitize erases all of them, ticked or not; the other methods erase
only the part they are given. The record must match what really happened. And
on a laptop with two NVMe drives, an erase must reach only the drive you
picked.

**Needs:** `NVMe namespaces` = True for the kiosk part. The engine part
(each erase sent to the right controller, and naming a namespace it did not
cover) is a separate change. If a release note says it is not in yet, still do
9A and 9B: they show what the station does today.

**Equipment:** an NVMe drive that supports **namespace management**; a laptop
with **two NVMe drives**. All sacrificial.

### 9A — one drive split into two namespaces

This deletes everything on the drive. In a terminal:

0. Find the drive first. Do not assume it is `nvme0`:
   ```sh
   sudo nvme list -v
   ```
   Match the serial number to the label on the sacrificial drive. The
   controller on that line (`nvme0`, `nvme1`, …) is your **`nvmeN`**. In every
   command below, type that name where it says `nvmeN`. If the machine has
   another NVMe drive, triple-check. `delete-ns` wipes the whole drive it is
   given, with no question asked. Check again after each restart, because the
   numbers can change.
1. Check it can hold two namespaces:
   `sudo nvme id-ctrl /dev/nvmeN | grep -E '^(nn|oacs|tnvmcap|cntlid) '`.
   `nn` must be 2 or more. If it is 1, this drive cannot do the test.
2. Split it. `<half>` = `tnvmcap` ÷ 512 ÷ 2, rounded down (512 is the block
   size of `--flbas=0` on most drives). `<id>` = `cntlid`.
   ```sh
   sudo nvme delete-ns /dev/nvmeN -n 0xffffffff
   sudo nvme create-ns /dev/nvmeN --nsze=<half> --ncap=<half> --flbas=0
   sudo nvme create-ns /dev/nvmeN --nsze=<half> --ncap=<half> --flbas=0
   sudo nvme attach-ns /dev/nvmeN -n 1 -c <id>
   sudo nvme attach-ns /dev/nvmeN -n 2 -c <id>
   sudo nvme ns-rescan /dev/nvmeN
   lsblk -d -o NAME,SIZE
   ```
   You should now see `nvmeNn1` and `nvmeNn2`. If any command errors, stop
   and send a photo.
3. Put a marker on each:
   ```sh
   yes ALS-NS1-MARKER | head -c 1048576 | sudo dd of=/dev/nvmeNn1 bs=1M count=1 iflag=fullblock conv=fsync
   yes ALS-NS2-MARKER | head -c 1048576 | sudo dd of=/dev/nvmeNn2 bs=1M count=1 iflag=fullblock conv=fsync
   ```
4. Restart, so the kiosk captures the drive as it is now. In **Wipe drive**
   each of the two should say `same NVMe drive as` the other.
5. Tick **only `nvmeNn1`**. Press **Wipe**. The confirm dialog must warn that
   the two are parts of ONE NVMe drive, that a sanitize erases ALL of them,
   and that `nvmeNn2` is NOT ticked and will not be recorded. Confirm. Let it
   finish.
6. Read both back:
   ```sh
   sudo dd if=/dev/nvmeNn1 bs=1M count=1 2>/dev/null | grep -c ALS-NS1-MARKER
   sudo dd if=/dev/nvmeNn2 bs=1M count=1 2>/dev/null | grep -c ALS-NS2-MARKER
   ```
   Each command prints how many marker lines it found. Before the wipe that
   is a large number; after an erase it is `0`.
7. Put both markers back (step 3). Restart. Now tick **both** `nvmeNn1` and
   `nvmeNn2`, **Wipe**, **Confirm**. One starts; the other's block says
   `Waiting for nvmeNn1 to finish - it is on the same NVMe drive`. Let both
   finish, then read both back again (step 6).

**Pass:**
- Step 6: the n1 count is `0`. For n2, either its count is `0` too (the
  drive's sanitize took the whole drive), **or** the n1 result names `nvmeNn2`
  as not erased. It is a fail if n1 says `Wiped`, the n2 marker is still there,
  and nothing on the screen or the record mentions n2.
- Step 7: the two never run at the same time, each gets its own result, and
  both counts are `0`.

### 9B — a laptop with two NVMe drives

1. `sudo nvme list -v`. Note which controller (`nvme0`, `nvme1`) owns which
   drive, with serials. Then record the second drive's sanitize log **before**
   any wipe, and photograph it:
   ```sh
   sudo nvme sanitize-log /dev/nvme1
   ```
   (Use the second drive's own controller name.) This log shows the **last**
   sanitize the drive ever ran, even one from a previous owner. So it is only
   useful compared with this photo.
2. Put a marker on the **second** drive, as in 9A step 3 (use its own name,
   e.g. `/dev/nvme1n1`).
3. Restart. Wipe **only the first** drive.
4. Check the marker on the second drive is still there (the count is above
   `0`). Run `sudo nvme sanitize-log /dev/nvme1` again and compare it with
   the step-1 photo: the status (`SSTAT`) and the sanitize counters must be
   exactly the same.
5. Then tick **both** drives and wipe them together.

**Pass:** step 4 keeps the second drive's marker and its sanitize log is
unchanged; in step 5 both finish as
`Wiped`, each with its own record and serial.

**Send back:** the `nvme list -v` and `id-ctrl` output, both `sanitize-log`
photos from 9B, photos of the confirm-dialog warning and the `Waiting for …`
block from 9A, the marker counts, and the certificate PDF.

---

## Test 10 — Limitations on the record (step 40)

**Why:** when the station could not do what was asked (a frozen drive, bad
sectors), the record and the certificate must say so plainly.

**Needs:** `limitations` = True, and the API that prints level and
limitations on the certificate.

**Equipment:**
- A SATA **HDD** that the BIOS freezes and that has **reallocated sectors**.
  Check: `sudo smartctl -A /dev/sdX | grep -i -E 'Reallocated_Sector|Current_Pending'`.
  The raw value (last column) must be above 0.
- A drive that supports only **normal** (not enhanced) ATA secure erase:
  `sudo hdparm -I /dev/sdX | grep -i enhanced` shows `not supported: enhanced
  erase`.
- An NVMe drive.
- `AUDIT_WIPE_UNFREEZE="0"`.

### Steps

1. Wipe the frozen HDD with **NIST 800-88 Purge · secure erase**. It will
   overwrite instead. This takes hours on a big disk.
2. Wipe the normal-erase-only drive with **Automatic**.
3. Wipe the NVMe with **Automatic**.

**Pass:**
- **HDD:** the record and the PDF show requested **secure**, fallback
  reason **frozen**, achieved **overwrite**, level **Clear**, and a limitation
  that names the number of reallocated sectors.
- **Normal-erase drive:** level **Clear**. If it has bad sectors, a limitation
  names the counts.
- **NVMe:** level **Purge**.
- No certificate with a limitation says the data is "unrecoverable".

**Send back:** the `smartctl` and `hdparm` output, a photo of each finished
block, and each certificate PDF.

---

## Test 11 — Optional: suspend to unfreeze (step 42)

**Only if you want more drives to get a true firmware erase.** Today it stays
off (owner decision D42), and nothing needs it.

**Needs:** `suspend guard` = True. **Do not switch this on without the
guard**: without it, a suspend can happen while another drive is still being
wiped.

**Equipment:** the Dell; a frozen SATA SSD; a second sacrificial drive.

### Steps

1. On Windows, in `E:\audit.conf`, change `AUDIT_WIPE_UNFREEZE="0"` to
   `AUDIT_WIPE_UNFREEZE="1"`.
2. Boot. Wipe the frozen SSD alone with **NIST 800-88 Purge · secure erase**.
   The screen goes dark for a few seconds and comes back.
3. Start a long overwrite on the second drive (**Clear · overwrite +
   verify**). While it runs, start a secure erase on the frozen SSD.
4. Afterwards, set `AUDIT_WIPE_UNFREEZE="0"` again, unless you decide to keep
   it.

**Pass:**
- Step 2: the details show the drive being unfrozen, then an **ATA** secure
  erase (not an overwrite), verified.
- Step 3: the station does **not** suspend while the other wipe runs. The SSD
  falls back to an overwrite, or waits, and says why.
- If the machine does not come back from the suspend, note the make and model.
  It goes on the list of machines where this must stay off.

**Send back:** photos of both runs' details, and whether the machine resumed.
