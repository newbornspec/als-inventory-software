# Account safety, golden images, and splitting the grade

## Status

Shipped, 8–18 September 2026. `a78d3a8` · `5d4c78f` · `5cb869f` · `d66a1d7` ·
`e756d5c` · `79386be` · `b54318a` · `a2605b7` · `0d6e9a3` · `95ed17c` ·
`7728c8a` · `5d63bc4`

## Disable a user, do not delete them

**`a78d3a8` — admin can disable a user account instead of deleting it.**
**`5d4c78f` — admin can reset another user's password.**

Deleting a user destroys the audit trail. Every audit, wipe record and
certificate carries who performed it, and a deleted user turns all of that into
an orphaned reference — on exactly the records that most need to name a person.
So an account is **disabled**, never removed.

**The constraint that governs any such feature: JWTs cannot be revoked.** A
signed token stays valid until it expires, so disabling an account does not
end a session that is already running. Four hooks are needed for a disable or
reset to mean anything: the login path, the token-refresh path, the
permission check on each request, and the client's handling of the resulting
401/403. A feature that only flips a database flag has not disabled anybody.

Passwords are reset by an admin through the app. **Nothing in this system
generates, prints or logs a password**, and none is ever handled outside the
account owner's own control.

## Golden images and restore

**`5cb869f` — an operator guide for creating a Windows golden image.**
**`d66a1d7` — bake clonezilla in, so the stick can actually restore an image.**

The station had a restore workflow and no restore tool: the operator was
expected to install clonezilla, which the live session forgets at reboot. The
same amnesia problem the layer exists to solve, met in a different place.

## Splitting the grade

**`e756d5c` — split the grade in two, add comments, drop the mandatory gate.**
**`79386be` — surface the grades and comment on the device page and the label.**

One grade was carrying two unrelated judgements: **cosmetic** condition and
**screen** condition. A laptop can be immaculate with a scratched panel, or
battered with a perfect screen, and one letter cannot say so.

Dropping the mandatory gate matters too: forcing a grade before an audit could
be filed produced guessed grades, which is worse than an absent one.

## Boot time, measured rather than assumed

**`95ed17c` — measure the drive properly: the boot is I/O-bound at 34 MB/s.**

Optimisation had been aimed at what the boot appeared to be doing. Measuring
the drive showed the constraint was raw read throughput from the USB stick —
which redirected the work entirely, towards making the layer *smaller* and
reading *less* (lz4 compression, a pre-built Firefox profile) rather than
starting things sooner.

`a2605b7` stripped the Ubuntu wording and cut 12 seconds of dead time.
`52c64e4` — *ask the machine why the shutdown splash is Ubuntu's* — is the same
instinct: measure the thing rather than theorise about it.

## Two safety corrections

**`5d63bc4` — never wipe the boot drive, whatever it reports itself as.** The
station runs from a USB stick, and a stick that misreports its transport could
be selected as a wipe target. The station would erase itself mid-audit,
destroying the queued records on it.

**`0d6e9a3` — back up only the layer we can actually break.** Backing up more
than that made the backup slow enough to be skipped.

**`b54318a` — elevate the write, not just the mount, when saving to the boot
stick.** The mount was elevated and the write was not, so saving to the stick
failed in a way that looked like a full or read-only disk.

## What was deliberately not built

No self-service password reset by email. Email is not configured for this
deployment, and a reset path that depends on an unconfigured channel is a
lockout waiting to happen.

## Open questions

None outstanding.
