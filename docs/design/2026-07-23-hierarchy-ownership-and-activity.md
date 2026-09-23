# Hierarchy, batch ownership, and the activity log

## Status

Shipped, 23 July 2026. `3c4d1c9` · `86ad6db` · `947fcca` · `fb9b1d5` ·
`dc0cdd4` · `cfab044` · `7d9ab83` · `9f6e9df` · `8562d72` · `8b67bd3` ·
`13a2f07` · `8d74685` · `d5f7fd0` · `652e166` · `76e1dd1` · `b911f6a` ·
`cbc6bf5`

A single day, and one of the densest in the project.

## The problem

Two problems, solved together because they are the same problem.

**Navigation.** The system had grown flat: assets, lots, pallets, all listed
separately. The warehouse thinks in a hierarchy — a purchase lot contains
devices, a device has hardware — and the screens did not.

**Accountability.** With several managers buying and processing stock, nobody
could answer *who did this, and whose stock is this?*

## What was built

**The drill-down** (`3c4d1c9`, `86ad6db`, `947fcca`): Lot → Asset → Hardware,
with a breadcrumb trail, and Total/Audited/Pending counts on each lot card so
the state of a lot is visible without opening it.

A deliberate exception: **the global Assets page was kept as a search**, not
converted into another drill-down. Two different questions — *what is in this
lot* and *where is this serial* — need two different screens.

**Ownership** (`fb9b1d5`), then **enforcement in six passes**:

| | Scope |
| --- | --- |
| E1 | Batch reads |
| E2 | Asset reads, via their batch's owner |
| E3 | Dashboard, reports and certificates |
| E4 | Write guards, plus admin reassignment |
| E5 | The PowerSync upload path *and* the sync rules themselves |
| E6 | The activity log |

**E5 is the one that mattered.** Scoping the API is not enough when clients
sync a local database directly: without scoping the sync *rules*
(`d5f7fd0`), a manager's device would download rows they could not fetch over
HTTP. Guarding the upload path and the download rules are two separate jobs.

**A system-wide activity log** (`cfab044`), and ownership carried into the
batch report (`dc0cdd4`) so a printed report says who generated it.

## Two decisions that shaped later work

**Managers only.** Scoping applies to managers. Admins and technicians see
everything — technicians are floor staff who scan into any lot, and scoping
them would break the job. This is stated once, in `isScopedManager`, and every
guard reads it from there.

**An unowned pool** (`b911f6a`). Technician-created lots belong to nobody and
are visible to all managers. Without this, a technician's work would have been
invisible to everyone, including the manager who needed it.

## The defect worth recording

`cbc6bf5` — **the PowerSync sync rules crashed on the OR / IS NULL parameter
query.** The rule expressing "owned by me, or unowned" was not expressible the
way it was first written, and the failure took sync down entirely rather than
returning a narrower set.

## What was deliberately not built

**Per-user isolation on the audit station was deferred.** The sticks share a
station account; scoping them needed PowerSync work that was not done here. It
was still outstanding when the station got its own least-privilege account in
August (`980ef15`).

## Open questions

None outstanding from this work; the permission model was rebuilt fail-closed
on 22 August, which superseded the ad-hoc guards added here.
