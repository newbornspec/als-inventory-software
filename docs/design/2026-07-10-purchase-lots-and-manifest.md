# Purchase lots, the product catalogue, and the supplier manifest

## Status

Shipped, 10 July 2026. `afb586a` · `7a27262` · `cdb25ff` · `523ccd0` ·
`60488ed` · `1b464e4` · `4b0364f`

Phases 0.1 through 1.3b of the original build plan.

## The problem

Stock arrives as a **purchase lot** — a pallet or a van-load bought from a
supplier, described in advance by a spreadsheet, and only later unpacked and
counted. Before this, the system had assets but no concept of what was
*expected*, so there was nothing to reconcile against.

## What was built

**A product catalogue** (`afb586a`), and assets linked to it (`7a27262`). The
point is that a hundred identical ThinkPads should share one product record
carrying the specification, rather than each device carrying its own free text.
Sub-lots gained a *declared* specification — what the seller said this tranche
would be.

**Pre-arrival fields on the purchase lot** (`cdb25ff`, `523ccd0`) so a lot
exists, with expected quantities and a supplier, before a single device is
touched.

**The supplier manifest** (`60488ed`, `1b464e4`): the expected inventory, and a
client-side CSV/XLSX importer for the list the supplier emails over. Parsing in
the browser rather than on the server was deliberate — the files are small,
the formats are inconsistent, and the operator needs to see what was understood
before it is committed.

**Vocabulary.** "Purchase Lot" and "Sub-lot" were fixed here (`523ccd0`) and
have held ever since. Naming the domain early is why later features could be
described in the owner's own words.

## The deploy guardrail

`4b0364f` documented the deploy process and, more importantly, the
**migration-ordering hazard**: TypeORM SELECTs every mapped column, so
deploying an entity that declares a new column *before* its migration adds that
column makes every query on that table 500. This had already caused a Phase 0
outage taking `/assets`, `/lots` and `/notifications` down.

It is written down because it is not intuitive and it recurs.

## What was deliberately not built

No supplier portal, no EDI. The manifest is a spreadsheet because that is what
suppliers actually send.

## Open questions

None outstanding. The reconciliation engine that consumes the manifest followed
the next day.
