# Pallet layouts hardened, and invoicing

## Status

Shipped, 17–18 August 2026. `cfe2c9a` · `090a1ca` · `8ce1961` · `f2226cb` ·
`2916c1a` · `bcdf8a4` · `ea046b3` · `60a2107` · `d1a829f` · `4f06853` ·
`b86d15a` · `6364b98` · `40bb0f6` · `11eb4f2` · `828aeb0`

## Layout 1 rebuilt

**`cfe2c9a`, `090a1ca` — one row per product/variant, a ten-column item table,
and typed pallet numbers.**

Layout 1 had been a light list. In use it turned out to need most of what
Layout 2 had, minus the spec columns. Pallet numbers became typed values rather
than free text, because they are referenced on exports, invoices and physical
labels, and a typo in one place breaks the link to the others.

`2916c1a` then tightened it: a fixed manufacturer list, free-text model,
**no line total**, and roomier fields. Dropping the line total was deliberate —
it was being read as a price when it was a count.

## Dropdowns, and the "None" problem

**`bcdf8a4`** restricted Manufacturer, CPU and RAM on Layout 2 to fixed lists,
and labelled the row actions.

**`ea046b3` — store "None" explicitly, the way CPU already does.**

This is the interesting one. A pallet line with no RAM fitted and a pallet line
where nobody recorded the RAM are different facts, and both were stored as
empty. A buyer reading the export cannot tell "this machine has no memory in
it" from "we did not write it down".

Storing `None` as a value makes the two distinguishable. It is the same
distinction as everything in the September false-absence work — *absent* versus
*not established* — arriving a month earlier, in a dropdown.

`d1a829f` and `4f06853` followed from real use: Intel Pentium was missing from
the CPU list, Gen needed a "None" option, and that option belonged at the **top**
of the list rather than alphabetically among the generations.

## The migration defect

**`f2226cb` — fix 42P08 in the pallet spec-columns migration: seed with
`VALUES`, not `SELECT`.**

Postgres error 42P08 is *ambiguous parameter type*. The migration seeded new
columns using a `SELECT`, which left the parameter types undetermined; using
explicit `VALUES` fixes the types.

**`8ce1961` — keep adding a line working during the deploy window.** The same
migration-ordering hazard documented on 10 July, met in practice: between the
code deploying and the migration running, adding a pallet line broke. The fix
made the code tolerate both schemas for that window.

## Invoicing

`40bb0f6` (API, storage, PDF) and `11eb4f2` (collect everything *before* the
invoice is raised). The ordering matters: an invoice that can be raised and
then completed is an invoice that goes out incomplete.

Invoicing was **unhooked from the pallet** three days later (`d3eead7`) — it had
been attached there because that was where it was first needed, not because it
belongs there.

## What was deliberately not built

No accounting integration. The system produces an invoice document; it is not
a ledger.

## Open questions

None outstanding.
