# Building the audit stick on Ubuntu (Secure Boot capable)

## Why

The SystemRescue stick **cannot boot a machine with Secure Boot enabled.**
Confirmed on a Dell OptiPlex 5080:

```
Operating System Loader failed signature verification.
All bootable devices failed Secure Boot verification.
```

It carries only `EFI/boot/bootx64.efi` and no `shimx64.efi`, so nothing in its
chain is signed by anything the firmware trusts. SystemRescue does not support
Secure Boot and upstream has not implemented it.

Ubuntu ships `shimx64.efi` signed by the **Microsoft UEFI CA**, with GRUB and
the kernel signed by Canonical, so an Ubuntu live stick boots with Secure Boot
**left on**. Nothing about the machine under assessment has to be changed —
which matters, because a BIOS admin password is one of the things we test for
and would block you from changing it anyway.

## The build

You need **Ubuntu Desktop LTS** — not Server. Server's live environment is the
installer: there is a shell, but no desktop session, so the `gui/` kiosk cannot
run there.

Use **Rufus in ISO Image mode**, not DD.

DD writes the ISO byte-for-byte, which leaves a read-only ISO9660 stick you
cannot copy the tools onto. ISO mode creates a **writable FAT32 partition**,
copies Ubuntu's `EFI/BOOT/bootx64.efi` — the Microsoft-signed shim — across
intact, and leaves the free space usable. Secure Boot still works, because what
makes it work is the shim being present, and Rufus copies it rather than
replacing it. SystemRescue failed for the opposite reason: it ships no shim at
all.

So the new stick works exactly like the old one: one partition, tools at the
root, `sync-usb.ps1` unchanged.

1. Download **Ubuntu Desktop LTS** (24.04.x, ~6 GB).
2. Run Rufus. Select the stick, select the ISO, press START. When it asks about
   the write mode, choose **ISO Image mode**. Let it format.
3. Copy the tools onto it from Windows:
   ```powershell
   .\tools\sync-usb.ps1 -Drive <letter> -Apply
   ```
4. Put `audit.conf` back on it. It is never synced — it holds this stick's Wi-Fi
   and server credentials — so restore it from your backup or rebuild it from
   `audit.conf.example`.

## First boot

1. Boot the stick with **Secure Boot left ON**. Choose *Try Ubuntu*.
2. Open a terminal and run it **as root**:
   ```sh
   sudo bash /cdrom/hardware-audit.sh
   ```
   The path depends on where the live session mounts the stick; `find-media.sh`
   locates it either way, and the audit prints the path it used.

**Nothing starts by itself.** The old SystemRescue stick ran `autorun/autorun`
at boot, which is a SystemRescue feature — Ubuntu's casper has no equivalent, so
the `autorun` file on this stick is inert and the operator must launch the tool.
For the graphical Audit Station, run it **without** sudo:

```sh
bash /cdrom/gui/start-gui.sh
```

It has to run as the desktop user, because that is the only account whose
display the browser can attach to; it elevates the audit itself with `sudo -n`.
The backend serves on <http://127.0.0.1:8800> and now stays up even if the
browser is closed.

**sudo is not optional.** Almost every lock check reads something only root can
read — the ACPI tables are mode 0400, efivars is root-only, mounting the Windows
partition needs root, so does `blkid`. SystemRescue booted you in as root and
this never came up. Ubuntu does not. Without it every lock check reports
UNKNOWN; it will not tell you a machine is clear, but it will not tell you
anything useful either. The audit warns you before it starts.

The first run needs **internet**: it apt-installs `hivex`, `ntfs-3g` and
`tpm2-tools`. Without `hivex` the Autopilot, Intune and Entra checks cannot read
the Windows registry at all.


## What still differs from the SystemRescue stick

- **The kiosk needs `cage`**, which is not on the Ubuntu live image.
  `gui/install-cage.sh` now installs it through apt or pacman, but it needs
  internet on first run.
- **OS restore images.** This stick has ONE partition (see the build section),
  so there is no partition 2 to put them on — an earlier draft of this file said
  there was, and it was wrong. Images come from the network image server
  configured in `audit.conf`, or from `images/` at the root of the stick if you
  have the space for them.
- **Wiping** works the same — `hardware-audit.sh` uses `hdparm`/`nvme`/`blkdiscard`,
  all present or apt-installable.

## Verifying the stick is actually signed

Before trusting it in the yard, confirm the shim is there:

**Do not look for a file called `shim`.** Rufus copies the shim across under
the name the firmware loads, `bootx64.efi` — which is exactly what the build
section above says — so globbing for `shim*` finds nothing on a perfectly good
stick and would talk you into switching Secure Boot off on the machine under
assessment. That is the one thing this whole rebuild exists to avoid.

Identify it by size and by its companion instead:

```sh
ls -l /media/*/EFI/boot/       # or E:\EFI\boot from Windows
```

On a Secure Boot capable stick:

| file | size | what it is |
|------|------|------------|
| `bootx64.efi` | ~950 KB | the **shim**, signed by the Microsoft UEFI CA |
| `grubx64.efi` | ~2.3 MB | GRUB, signed by Canonical |
| `mmx64.efi`   | ~850 KB | MokManager — **only ever ships alongside a shim** |

`mmx64.efi` is the giveaway: nothing else installs it. If `bootx64.efi` is
around 2.3 MB and there is no `mmx64.efi`, then what you have is bare GRUB and
the stick will fail signature verification.

To be certain rather than confident, check the signature chain from Linux:

```sh
sbverify --list /media/*/EFI/boot/bootx64.efi
```

Then boot a machine with Secure Boot on and confirm it reaches the desktop
rather than the signature-verification error. The old SystemRescue stick fails
all of this — that is the whole problem.
