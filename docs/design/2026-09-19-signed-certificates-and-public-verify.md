# Signed, chained certificates, and public verification

## Status

Shipped, 19 September 2026. `b9b1b5d` · `48c0bad` · `85acd96` · `0906331` ·
`f9a90a9` · `73ff92f` · `4897b83` · `59c9b5c` · `5f4134c` · `5c0f1a8` ·
`6261daa` · `df3a33e`

Steps 29 and 30 of the remediation plan.

## The problem

An erasure certificate is a PDF. A PDF can be edited. Nothing stopped somebody
altering a serial number, a date or a verdict on a document the business had
issued — and nothing let a buyer check that the one they were holding was the
one that was issued.

## What was built

**`b9b1b5d` — store, sign and chain certificates once issued.**

Each certificate is stored, **signed**, and **chained** to the one before it,
so the ledger is tamper-evident: altering an entry breaks the chain from that
point forward.

**`48c0bad` — a public certificate check with a QR code, off by default.**

A buyer scans the code and is told whether that certificate is genuine and what
it says. **Off by default** because it is a public endpoint on a system holding
customer data, and it should be a decision rather than a default.

## Guarding a public endpoint

Three commits, all about it being public:

- **`f9a90a9` — bound what one public certificate check costs.** An
  unauthenticated endpoint that does real work is a denial-of-service surface.
- **`73ff92f` — spend the verify budget only on certificates that exist.** A
  request for a non-existent certificate should be cheap; otherwise the budget
  is spent on enumeration attempts.
- **`4897b83` — give the asset page's certificate check a time limit, and no
  false link.** The internal page that checks the ledger could hang, and worse,
  could render a verification link for a certificate that was not verifiable —
  a link that says "verified" and leads nowhere.

## Key handling

**`59c9b5c` — name the bad entry when a retired certificate key cannot be
read.** Keys are rotated and retired; a certificate signed with a retired key
must still verify. When a key cannot be read, the failure names *which* entry
is at fault instead of failing the whole ledger.

**The signing key is never exposed.** The public key is what verification uses;
the private key does not leave the server and has never appeared in a log, an
error message or a conversation.

## Honesty on the document itself

**`5f4134c` — say on the lot certificate that it is not signed, once signing is
on.** Turning signing on for device certificates created a new false
impression: a lot certificate that is *not* signed sits next to ones that are,
and a reader reasonably assumes the same guarantee. So the unsigned one says so.

**`5c0f1a8` — print the level, limitations, fallback reason and lock status.**
The certificate states what was actually achieved: the NIST sanitisation level,
any limitations recorded, why a method fell back, and the device's lock status.

**`6261daa` — scope the lot certificate's claim, mark locks, and date rows by
the wipe.** A lot certificate covers devices with different outcomes, so its
claim is scoped to what it can support rather than asserted over the whole lot.

**`0906331` — issue the signed certificate when a wipe is recorded by hand**,
and **`df3a33e` — label hand-recorded wipes.** A wipe typed into the web app
after using a third-party tool is a legitimate record and **not a verified
one**. Both are certified; the document says which it is.

**`85acd96` — keep one certificate when a stick re-sends the same wipe.** An
offline queue that retries must not mint a second certificate for one erasure.

## Why it matters

This is the point where the system's output stops being a report and becomes
**evidence**. Everything about how it is worded, guarded and bounded follows
from that.

## What was deliberately not built

No blockchain, no external timestamping authority. A signed, chained internal
ledger with a public check is proportionate to the claim being made.

## Open questions

The public check remains off by default. Turning it on is an owner decision.
