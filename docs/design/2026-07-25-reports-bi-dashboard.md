# Reports: a BI dashboard in eleven slices

## Status

Shipped, 25 July 2026. `8232092` · `1e01454` · `e0e6b64` · `b19daef` ·
`c0b1ad5` · `64a1e45` · `2919bfc` · `7a0cfdc` · `c2995d6` · `dabc4aa` ·
`37efab4` · `8640688`

Eleven slices in one day.

## The problem

The system held everything needed to answer real commercial questions — what a
lot cost against what it returned, which supplier delivers what was promised,
how many devices a technician audits in a week — and none of them could be
asked.

## What was built

| Slice | What it answers |
| --- | --- |
| 1 | KPIs — the headline numbers |
| 2 | Sales and finance analytics |
| 3 | Batch and lot performance, with drill-down |
| 4 | Warehouse operations throughput |
| 5 | User performance comparison |
| 6 | Consumables analytics |
| 7 | Activity timeline |
| 8 | Pallet analytics |
| 9 | Supplier performance |
| 10 | Cross-report dimension filters |
| 11 | xlsx and PDF export, filter-aware |

Slices 10 and 11 are what make the other nine usable. A dimension filter that
applies across every report means a question can be narrowed once — *this
supplier, this quarter* — and carried through. **Filter-aware export** means
what is downloaded is what is on screen; an export that silently returns the
unfiltered set is a report that lies.

## The defect worth recording

`37efab4` — **drop zero-asset suppliers when a dimension filter is active.**

Filtering supplier performance to a period listed every supplier the business
has ever used, most with zeroes across the row, because the query built its
rows from the supplier table and then joined the filtered facts. The reader
saw a page mostly full of suppliers who had done nothing in that period, and
had to find the handful who had.

Not a wrong number — a **true table that communicates badly**, which is its own
category of reporting bug.

## Why it matters

These reports are the only place the business's own performance is visible. A
supplier who consistently short-delivers, or a grading standard drifting
between technicians, shows up here or nowhere.

## What was deliberately not built

No scheduled or emailed reports. No forecasting: the system reports what
happened and does not predict.

## Open questions

The Reports pages were brought into the app's visual system in August
(`6b7407f`) as part of the redesign series, which also indexed the sections so
a reader can find the one they want.
