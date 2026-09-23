# The first-boot OOBE check

## Status

Shipped, 23 September 2026. `3ee6f49`. Tier 3 of
`2026-09-22-autopilot-research.md`. **Deployed; the migration's application on
Railway is unconfirmed — see Open questions.**

## The problem

Every Autopilot check the station makes is inference from leftovers, because
registration lives in Microsoft's cloud against the hardware hash and no third
party can query it. On a machine that arrives already wiped there are no
leftovers at all, and the honest answer is UNKNOWN forever.

But the truth does appear, once, free — and the business was already walking
past it.

## The mechanism

When a freshly imaged machine reaches the Windows setup screen with a network,
it asks the ZTD service about itself. If it is registered, Microsoft answers
with the owning organisation's profile and Windows shows **that company's
branded sign-in screen** instead of the generic one.

That is Microsoft stating, out loud, that the machine belongs to someone else.

## Why it is recorded by hand

The station *is* the machine — it boots from the USB stick. To reach OOBE the
machine must reboot into Windows, and at that instant the station no longer
exists. Nothing is running that could observe the screen.

So the observation is filed afterwards, against the asset, by the person who
saw it. This is not a shortcut; it is the only place it can live.

## What was built

A `autopilot_oobe` jsonb column on `asset_audits`, a `POST
/assets/:id/autopilot-oobe` endpoint behind `perform_goods_in_audit`, and a
panel on the asset page directly beneath Device Locks.

Three answers:

| What was seen | Recorded | Effect |
| --- | --- | --- |
| A company name or logo | `organisation` | Device becomes **LOCKED** |
| Generic Microsoft setup | `generic` | Strongest negative available |
| Could not check | `blocked` | Nothing concluded |

**`organisation` outranks every offline check**, including on a wiped disk
where they found nothing. The form requires the organisation's name — it is the
single most useful fact for getting a machine released, and it is on screen in
front of the technician as they answer. It also asks whether the screen was
photographed, because Microsoft's deregistration process asks for that
screenshot by name.

**The asymmetry is deliberate and is the heart of the design.** A `generic`
result does **not** promote a device to CLEAR. The offline checks may have
found a domain join, a firmware password or an Absolute agent that OOBE knows
nothing about; and it is a statement about one date, so a registration added
next week would not have shown.

A row with no check at all is a **fourth state** — nobody has looked. The
migration deliberately performs **no backfill**: inventing `generic` for
machines nobody checked is exactly the false-clean answer the feature exists to
prevent.

## Why its own column

`hardware_profile` is machine-captured and is **replaced wholesale** on every
re-capture (see `record_install` in `tools/gui/server.py`). A human finding
stored in it would be destroyed by the next audit of the same machine.

## What was deliberately not built

The column is absent from the PowerSync upload allowlist, like `lock_status`
and the rest of the derived lock evidence: it is written by the API endpoint,
not by a syncing client.

The DTO validates strictly and answers 400 on a bad value — unlike the station
ingest next door, which deliberately does not, because a rejected record wedges
an offline queue forever. That reasoning does not apply to a person at a
browser who can be told immediately.

## How it was proved

`autopilot-oobe.spec.ts`, 7 cases on the roll-up alone: an organisation makes a
CLEAR device LOCKED; a generic result changes nothing in either direction; an
unrecognised stored value is ignored rather than guessed at; a non-object input
is not mistaken for an answer. Full API suite 574 passing; both apps typecheck;
CI green.

## Open questions

**1. The migration.** `synchronize` is off and no `migrationsRun` is configured
in the repo — the auto-run is a Railway dashboard setting, invisible from a
clone. The API stays up whether or not the column exists, so a 200 on the root
proves nothing; if the column is missing, every query touching `asset_audits`
500s. **Verify by opening any asset page.** If it errors:
`cd /app/apps/api && npm run migration:run`.

**2. The certificate gap.** An OOBE finding updates the asset's current lock
status but does **not** change an already-issued erasure certificate. The
certificate's "Device lock" line is deliberately a snapshot of what the station
found *at wipe time* (owner decision D39) — it reads from the wipe record, not
the asset's current status.

So a machine that turns out to be Autopilot-locked at OOBE *after* its
certificate was issued keeps a certificate that does not mention it. D39's own
reasoning was that the lock is printed "because the buyer needs to know", which
suggests a lock discovered at OOBE should reach it too. **Owner's decision; not
changed unilaterally.**
