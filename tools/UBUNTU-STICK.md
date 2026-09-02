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

## The one structural difference

An Ubuntu ISO written to USB is **read-only ISO9660**. You cannot drop
`hardware-audit.sh` onto its root the way you could with the archiso stick.

So the stick gets **two partitions**:

| Partition | Contents | Filesystem |
|---|---|---|
| 1 | The Ubuntu ISO, written with `dd`/Rufus — bootable and signed | ISO9660 (read-only) |
| 2 | Our tools: `hardware-audit.sh`, `lock-checks.sh`, `gui/`, `audit.conf`, `images/` | FAT32, **label `ALSAUDIT`** |

**The label is load-bearing.** `find-media.sh` locates partition 2 by it, and
mounts it read-only itself when the live session has not — a bare live shell
auto-mounts nothing, and without that step the GUI cannot find its own files.

## Build

1. **Write the ISO.** Download Ubuntu Desktop LTS. With Rufus, choose
   **DD image mode** — ISO mode rewrites the bootloader and can break the
   signed chain. `sudo dd if=ubuntu.iso of=/dev/sdX bs=4M status=progress` also
   works.

2. **Add the data partition.** In Rufus this is the "persistent partition"
   slider; otherwise create a second FAT32 partition in the free space with
   GParted or Disk Management. **Label it `ALSAUDIT`.**

3. **Copy the tools onto it** from Windows:
   ```powershell
   .\tools\sync-usb.ps1 -Drive <letter-of-ALSAUDIT> -Apply
   ```

4. **Create `audit.conf`** on that partition from `audit.conf.example`. It is
   never synced — it holds this stick's Wi-Fi and credentials.

## First boot

1. Boot the stick with **Secure Boot left ON**. Choose *Try Ubuntu*.
2. Open a terminal and run:
   ```sh
   sudo bash /media/*/ALSAUDIT/hardware-audit.sh
   ```
   (or `bash gui/start-gui.sh` for the kiosk — it mounts the partition itself.)

The script installs what it needs through `apt-get`, including `hivex`,
`ntfs-3g` and `tpm2-tools` for the lock checks, so **the first run needs
internet**. Without `hivex` the Autopilot, Intune and Entra checks report
UNKNOWN rather than failing — correct, but not useful.

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
