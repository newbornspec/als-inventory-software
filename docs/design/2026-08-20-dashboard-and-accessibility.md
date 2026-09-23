# The operational dashboard, and a WCAG 2.2 AA pass

## Status

Shipped, 20 August 2026. `9c7599d` · `4775872` · `6d00207` · `8512932` ·
`5e9c2aa` · `2b26427` · `3deccdf` · `8184d59` · `026c00a` · `97bc302` ·
`19c8b9e`

## The dashboard

**`9c7599d` — one operational roll-up, computed in SQL.**

The dashboard had grown into a page that issued many queries and assembled the
answer in JavaScript. Moving the roll-up into one SQL statement made it both
faster and — more importantly — **consistent**: figures computed in separate
queries at slightly different moments disagree with each other, and a dashboard
whose numbers contradict each other is worse than no dashboard.

**`4775872` — an operational control centre.** Rebuilt around what somebody
running the floor needs to decide *today*, rather than a set of totals.

## The defect worth recording

`19c8b9e` — **"In stock": the figure counted five statuses, the link asked for
one.**

The headline number totalled five stock statuses. Clicking it navigated to a
filtered list asking for one. The user saw a number, clicked it, and got a much
shorter list with no explanation.

Neither the number nor the list was wrong on its own. The defect was that **two
parts of one page answered different questions while appearing to answer the
same one** — the same shape as the reports filter bug in July, and one that only
shows up when somebody actually clicks.

## The accessibility pass

`6d00207` closed out a **WCAG 2.2 AA** audit. The commits around it are the
substance:

- **`5e9c2aa`, `2b26427`** — lighter field borders, and the trade-off written
  down. Then corrected to `#c4c4c4` when the lighter value failed contrast, and
  the token stopped being used to paint page furniture it was never meant for.
- **`3deccdf`, `8184d59`** — pallet grids and the repairs log moved to one
  shared gridline instead of a box per cell. Fewer borders, better contrast
  where it counts.
- **`026c00a`** — three field treatments, each matched to what the control
  actually is, rather than one style stretched over inputs, selects and
  read-only values.
- **`97bc302`** — outline buttons brought to 3:1, and **the tokens renamed
  after what they do** rather than what colour they are. A token called
  `grey-300` invites use anywhere; one called `field-border` does not.

## Why it matters

This work established a baseline the whole app is held to: **status is never
conveyed by colour alone**, and a printed or greyscale copy of any page has to
read identically. The device-lock section written in September states that rule
in its own comments and pairs every colour with a word.

That matters commercially, not just ethically — an erasure certificate and a
lock status get printed, faxed and photocopied.

## What was deliberately not built

No accessibility overlay or widget. The markup and the contrast were fixed.

## Open questions

None outstanding. The August redesign series (#15–#45) extended the visual
system to every page.
