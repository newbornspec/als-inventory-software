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
- **OS restore images** live on partition 2 under `images/`, found the same way.
- **Wiping** works the same — `hardware-audit.sh` uses `hdparm`/`nvme`/`blkdiscard`,
  all present or apt-installable.

## Verifying the stick is actually signed

Before trusting it in the yard, confirm the shim is there:

```sh
ls /media/*/EFI/boot/          # expect: bootx64.efi AND grubx64.efi
ls /media/*/EFI/boot/shim*     # a Secure Boot capable stick HAS this
```

The old stick fails this test — that is the whole problem. Then boot a machine
with Secure Boot on and confirm it reaches the desktop rather than the
signature-verification error.
