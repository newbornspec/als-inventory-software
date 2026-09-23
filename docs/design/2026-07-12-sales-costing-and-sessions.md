# Sales, costing, and the session faults found underneath them

## Status

Shipped 12 July 2026, **superseded 25 July**. `0f13016` · `e4be541` ·
`e2cb6eb` · `e8f3bfb` · `1a2e4d3` · `673f096` — and the session fixes
`2055248` · `084c7df` · `752061f` · `a50df73` · `3f4f715`

Phases 6.1 through 6.4c.

## What was built

A conventional sales module: **customers**, **sales orders with line items**,
a **scan-to-pick** fulfilment flow for serialised devices, and costing —
per lot (`1a2e4d3`) and then per asset (`673f096`).

Per-asset costing is the piece that survived. Apportioning a lot's purchase
price across its devices is what makes profit-per-device answerable, and that
number drives grading and pricing decisions.

## Why it was replaced

Thirteen days later, `271a58c` **replaced Sales with the Sold workflow**, and
the Customers and Sales pages were removed entirely.

The reason: the business does not run an order book. Stock is sold in bulk to
trade buyers, and what the warehouse needs to record is *this device has left,
on this date, for this price* — a status transition, not an order lifecycle.
The sales module modelled a process that was not happening, and every screen in
it asked for information nobody had.

This is the clearest example in the project of **building the obvious thing and
then finding the business does not work that way.** The costing survived
because it answered a real question; the order management did not because it
answered an invented one.

## The session faults, which were the more important find

Building the sales screens exposed four authentication defects that had been
live since the start:

**`2055248` — silent write failures.** The JWT expired after 15 minutes. A
technician working through a pallet would have writes rejected with no visible
error: the page looked fine and the data was gone. Extended to 12 hours, and —
the actual fix — **pallet-line errors were made visible**.

**`084c7df` — the environment lied.** `JWT_EXPIRES_IN` was pinned in the
deployment environment and overrode the code. Forced in code, ignoring the env.

**`752061f` — server-side session auto-refresh**, plus full-reload login and
logout, so a stale session cannot persist in a rendered page.

**`a50df73` — `apiFetch` threw on empty response bodies.** A 204 or an empty
200 from a successful DELETE was parsed as JSON, threw, and surfaced to the
operator as a failed deletion that had in fact succeeded.

**`3f4f715` — a server-side crash on delete with a stale session**, which took
the whole page down rather than asking the user to sign in again.

All five share a shape: **the system was right and the operator was told it was
wrong, or vice versa.** A silent write failure and a false delete error are the
same bug from opposite ends.

## What was deliberately not built

No invoicing at this stage — it arrived separately in August, and was then
unhooked from the pallet (`d3eead7`) when it turned out to belong elsewhere.

## Open questions

None. Superseded by `2026-07-25-sold-workflow.md`.
