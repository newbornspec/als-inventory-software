# The hardware audit tool: a bootable capture

## Status

Shipped, 13–14 July 2026. `9d2d838` · `06c03cc` · `02ce72b` · `07e20ac` ·
`d95250a` · `b5989b7` · `6903bb0` · `ad20115` · `b671787` · `4fad868` ·
`1c2eb89` · `af8ac6e` · `3a06c91` · `528a7ca`

Phase 4. The beginning of what became the ALS Audit Station.

## The problem

A second-hand PC arrives with no reliable documentation of what is inside it.
Somebody has to open it, or boot it, and write down the processor, memory,
storage, screen and battery. Done by hand this is slow, inconsistent between
technicians, and frequently wrong — a laptop's *installed* RAM is not what a
sticker says, and a screen size guessed by eye is a guess.

## What was built

**A bootable USB tool** (`06c03cc`) that boots the machine into Linux, reads
its hardware directly, and posts a profile to the API (`9d2d838`).

**A comprehensive, extensible hardware profile** (`b5989b7`, `6903bb0`) rather
than a fixed set of columns — because the thing worth recording about a machine
grows, and every later feature in this project (drive health, lock detection,
OS capture, hardware tests) was added inside that structure without a schema
change.

**Display on the asset page** (`ad20115`) plus serial and express-service-code
search, and **full hardware spec in the lot Excel report** (`b671787`).

## Three decisions that held

**`02ce72b` — collect INTO a lot, no verification.** The first version tried to
verify the machine against something. It was reworked so the tool simply
captures into a lot: the audit states what is there, and reconciliation is a
separate concern. Mixing them made both worse.

**`07e20ac` — `audit.conf` is git-ignored.** The tool's configuration carries
Wi-Fi credentials and server credentials. It has never been in the repository,
and later work added a rule that its *values* are never read or printed — only
presence and format.

**`3a06c91`, `528a7ca` — run without typing.** Autorun and a desktop launcher,
because the operator is holding a screwdriver. Every later iteration of the
station pushed harder in this direction, ending in a kiosk that boots straight
into the interface.

## The defect worth recording

`4fad868` — **the PC was mis-identified as its own USB boot stick.**

The tool enumerated block devices and took the first one as the machine's
drive. The first device was the stick it had booted from. Every audit recorded
the USB stick's model and size as the machine's storage.

This is the ancestor of a rule that appears throughout the station: **the
station's own hardware is not the machine's.** It recurs in the OS detection
(never report the station's Ubuntu as the machine's operating system), in the
wipe engine (never wipe the boot drive, whatever it reports itself as), and in
the storage scan (removable and USB devices are skipped).

## What was deliberately not built

No attempt to identify anything the machine does not report. A screen size that
cannot be read is left blank rather than inferred from the chassis.

## Open questions

SystemRescue was the base at this point (`d95250a`). It was replaced by Ubuntu
in September when Secure Boot became a requirement — see
`2026-09-02-device-locks-and-ubuntu-base.md`.
