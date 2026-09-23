# Drive health as a percentage — contract C5

## Status

Shipped, 19–20 September 2026. `82f0ea6` · `9cfb422` · `7d6c3a0` · `f10bd76` ·
`bd6a659` · `5cb8308` · `a9ab3ad` · `3f470db` · `cf888e7` · `f2963a2` ·
`90ed4af` · `4f0c64b` · `87db216` · `f2d0c88` · `be8d27d` — merged as
`c82cb5b` (station) and `9826bf9` (web).

## The problem

A buyer's first question about a second-hand machine is *how much life is left
in the drive*. SMART data answers it, but not in a form anyone can act on: raw
attribute counters, vendor-specific meanings, and different fields on SATA,
NVMe, eMMC and SAS.

## The contract

The owner's requirement, and the rule that shaped every decision:

> **A drive health figure is a percentage, in named bands, and it is never
> "Unknown".**

If health cannot be measured, the row says **what could not be measured and
what to do about it** — never a blank and never a guess. "Not measurable —
behind a RAID/Intel RST controller" plus "set the storage mode to AHCI in the
BIOS, then press Rescan" is an answer; "Unknown" is not.

## What was built

**One formula, in one place** (`82f0ea6`), with a formatter per app so the
station, the asset page and the reports **word the same drive identically**
(`4f0c64b`). A drive that reads 74% on the bench must not read "Caution" in one
place and "Fair" in another.

Measured during the capture (`9cfb422`) — one timed `smartctl` JSON read, or
`mmc-utils` for eMMC — and shown on the asset page and spec rows (`7d6c3a0`),
in the kiosk (`5cb8308`), and as a **Drive health column next to Battery
health** in the reports (`f10bd76`).

**`5cb8308` — show the captured health, not an unprivileged probe.** The kiosk
was re-probing drives without privilege and getting worse answers than the
capture already held. Show what was actually measured.

## Four corrections that define the bands

**`cf888e7` — stop grading a drive Bad for a warm afternoon or a bad cable.**
Temperature and interface CRC errors were dragging the grade down. A drive that
is warm is not a drive that is failing, and a CRC error is usually the cable.

**`3f470db` — grade a SAS disk from its own logs, and never claim a counter we
did not read.** SAS drives report error counters differently; the naive read
produced zeroes, and a zero read as "no errors" rather than "not read".

**`f2963a2` — keep an eMMC's pre-EOL warning when it reports no life
estimate.** eMMC exposes both a life-used estimate and a pre-EOL warning. Some
report the warning and not the estimate; discarding the warning because the
percentage was missing threw away the more urgent signal.

**`bd6a659` — put the action in the report cell, and a SMART FAILED drive
first.** A report cell that says "Caution" leaves the reader to work out what
to do. It carries the action. And a drive whose SMART self-assessment has
**failed** sorts to the top, because that is the one to look at.

## The rule this exercise taught

**`90ed4af` — write down the one change the capture makes to a drive.**

The capture is read-only with exactly one exception, and rather than leave that
implicit it is documented. A tool that claims to be read-only and is not, in
one place, is worse than one that says where.

**`87db216` — bring the station check and the kiosk preview up to what the
screen says.** Three surfaces had drifted apart.

## How it was proved

`test-drive-health.py` and `test-drive-health.sh`, driving the real formula
against fixtures from real drives, plus an on-station check (`a9ab3ad`) so the
figure can be verified on hardware rather than only in tests.

## What was deliberately not built

No prediction of remaining lifetime in days or months. The drive reports life
used; converting that into a forecast would be inventing a number.

## Open questions

`be8d27d` — drives hidden behind a RAID/Intel RST controller have no lsblk
entry and therefore no health. They are reported in `hiddenStorage` with the
reason and the fix. **Whether such a machine should be certifiable at all
remains an owner decision.**
