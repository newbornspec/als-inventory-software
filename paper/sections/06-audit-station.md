**Draft 1.**

---

## 6. Layer 3: the audit station

The audit station is a bootable USB stick. A technician plugs it into a machine
that arrived that morning, boots it, and gets one full-screen interface that
examines the machine, erases it, and uploads what it found.

Booting the customer's own Windows was never an option. Many arrive locked or
encrypted; booting changes the machine, which is evidence (R3); and a great
deal of what needs to be read — the registry, the hidden partitions, the raw
drive — is easier and safer to reach when Windows is not running. **The
machine's operating system is never started.**

### 6.1 The base, and the constraint that chose it

The station runs Ubuntu 24.04. That choice was made for **Secure Boot**: a
significant share of incoming machines will not boot an unsigned image without
a firmware change the technician should not be making on a customer's hardware.

The live session, though, is amnesiac. Every `apt install` is discarded at
reboot — and without `nvme-cli` an NVMe drive cannot be secure-erased, which is
most of what comes through the door. So the station carries a **casper overlay
layer**: an additional squashfs stacked on the stock image, holding the extra
packages and the kiosk.

How casper selects layers had to be read **out of the stick's own initrd**,
because most of what is written about it online is wrong for 24.04. Selection
is driven by one variable:

```
LAYERFS_PATH=minimal.standard.live.squashfs
```

casper builds the stack by repeatedly stripping the last dot-component, and the
**longest name ends up highest priority**. A layer named
`minimal.standard.live.als.squashfs` therefore extends the chain and sits on
top.

The trap, which the build script now refuses to be talked out of: the chain
only walks *up*, by stripping. Name the layer `als.squashfs` and the chain is
just "als" — casper mounts a few hundred kilobytes **as the entire root**,
finds no `/sbin/init`, and panics. **The name must extend a chain whose every
ancestor already exists.**

### 6.2 Seven attempts to make a browser fill a screen

The station is an appliance: one interface, full screen, no desktop, no browser
chrome, no way to end up somewhere else. The hardware it runs on is whatever
came through the door — any manufacturer, any graphics chip, any panel,
sometimes no working display driver. There is no fixed target to develop
against.

| Approach | Why it failed |
| --- | --- |
| Firefox kiosk mode | Hides the toolbar, opens at ~90%, never fills |
| Cage (Wayland kiosk compositor) | Correct when present — not on the image |
| Auto-install Cage at boot | Needs a network; the bench often has none |
| X fallback with a window manager | Another dependency not on the image |
| Window resize via an external tool | Deterministic, still an install |
| **python + libX11 via ctypes** | **Worked.** No packages, any display |

The lesson, paid for over seven attempts and fifteen commits:

> **On a live-boot appliance, a dependency you have to install is a dependency
> you do not have.**

Every approach needing a package worked on the development machine and failed
on the bench. What shipped talks to libX11 through ctypes and resizes whatever
top-level window appears, using only what the stock image already carries.

Progress became possible only after a **Display readout** was added to the
status bar showing the resolution *and which of the five launch paths had
actually run*. Until then every failure looked identical: a window that was not
full screen. Most of the subsequent progress is attributable to being able to
see which mechanism had fired — the same instrumentation principle as §5.5.

### 6.3 Who owns a keypress

An appliance has to survive its operator. During functional keyboard testing a
technician pressed keys on a Lenovo laptop and the entire interface disappeared
to a black screen. Investigating produced a model that turned out to be
generally useful:

| Layer | Owns | Can software refuse it? |
| --- | --- | --- |
| The page | Ordinary keys, Escape, function keys | **Yes** — the event can be cancelled |
| The X server | Virtual-terminal switching | **No** — intercepted below the client |
| The machine | Brightness, display output, vendor app-commands | **No** — firmware or the keyboard controller acts first |

Only the first layer offers a veto. The second required disabling server key
bindings at the X level; the third required clearing the offending keysyms
outright, because the machine acts before any software is consulted. A test
that asks a technician to press every key must therefore be defended at all
three layers — and the parts that cannot be defended have to be designed
around rather than trapped.

### 6.4 The station's hardware is not the machine's

The very first version of the audit tool enumerated block devices and took the
first one as the machine's drive. The first device was **the USB stick it had
booted from**. Every audit recorded the stick's model and capacity as the
machine's storage.

That defect is the ancestor of a rule now enforced in several independent
places: never report the station's Ubuntu as the machine's operating system;
never wipe the boot device whatever it reports itself as; skip removable and
USB devices in the storage scan. R4 exists because this confusion is easy to
write and invisible in a result that otherwise looks complete.

### 6.5 Accountability at the bench

Certificates are legal documents, so the station requires an **operator
sign-in**: the person who performed a wipe is recorded against it, not merely
the station that ran it. The station authenticates with a restricted account,
never an administrator (R6), and the kiosk service was hardened so the
interface cannot be escaped into a shell.

### 6.6 How code reaches a warehouse

There is no deployment pipeline to a USB stick on a bench. Getting a change
onto the stations is a physical act, and its cost differs by an order of
magnitude depending on which file changed:

| Change | What it takes |
| --- | --- |
| Interface, probes, autostart script | **Stick sync.** Copy files, checksum each, done |
| Anything inside the overlay layer | **Layer rebuild** plus a reboot on the audit machine |

This boundary is a real design input, and one decision shows why. The Autopilot
work needed an event-log reader that is not on the stock image, so it was added
to the layer build — gating the whole feature behind a rebuild. The rebuild
could not be run off the target machine, and the reason is more interesting
than the absence of build tools on Windows: the build has a safety gate that
simulates installing the packages against the **host's** package database, to
catch a package that would be an *upgrade* of something already on the live
image. In a container, that database is the container's. The gate would report
"none of these is an upgrade" not because it is true but because it **cannot
see** — passing vacuously, silently disabling the check that exists to prevent
exactly that failure.

The alternative shipped instead: the live session is writable and the stick is
already synced, so the packages ride on the stick and are installed at boot.
They stay in the layer list as well; whichever arrives first wins, because the
installer returns early if the tool is already present.

Two further details of the sync path are worth recording, because both hid real
faults. The stick carries a **version stamp**, without which a bug report
cannot be tied to a build. And the sync **flushes the write cache**, because
Windows reports a copy to removable media as complete before the data has left
the buffer — pull the stick immediately and you get a truncated file that
verifies as *present*.

## Drafting notes

- §6.1's casper explanation is the most directly reusable passage in the paper
  for anyone building a live-boot appliance. It is deliberately specific.
- §6.3's table is new to this draft; the keyboard incident had previously been
  written up only as a design record. Check the three layers against
  `docs/design/2026-09-22-keypress-ownership.md` before submission.
- §6.6's vacuous-safety-gate story has the same shape as §12's defect class — a
  check that cannot see, reporting that it found nothing. A forward reference
  is enough; do not retell it there.
- Specific key names and command flags were removed from §6.2 and §6.3 in
  favour of descriptions. They were incidental and would date the paper.
- Not yet covered: the boot-speed work. It belongs in this section but reads as
  trivia beside the rest. Decide before the final draft.
