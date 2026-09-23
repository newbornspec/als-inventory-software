# Foundation: an offline-first warehouse system

## Status

Shipped, 9–11 July 2026. `b80ee10` · `b7cec1b` · `cf69abb` · `ac0c648` ·
`9d83ea2` · `084fc58` · `a1f172e`

The first week of the project.

## The problem

An ITAD warehouse floor is not a reliable network. Devices are scanned in
loading bays and back rooms, and a system that stops working when Wi-Fi drops
is a system nobody uses. The requirement was that a technician can keep
scanning and recording with no connection at all, and that the work reaches the
server when it can.

## What was built

Three deployable pieces, which is still the shape of the system today:

- **A NestJS API** on Railway, with Postgres.
- **A Next.js web app** on Vercel.
- **PowerSync** as the offline sync service, so the client holds a local
  database and reconciles later.

## The faults that shaped it

PowerSync did not work out of the box, and each failure taught something that
is still load-bearing:

**It hung silently.** The worker assets were never being copied into the
build (`ac0c648`). A sync service that hangs looks identical to one with
nothing to sync — the first instance in this project of a failure that
presents as a clean state.

**Auth failed for a non-obvious reason.** JWTs have to be signed with the `kid`
PowerSync's keystore expects (`9d83ea2`). Not documented anywhere obvious;
found by reading what the keystore actually asked for.

**Offline writes dropped every multi-word column** (`084fc58`). Any column name
with an underscore-separated second word was silently discarded on upload. The
data looked saved on the device and arrived incomplete — again, a failure that
does not announce itself.

**A deleted batch reference wedged the whole upload queue** (`a1f172e`). One
unresolvable foreign key stopped every queued write behind it, indefinitely.
This is the ancestor of a rule that recurs throughout the project: *a record
the server refuses must be visible, not retried forever in silence.*

## Why it matters

The offline queue is the single most dangerous component in the system,
because its failure mode is losing a technician's work without telling anyone.
Three of the four faults above were silent. That pattern — the dangerous bug is
the quiet one — became the organising idea of the whole codebase.

## What was deliberately not built

No attempt was made to make the web app work offline. Only the scanning and
capture paths are offline-first; reporting and administration assume a
connection.

## Open questions

Per-user data isolation was deferred at this stage; it needed PowerSync sync
rules scoped by owner, which arrived on 23 July.
