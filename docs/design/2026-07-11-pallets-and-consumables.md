# Pallets and bulk consumables

## Status

Shipped, 11–12 July 2026. `19372c1` · `63922ca` · `ad776c4` · `6eb8a5d` ·
`45014ab` · `0a204a6` · `96684c8` · `e00c40d` · `855cc23`

Phases 3.1 through 3.3b, plus the first round of use.

## The problem

Not everything in an ITAD warehouse is a serialised device.

**Monitors** ship by the pallet and are counted by variant, not tracked
individually — nobody records the serial of each of forty identical 24-inch
screens. **Consumables** — cables, caddies, screws, packaging — are stock
levels, not assets.

Forcing either into the asset table would have meant either fictional serial
numbers or forty rows for one pallet.

## What was built

**Pallets** (`19372c1`, `63922ca`): a `Pallet` with `PalletLine` rows, each
line a variant and a quantity. Later given a **Tier** and a **Grade** column
(`96684c8`), an Excel report, and a shipped workflow (`45014ab`).

**Per-line supplier** (`0a204a6`), because a pallet is built from stock bought
from several suppliers. This was later reversed — `6f4270d` moved Buyer to
pallet level and dropped the per-line column — when it turned out the mixed
case was rarer than the column cost in width.

**Consumables** (`ad776c4`, `6eb8a5d`): `StockLine` and `StockMovement`, so
stock is a running balance derived from movements rather than a number somebody
edits. Given stock status — in / low / out — and a "Used" reason on each
movement (`e00c40d`).

## A feature removed on the same day it was reviewed

`855cc23` — **warranty tracking was removed**, and replaced with alerts on
out-of-stock and low consumables.

Warranty tracking had been built speculatively. Nobody was using it, and the
data to make it useful (per-device warranty terms from each manufacturer) was
never going to be entered by hand. The alerting it was replaced with answers a
question the warehouse actually asks: *are we about to run out of caddies?*

Worth recording because removing a feature is usually harder to justify than
adding one, and this codebase did it repeatedly.

## What was deliberately not built

No per-unit tracking for pallet lines. A pallet line is a count of a variant,
and the system is honest that it cannot tell you which physical monitor is
which. That is the correct model for the business, not a limitation to fix.

## Open questions

The pallet model was substantially rebuilt twice afterwards — Layout 1 and
Layout 2 in late July, and the merge invariant in August. See those records.
