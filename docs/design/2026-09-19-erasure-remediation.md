# The erasure remediation programme

## Status

Shipped, 19 September 2026. A 42-step plan, delivered in **two waves across
four tracks** (infra, engine, kiosk, api) and merged as
`f293def` · `f91a385` · `5d30aa2` · `40f9b52` · `88136eb` · `f7d989b` ·
`bfc41d2` · `efd5ec5` · `116021d` · `9696251`, closing at `c2ea936`.

Roughly 100 commits. The largest single body of work in the project.

## The problem

The wipe engine built on 15 July was structurally sound and made claims it
could not support. An erasure certificate is a legal document; several of the
statements on it were not true in edge cases, and the edge cases are common.

## The seven things that were wrong

**1. TRIM was being certified as a wipe** (`771bc40`, `19c0f35`, `40fac73`).
Issuing a TRIM to an SSD is not an erasure — it marks blocks unused and the
data may remain readable. Certificates already on file, and records from old
sticks, were also **de-certified** (`40fac73`): the wrong ones already issued
had to be corrected, not just the new ones prevented.

**2. An unreadable drive "verified".** The read-back pass treated a drive it
could not read as passing. `771bc40` stopped that; `39ff59d` made read-back
happen after **every** erase and dropped "controller-confirmed" as a category —
the controller saying it worked is not evidence that it did.

**3. The verdict was per machine, not per drive** (`5f7da58`, `6a97678`,
`c2ea936`). A machine with two drives where one wipe failed was being called
wiped. Now each drive is decided on its own evidence, and the machine's status
and its certificate follow from the per-drive verdicts. `a174959` refuses a
certificate when another drive's wipe failed alongside it.

**4. Drives were identified by serial or path alone** (`8e00a43`, `1a65373`,
`7d3ee5d`). Paths move between boots and serials are sometimes blank or
duplicated. The engine now tells drives apart by **what they report**, records
each drive's own identity and wipe times, and **refuses the wrong drive**.

**5. NVMe namespaces were mishandled** (`2999253`, `b170d5f`, `4d2add9`,
`35ca2d3`). An NVMe drive can present several namespaces. The engine first
refused the second namespace, then learned to wipe **every namespace in turn**,
to sanitize the right controller first, and never to issue a partial format.

**6. Hidden areas were never checked** (`cabf8a0`, `9f928c2`). SATA drives can
carry an HPA or DCO — regions hidden from the operating system that an erase
does not reach. Now checked before wiping, reading the **kernel's** size and
**never making a permanent AMA change** to the customer's drive.

**7. The sanitize result was read as English text** (`130e2fa`). The NVMe
sanitize status was matched against strings that vary between tool versions.
Read as numbers.

## The rules that came out of it

**A method that fell back says so** (`3f1a2cc`, `432ecab`). The certificate
records the method *requested*, the method *attempted*, and **why** it fell
back — plus the drive's bad-sector counts before and after.

**The date on a certificate is the station's own clock, and says how good that
clock was** (`f213c19`, `47d1046`). A station with a dead CMOS battery can be
years out; every record carries `wipedAtClock` = `network` or `unsynced`.

**A shared account is never printed as the person who wiped** (`3a158a0`,
`19fc391`). Records from a shared station account are labelled as such rather
than attributed to whoever the account is.

**An offline-queued record waits for its own operator** (`e7bf86e`, `3916b71`,
`c434226`). A record made by one operator must never be sent under another who
signed in afterwards.

**`3e35585` — stop waiving a real MBR or ext superblock that sits in random
data.** The verifier looked for filesystem signatures to prove data remained.
Random data occasionally contains those bytes by chance, so a tolerance was
added — and the tolerance was waiving *genuine* signatures. The fix
distinguishes a real structure from a coincidence by checking fields that
cannot be chance (an MBR whose four status bytes are all valid is not random).

## What was deliberately not built

**`d874ba8` — suspend-to-unfreeze is guarded and kept disabled.** Many drives
refuse a secure erase while "frozen", and suspending the machine unfreezes
them. It also risks not waking, on a customer's machine, mid-wipe. Implemented,
guarded, and **left off**.

**No AMA changes.** A permanent change to a drive's maximum address to reach a
hidden area is destructive in a way that outlives the audit.

**`840e824`, `75d3572` — read-only queries that size the damage already done.**
Before changing the rules, two queries were written to count how many existing
records the new rules would refuse. Knowing the blast radius before applying a
stricter standard.

## How it was proved

A dedicated test suite per concern — `test-wipe-verify.sh`,
`test-wipe-sanitize.sh`, `test-wipe-hidden.sh`, `test-wipe-identity.sh`,
`test-wipe-ladder.sh`, `test-wipe-unfreeze.sh`, `test-wipe-assess.sh`,
`test-wipe-namespaces.py`, `test-wipe-record.py`, `test-wipe-gate.py`,
`test-wipe-workflow.py`, `test-wipe-results.py` — plus `eff7e61`, which put
**every Audit Station tool test into CI**, and `9c1e987`, which made the kiosk
UI test unable to silently skip.

**No test harness ever targets `/dev/*`.** The wipe tests run against files.

A later independent audit of this path (during the false-absence sweep) found
**no instances** of the class in the erase-and-verify code. The defects were at
the edges, not in the engine.

## Open questions

None from the programme itself. The certificate's "Device lock" line remains a
wipe-time snapshot, which became a live question when the OOBE check shipped —
see `2026-09-23-autopilot-oobe-check.md`.
