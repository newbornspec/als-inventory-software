# Pallet layouts, and the All Inventory roll-up

## Status

Shipped, 23–25 July 2026. `c542b72` · `14cb12b` · `bd48bc6` · `425e22a` ·
`1e2837f` · `026350c` · `5e571e1` · `7c932a1` · `508d9b9`

## The problem

**Pallets are built two different ways**, and one screen could not serve both.
A monitor pallet is a short list of variants and counts. A mixed-spec pallet of
laptops needs a row per configuration with processor, generation, RAM, storage
and screen — closer to a spreadsheet than a form.

Separately: **the Assets page only ever showed serialised devices.** Anyone
looking for "what stock do we hold" got an answer that silently excluded every
pallet line and every consumable.

## What was built

**A layout selector** (`14cb12b`) — Layout 1 for the simple case, Layout 2 for
the spec table — with **master dropdown values** behind it (`c542b72`) so
manufacturer, CPU and RAM come from managed lists rather than free text. Free
text on a spec column makes the export unusable: "i5", "Core i5", "Intel i5"
and "i5-8250U" are four products.

**Layout 2 got its own export** (`425e22a`) with split columns, because a spec
table flattened into the Layout 1 report loses the thing it exists for.

**`026350c` — Layout 2 became a persistent grid editor, not a one-shot form.**
The original built a pallet in one submission. In practice a pallet is built
over hours, interrupted, and corrected. Treating it as a saved grid that is
edited rather than a form that is submitted matched what people were doing.
`bd48bc6` added the Excel affordances that follow from that — paste, sort,
search.

**The All Inventory roll-up** (`5e571e1`): one page counting all three tiers —
serialised assets, pallet lines, consumables — so the question "what do we
hold" has an answer. `7c932a1` made the Assets page state plainly that it is
serialised-only and link across, rather than leaving the reader to infer it.

## Why it matters

The roll-up is the correction of a false absence at the product level: a page
that answered a narrower question than the one people were asking it, without
saying so.

## What was deliberately not built

The two layouts were not merged into one configurable screen. They look similar
enough that merging is tempting; they are used differently enough that the
merged screen would serve neither.

## Open questions

Layout 1 was rebuilt in August (`cfe2c9a`, `090a1ca`) into a ten-column item
table with typed pallet numbers, and both layouts had their dropdowns tightened
(`bcdf8a4`). The merge invariant — that merging pallets **moves** lines and
never copies them — came later, on 20 August.
