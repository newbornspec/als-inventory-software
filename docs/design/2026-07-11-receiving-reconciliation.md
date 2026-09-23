# Receiving reconciliation: expected against actual

## Status

Shipped, 11 July 2026. `534e85a` · `1f1a542` · `06931c3` · `8fa0d10` ·
`39245b8`

Phases 2.1, 2.2, 2.3 and 2.6.

## The problem

A supplier's manifest says what was sold. The pallet says what arrived. They
differ, and the difference is money: short deliveries, substitutions, and
devices nobody expected. Before this there was no way to state that difference
except by eye.

## What was built

**A reconciliation engine** (`534e85a`) that compares the imported manifest
against what has actually been received, and classifies each line:

- **found** — expected and arrived
- **missing** — expected, not arrived
- **extra** — arrived, not on the manifest

**Scan-to-receive** (`06931c3`): a device is received by scanning it, which
matches it against the manifest and marks it found in one action.

**Verification before receiving** (`8fa0d10`): the scan checks against the
uploaded list *before* the device is accepted, so a device that is not on the
manifest is flagged at the moment it is scanned rather than discovered in a
report afterwards.

## The defect worth recording

`39245b8` — *"extra" no longer flags duplicates of a found item.*

Scanning the same device twice classified the second scan as an **extra**
device: an unexpected arrival, which on a reconciliation report reads as a
supplier discrepancy worth querying. The engine was comparing scans to manifest
lines without accounting for a line already being satisfied.

The general shape — a repeated action being counted as a new fact rather than a
repeat of the same one — recurs later in the pallet merge invariant and in the
wipe-record de-duplication.

## Why it matters

The reconciliation report is what a buyer takes back to a supplier. A false
"extra" is an accusation.

## What was deliberately not built

No automatic resolution. The engine states the difference; a human decides what
it means. An ITAD lot legitimately contains substitutions and bonus stock, and
guessing which is which would produce confident nonsense.

## Open questions

None outstanding.
