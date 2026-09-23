# Operator sign-in at the station, and hardening the kiosk service

## Status

Shipped, 19 September 2026. `ccee6c6` · `19fc391` · `3a158a0` · `3916b71` ·
`c434226` · `e7bf86e` · `f98189b` · `4a05b12` · `75efa7b` · `6f0eaf0` ·
`45c5859` · `47d5e8c` · `da060af` · `69a84fb` · `ebeb3aa` · `bc688ab` ·
`1e922f0` · `665f4ff` · `34b8be4` · `d0b7a52` · `f4d06b3` · `b4385fd` ·
`a939e78` · `5b871f0`

Step 27 and the hardening around it.

## Operator sign-in

**`ccee6c6` — let operators sign in at the station with their own account.**

Every stick authenticated as one shared station account, so every wipe record
named that account as the person who did it. On a legal document, that is not a
person.

Operators now sign in with their own credentials at the station, and the record
carries who actually did the work. Where a record *was* made under the shared
account, it is **labelled as such** (`19fc391`, `3a158a0`) rather than
attributed to somebody.

Three rules make the offline case correct:

- **`3916b71`** — never send a record under an operator who signed in *after*
  it was made.
- **`e7bf86e`** — an offline-queued record **waits for its own operator**.
- **`c434226`** — say *whose* sign-in a held record is waiting for, rather than
  "no connection", which sends the operator to fix the wrong thing.

## Hardening the kiosk's own HTTP service

The station runs a local web server. It had been written as if the only client
would be its own page.

**`4a05b12` — answer only the station's own page (Host, Origin, JSON).** Any
page in any browser on that machine, or anything else on the network, could
call the station's API — including the endpoints that erase drives.

**`f98189b` — the risky settings fail closed; the server is allow-listed.**
Settings that change where records go, or what gets erased, refuse rather than
guess when their input is not understood.

**`75efa7b` — kiosk browsers never save or fill an operator's password.** The
station's browser profile is built with the password manager off. Operators
type their own credentials on that screen, and the browser must not offer to
remember them on a machine that is handed to the next technician.

**`6f0eaf0` — sign the operator out when the API ends the session with a 403.**
Otherwise the station holds a session the server has already rejected, and
every action fails for a reason the operator cannot see.

**`45c5859` — stop a Wi-Fi name rewriting `audit.conf`, and stop running
`audit.conf` as root.** Two faults: a network name containing shell characters
could corrupt the configuration file, and the file was being *sourced* — which
executes it — as root. A configuration file is data, not a script.

**`b4385fd` — make `esc()` drop every control character, not just CR/LF/TAB.**
The escaping applied to firmware and registry strings before they reach a
record. Those values come from the customer's machine and are not under our
control.

## Refusing to guess a machine's identity

**`a939e78` — key a machine with no serial on its system UUID, not a new asset
per drive.** Machines with no readable serial were creating a new asset for
every drive wiped.

**`5b871f0` — refuse more shared firmware UUIDs as a machine key.** Some
manufacturers ship the *same* UUID on every unit of a model. Using one as an
identity merges unrelated machines into a single asset — worse than having no
key at all. A known-bad UUID is refused rather than trusted.

## Records the server refused

**`69a84fb` — show queued records the server refused instead of retrying in
silence.** The direct descendant of the July 11 fault where one bad reference
wedged the queue.

**`ebeb3aa` — do not blame queued records for a failed station sign-in.** The
banner reported a sign-in failure as a problem with the queue.

**`bc688ab`, `1e922f0`, `665f4ff`, `34b8be4`** — refuse a wipe before erasing
when no workflow is chosen; file a station wipe that names no lot rather than
refusing it outright; gate a restore on the workflow; and refuse a wipe or
restore from a page with a **stale workflow**. The last is subtle: a page open
since before the workflow changed would act on the old one.

**`da060af` — read the profile from its marker, and forget it when a capture
fails.** A failed re-capture left the *previous* machine's profile in place, so
a wipe started afterwards was filed under whichever machine was on the bench
last.

## What was deliberately not built

No credential storage on the stick. Operators sign in each session; nothing is
remembered.

## Open questions

Per-user scoping of station data remains deferred — it needs PowerSync sync
rules scoped to the station account.
