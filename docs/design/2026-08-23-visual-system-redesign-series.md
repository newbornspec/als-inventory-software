# The redesign series: thirty-one pages into one visual system

## Status

Shipped, 22–25 August 2026. Pull requests **#15 through #45**, thirty-one
merges over four days. `5e80110` … `b9923a1`

## The problem

The app had been built feature-first for six weeks. Every page worked; no two
looked alike. Tables had different header treatments, pages had different
container widths, some paginated and some rendered every row, and the
navigation had grown to **thirteen top-level destinations** that wrapped onto
two rows at ordinary window widths.

## What was built

**`aa7a649` (#25) — thirteen destinations grouped into five, one row at every
width.** The prerequisite for everything else: a nav that fits.

Then each major page brought into one visual system, and — this is the part
worth recording — **each pass found real defects**, because rebuilding a page
means reading what it actually does:

| PR | Page | What the rebuild exposed |
| --- | --- | --- |
| #22, #23 | Assets register | Showed **no sold devices at all**, and lost the pallet they sold from |
| #24 | Assets | Record which pallet a device was sold from, and show it |
| #28 | Dashboard | "In stock" counted five statuses; its link asked for one |
| #29 | Inventory | Counted things not actually held |
| #31 | Pallets | Two defects the visual pass exposed |
| #32 | Assets | Rendered **every** device; now paged |
| #38 | Activity | Truncated the log **in silence**; now paged |
| #40 | Lookups | **Every write 500'd** |
| #44 | Lot detail | Reconciliation did not tell the truth |
| #45 | Lot detail | Controls not gated on the permission the API enforces |

Ten substantive faults, several of them long-standing and user-visible, found
by looking carefully at pages nobody had questioned since they were written.

**#40 is the starkest**: every write on the Lookups page returned a 500. The
page managed the master dropdown lists behind both pallet layouts — so the
feature had presumably been unusable since it shipped, and it took a redesign
pass to notice.

## The smaller corrections, which are the same idea

- **#39** — *state the shelf before listing it.* A list with no statement of
  what it contains.
- **#35** — *summarise the days instead of leaving the reader to add them up.*
- **#34, #43, #37** — contain the page; card the panels; card two forms so they
  stop reading as one.
- **#41, #43** — make Delete **ask first**, and mark your own row in the user
  list.
- **#36** — put the toggle **on the field it controls**.

Every one is the same principle in a different place: **the page should state
what it is showing, and a control should sit next to the thing it affects.**

## Why it matters

The commercial argument for a visual system is consistency. The argument this
series actually made is different and stronger: **a page nobody has re-read
since it was written is a page with undiscovered faults in it.** Ten defects
in thirty-one pages is a hit rate that justifies the exercise on correctness
grounds alone.

## What was deliberately not built

No component library or design-system package. The system is a set of shared
tokens and conventions applied consistently, which is enough at this size and
does not add a build dependency.

## Open questions

None outstanding from this series.
