# ALS image server — setup

One Linux box on the warehouse LAN holds the OS images. Every audit station
mounts it read-only, so there is **one copy to update** instead of 8–15 GB on
every stick.

Any old machine out of your own stock will do. It needs a static IP, a disk big
enough for your images, and a wired connection.

---

## 1. Install and export the share

On the server (Ubuntu/Debian shown):

```bash
sudo apt update && sudo apt install -y nfs-kernel-server
sudo mkdir -p /srv/als-images
sudo chown -R nobody:nogroup /srv/als-images
```

Export it **read-only** to your LAN only — adjust the subnet to match yours:

```bash
echo '/srv/als-images 192.168.1.0/24(ro,sync,no_subtree_check)' | sudo tee -a /etc/exports
sudo exportfs -ra && sudo systemctl enable --now nfs-kernel-server
```

Read-only matters: it means a station can never corrupt or encrypt your golden
images, even if the machine being imaged is compromised.

## 2. Folder layout

```
/srv/als-images/
├── manifest.json          the list the kiosk shows
├── win11pro/              one Clonezilla image folder per OS
├── win10pro/
└── ubuntu2404/
```

`manifest.json` — add or remove entries to change the Install-OS list; no code
change needed. `dir` must match the folder name:

```json
{
  "images": [
    { "id": "win11pro", "name": "Windows 11 Pro", "version": "23H2 64-bit",
      "type": "clonezilla", "dir": "win11pro", "icon": "windows" }
  ]
}
```

An entry whose folder is missing shows as **(image missing)** and can't be
selected — so a half-copied image can't be restored by accident.

## 3. Point the stations at it

On each station: **Settings → Image server**, then enter either

```
192.168.1.50:/srv/als-images      NFS  (a Linux server — recommended)
//192.168.1.50/als-images         SMB  (a Windows box or NAS)
```

Save. The Load OS Image card then shows **"Images: shared server library"**.

The share is mounted read-only and *soft*, so if the server is off or the cable
is out, the station does **not** hang — it warns and falls back to whatever
images are on the stick.

## 3b. Serve the time as well (recommended)

The machines you audit are old and their CMOS batteries are usually dead, so
they boot with the wrong date. A wrong clock breaks HTTPS — certificates look
"not yet valid" — so audits silently fail to upload. Let this server hand out
the correct time and every bench is right even with no internet:

```bash
sudo apt install -y chrony
```

Allow your network to ask it (adjust the subnet):

```bash
echo 'allow 192.168.0.0/24' | sudo tee -a /etc/chrony/chrony.conf
sudo systemctl restart chrony
```

Then set `TIME_SERVER` in `audit.conf` to this server's IP, or just leave it
blank — the station falls back to the image server's address automatically.

## 4. Creating a golden image

1. Build one machine exactly as you want to ship it — Windows, drivers,
   updates, standard software.
2. **Sysprep it**: `C:\Windows\System32\Sysprep\sysprep.exe /generalize /oobe /shutdown`.
   Skipping this ships every customer the same machine identity.
3. Boot that machine from Clonezilla, choose *device-image → savedisk*, and
   save to the server (Clonezilla can mount the NFS share directly).
4. Name the saved folder to match a `manifest.json` entry.

## Performance

Over gigabit ethernet a 15 GB image transfers in about 2½ minutes — faster than
reading it from a USB 2.0 stick, and usually not the bottleneck at all (an old
laptop HDD only writes at ~90 MB/s). **Use a cable**: the same image over Wi-Fi
on older hardware takes 20–30 minutes.

## Notes before production

- **Clonezilla must be on the boot media.** SystemRescue does not ship `ocs-sr`,
  and without it the restore cannot run. Check with
  `command -v ocs-sr` on a booted stick.
- **Single point of failure.** If the server is down, imaging stops everywhere.
  Keep one stick with a copy of the current Windows image as a fallback.
- **Later:** the same server can serve PXE (boot the station itself over the
  network, no USB) and Clonezilla multicast (one image to many machines at
  once). Both build on this share.
