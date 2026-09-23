# Unit ID, printed labels, and normalising specifications

## Status

Shipped, 29–30 July 2026. `aeaa9f2` · `c51ab98` · `a49d857` · `65b34aa` ·
`f524b0e` · `a834836` · `3013d89` · `e8e6ba6` · `d251cb3` · `19bc72c` ·
`424bb11` · `d60d401` · `261fe8d` · `eef4a8f`

## Unit ID and the label

**`aeaa9f2` — a Unit ID, and a per-row Print button.**

A device needs an identifier the warehouse can say out loud and write on a box.
A serial number is long, inconsistent between manufacturers, and sometimes
absent. The Unit ID is derived from the hierarchy the business already uses —
**Batch → Lot → Unit** — so the identifier carries its own provenance.

Then four commits on the physical label, all learned from printing:

- **`c51ab98`** — exact 88.9 × 27.94 mm stock, cleaner CPU line, larger barcode
- **`a49d857`** — resized to Brother DK-11201 media (90 × 29 mm) for the QL-800
- **`65b34aa`** — optional caption via `?text=0`
- **`f524b0e`** — brand-only maker, all-black ink, fit long models

**All-black ink is not cosmetic.** A thermal label printer has one colour;
anything designed in grey prints as a muddy dither that a scanner reads badly.
The label had to be designed for the device that prints it, and that was found
by printing.

`eef4a8f` then put Unit ID as the **first column** of the lot report, so the
printed sheet and the printed label lead with the same identifier.

## Specification normalisation

**`a834836` — standard RAM capacity and laptop screen size.**

Captured hardware is messy. A machine reports 7.73 GB of usable RAM because the
integrated graphics took the rest; a panel measures 13.94 inches. Reported raw,
the same model appears as four products and no two lots are comparable.

So there are rules: RAM rounds to the standard capacity actually fitted, and
screen size to the size the panel is sold as.

**`3013d89` — true installed RAM, built-in panel size.** The audit tool was
reading *usable* memory rather than what is physically installed. Reading the
DMI memory devices — what is in the slots — is the correct source.

**`e8e6ba6` — apply the rules on ingest AND in exports, and backfill.** All
three, deliberately: new captures are normalised, old rows are corrected, and
exports apply the rules so a report of historic data reads consistently with a
report of today's.

## The defect worth recording

`d60d401` — **screen size was never being read: the sysfs stat-size trap.**

The tool read the panel size from a sysfs file by checking the file's size
before reading it. Files in sysfs report a size of 0 regardless of content —
they are generated on read. The guard rejected every file as empty, so screen
size was blank on every audit, silently, since the feature shipped.

A textbook false absence, and a reminder that a sanity check written for
ordinary files is wrong for a synthetic filesystem.

## Also on these days

`d251cb3` — admin-only **Delete lot**, cascading to everything inside it.
`19bc72c` — asset grade on the kiosk audit panel.
`261fe8d` — **`sync-usb.ps1`**, to stop sticks drifting from the repository.
That script is now the only sanctioned way a stick is updated, and it verifies
every file by SHA-256 after copying.

## What was deliberately not built

No guessing at specifications the machine does not report. A value that cannot
be read stays empty.

## Open questions

None outstanding.
