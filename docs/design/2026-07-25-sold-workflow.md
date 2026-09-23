# The Sold workflow replaces Sales

## Status

Shipped, 25 July 2026. `271a58c` · `ac6892d` · `1b8d360` · `bb34194` ·
`8232092`

Supersedes `2026-07-12-sales-costing-and-sessions.md`.

## The problem

The sales module built thirteen days earlier modelled an order book: customers,
orders, line items, fulfilment. The business does not have one. Stock goes to
trade buyers in bulk, and what has to be recorded is a **status transition** —
this has left, on this date, for this price — not an order lifecycle.

Every screen in the sales module asked for information nobody had.

## What was built

**Sold as a status**, not a module (`271a58c`). Customers and Sales pages were
removed entirely.

- **Sell from anywhere it makes sense**: a whole lot from its status, a single
  device from the table (`ac6892d`), an asset pallet as one unit (`956f917`).
- **A Sold page** (`1b8d360`) with hierarchy groups, bulk selection, filters
  and CSV export — an archive, not a workflow.
- **Sale price captured at sell time** (`8232092`), which is what made the
  Reports finance analytics possible the same day.

## The two rules that make it safe

**Selling is terminal, and locks.** A sold asset leaves active inventory and
cannot be edited. Only an admin can return it (`return_sold` is admin-grade and
is in no default permission set).

**Returning reactivates what it came from** (`bb34194`). A device returned from
a sale reactivates its shipped pallet or sold lot — otherwise the device comes
back to a container that still says it has gone, and the stock counts disagree
with each other.

**A sold device leaves its pallet, but the pallet is remembered.** Clearing the
allocation is necessary — an open pallet must not keep claiming stock that has
physically gone — but it destroys the only record of where the device sat. So
`sold_from_pallet_id` keeps the history without the claim, and nothing counts
it. `f19fcbd` later surfaced it on the register.

## Why it matters

This is the clearest case in the project of **deleting a working feature
because it modelled the wrong world.** The sales module was not broken; it was
answering a question the business does not ask.

The costing built alongside it survived, because *profit per device* is a real
question. The order management did not.

## What was deliberately not built

No invoicing inside the Sold workflow. Invoicing arrived separately in August
and was then deliberately unhooked from the pallet (`d3eead7`) when it turned
out not to belong there either.

## Open questions

None outstanding.
