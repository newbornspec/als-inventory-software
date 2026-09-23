# Permissions rebuilt fail-closed, and the workflow split

## Status

Shipped, 21–22 August 2026. `b2fdf04` · `6620738` · `52f01a4` · `7dcd142` ·
`e3c96bd` · `b003026` · `94cfd05` · `a89d309` · `43ba83d` · `ff0e4f4` ·
`980ef15` · `70420f6` · `06bf985`

Phases 1–3 of the client's audit specification.

## The problem

Permissions had grown case by case since July's ownership work. Each endpoint
decided for itself, which meant the **default was open**: a route added without
a guard was reachable by anyone signed in. Nobody could state what a given role
could do without reading every controller.

## What was built

**`b2fdf04` — per-user permissions, fail-closed across the whole API.**

The inversion is the point. A route with no declared permission is **refused**,
not allowed. Adding an endpoint and forgetting to guard it now produces a
visible 403 in testing rather than an invisible hole in production.

**`6620738` — permission-aware navigation.** The nav is built from what the
signed-in user may actually do; landing rules send each person to a page they
can use; deep links are honoured rather than bounced to a generic home.

The rule underneath it: **the UI hides what the API refuses, and the API is
what enforces.** Hiding a button is a courtesy, never a boundary. Every gated
control in the app is gated on the same permission the API checks — stated
explicitly in `b9923a1` for the lot detail page.

**`980ef15` — station sticks get a dedicated least-privilege account, not
admin.** Every USB stick had been authenticating as an administrator. A lost
stick was a full compromise. The station account can file audits and nothing
else.

## The workflow split

**`e3c96bd`, `b003026` — the Lots section became Audit; Goods In became its own
section.** Two genuinely different jobs had been sharing screens: receiving
stock, and auditing it.

**`43ba83d` — workflow-first Audit Station: Amazon audits are standalone,
batch-free.** An Amazon audit is not part of a goods-in lot; forcing one into a
batch meant inventing a batch to satisfy the model.

**`94cfd05`, `a89d309` — an audit workspace with a day-grouped feed, and audit
provenance**: workflow kind, operator identity, restore-image results. Provenance
is what makes an audit re-readable months later.

**`ff0e4f4` — Goods In allocation: select devices, move them to a pallet, fully
reversible.** Reversibility was a requirement, not a nicety — allocation is done
at speed and mistakes are normal.

## CI arrives

**`70420f6` — typecheck, tests, migration chain from scratch, and a boot smoke
test on every PR.**

The **migration chain from scratch** is the valuable one. It catches a
migration that works against today's database but not against an empty one —
which is exactly what a new environment, or a restored backup, does.

## The defect worth recording

`52f01a4` — **protect `/audit`, and correct a false claim about
`asset_audits`.** A new section had shipped without middleware protection, and
a comment in the code asserted something about the audit table that was not
true. Both found in the same pass: the unprotected route by checking every
route, the false comment by checking every claim.

`7dcd142` then closed a **middleware matcher gap** and a dead `/audit` link —
the kind of thing a fail-closed default surfaces immediately.

## What was deliberately not built

No role hierarchy. Permissions are a flat set of named actions, and roles are
default *sets* of them. A hierarchy invites "manager implies technician", which
is exactly the assumption that made the old model unstatable.

## Open questions

Phases 4–6 of the client specification were still outstanding at this point.
