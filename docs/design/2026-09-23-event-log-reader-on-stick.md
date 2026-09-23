# Shipping a package by file copy instead of a squashfs rebuild

## Status

Shipped, 23 September 2026. `435add4`.

## The problem

The Autopilot check reads the machine's own OOBE event log, which needs
`evtxexport` from `libevtx-utils` — not on the stock Ubuntu image. `8059f3a`
added it to `make-als-layer.sh`, which gated the whole feature behind a
`mksquashfs` rebuild and a reboot on the audit machine.

The owner asked for that rebuild to be run on the development PC. It could not
be, and the reason is worth recording.

## Why the rebuild could not be done off the machine

Not simply that `mksquashfs` is absent on Windows. The build has a safety gate:

```
apt-get install -s $PACKAGES
```

run against the **host's** package database, to check that none of the packages
being baked in is an *upgrade* of something already on the live image. Baking
an older or duplicate copy on top of what the running system uses is how a
stick breaks in a way nobody connects back to the build.

In a container that database is the container's, not the stick's. The gate
would report "none of ours is an upgrade" not because it is true, but because
it cannot see. It would pass **vacuously**, silently disabling the check that
exists to prevent exactly that failure.

Reconstructing the real environment is possible — unsquash the three parent
layers (~3GB) and build in a chroot of that — but it is a lot of moving parts
assembled blind, for a stick that boots machines holding customer data.

## What was built instead

The rebuild only ever delivered one thing, and a package does not need to be in
the squashfs to be on the station. The live session is writable and the stick
is a FAT32 partition already being synced.

So three `.deb` files ride on the stick at `debs/`, and `als-autostart.sh`
installs them at boot. The package stays in the layer list too: a rebuilt stick
gets it that way, and whichever arrives first wins, because the installer
returns early when the tool is already present.

This follows a rule the repo already held itself to — `als-autostart.sh` exists
precisely so behaviour lives on the FAT32 partition rather than in the layer,
and `test-hwtest-screen.py` already asserted that rule for the screen-blanking
duty.

Design choices worth keeping:

- **`dpkg`, never `apt`.** The bench has no guaranteed network, and an install
  that needs one is an install that fails on the day it matters.
- **Elevation through the station's existing passwordless sudo**, the same one
  the backend uses to mount and to erase.
- **Never fatal, never silent.** A missing directory, an empty one, no root, or
  a failed `dpkg` each say so in the log — because an absent reader must never
  be mistaken for a machine with no traces on it.

The real dependency closure turned out to be **three** packages, not the two a
guess would have produced: `libevtx-utils`, `libevtx1t64`, `libbfio1`.

## A bug found by having a real binary to run against

Testing against an actual `evtxexport` for the first time exposed a defect in
code already pushed the day before:

```sh
als_evtx_dump() {
  timeout ... evtxexport -f text "$1" 2>/dev/null | head -c 2000000
}
```

A pipeline reports the **last** command's status, and `head` succeeds on an
empty stream. So a failed `evtxexport` returned 0, and the caller reported
"present but held no readable records" instead of "could not be read". Both are
honest non-answers, but they send an operator to different places. Fixed with
`PIPESTATUS`; `head` still does the capping so a huge log is never held whole.

**It could not have been found by reasoning.** It needed the binary.

## How it was proved

`tools/test-evtx-reader.sh`, 23 checks: the three packages are present and are
the only things in `debs/`; the installer is offline, idempotent and never
fatal; every failure path is logged; the sync ships the directory. The install
itself was run end to end in a clean Ubuntu 24.04 against a simulated stick,
including the second run, which correctly no-ops.

Fifty tool suites green in a container.

## Open questions

None. The layer rebuild is no longer required for any current feature.
