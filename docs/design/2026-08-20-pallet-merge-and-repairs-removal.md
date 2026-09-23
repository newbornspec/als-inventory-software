# Pallet merge, the workspace, and removing the repairs module

## Status

Shipped, 20–21 August 2026. `f0bce6d` · `fe3e09a` · `fd9373a` · `0f50ef5` ·
`9dad98b` · `1e7fe00` · `56c23d9` · `03ff468` · `14cd3b1` · `0bbf325` ·
`d3eead7`

## Pallet merge, and the invariant it rests on

**`f0bce6d` — merge pallets onto a new pallet.**

Two half-built pallets of the same product should become one. The rule that
makes this safe, and which the tests exist to protect:

> **A merge MOVES lines. It never copies them.**

If a merge copied, the stock would exist in two places at once and every total
in the system — the pallet count, the inventory roll-up, the reports — would
be wrong by exactly the merged quantity. Nothing would error; the numbers would
just be too big, and it would be nearly impossible to trace back.

**`fe3e09a` — hold merge to exactly two pallets.** An N-way merge is more
flexible and much harder to reason about when it half-fails. Two at a time,
repeated, is equivalent and recoverable.

**`fd9373a` — pallet detail 500: `PalletMerge` was never registered with the
running app.** The entity existed, the migration ran, and the module was not
wired in — so the feature worked in tests and 500'd in the deployed app. A
reminder that in NestJS, an entity that compiles is not an entity the app can
load.

## The workspace

`0f50ef5` gave pallets filter, sort, select and export; `9dad98b` fixed the
defects that reviewing it exposed; `fe3e09a` put the row actions behind a menu.

**`1e7fe00`, `56c23d9` — the export opens on the Items sheet, not the
summary.** A workbook that opens on a summary makes the reader hunt for the
data. Also fixed date-formatted metadata that Excel was reinterpreting.

## Removing the repairs module

**`14cd3b1` then `0bbf325` — remove the repair logging module, then drop the
`repair_logs` table.**

Built on 12 July (`53cf10e`), removed six weeks later. It was not being used:
the warehouse does not run a repair workshop with per-device work logs, it
grades devices and either sells or breaks them.

**The two-commit pattern is deliberate and is now the house rule for removals:
drop the code first, drop the table second.** They deploy separately. Dropping
the table while code still references it is an outage; dropping the code first
means the table sits unused for one deploy and then goes.

What was **kept**: the audit verdicts. The repairs module had accumulated
grading information that was genuinely in use, and that was preserved rather
than going with the table.

`d3eead7` — **costing and invoicing unhooked from the pallet** on the same
principle. Both were attached to pallets because that was where they were first
needed, not because they belong there.

## Why it matters

Three features deleted in one month — warranty tracking, sales, repairs — each
working, each modelling something the business does not do. **The discipline of
removing them is why the app stayed navigable enough to redesign into five
nav groups a few days later.**

## What was deliberately not built

No undo for a merge. It moves lines between containers and both remain; the
recovery is a merge back.

## Open questions

None outstanding.
