# Erasure certificates, and the first wipe engine

## Status

Shipped, 15 July 2026. `fab169b` · `c42ac64` · `15802bc` · `07ac7be` ·
`b9c086b` · `870e5fb` · `19f1519` · `c74a2c3` · `df07fd3` · `8dc7af9` ·
`9cebd35`

Substantially rebuilt in September — see
`2026-09-19-erasure-remediation.md`.

## The problem

An ITAD business sells second-hand machines that held somebody's data. The
buyer needs a document saying the data is gone, and the seller needs that
document to be true. This is the legally consequential output of the entire
system.

## What was built

**Certificate of Data Erasure** as a PDF, per device (`fab169b`) and per lot
(`c42ac64`).

**A wipe engine** in the audit tool, opt-in (`15802bc`), with a **verification
pass after erase** (`07ac7be`) — reading the drive back rather than trusting
the command's exit status.

**A method ladder** rather than one technique, because drives differ:

- ATA secure erase and cryptographic erase, NIST Purge level (`19f1519`)
- `nvme sanitize` for crypto and block erase on NVMe (`df07fd3`)
- overwrite as the fallback

**`c74a2c3` — surface why NVMe firmware erase falls back.** When the fastest
method is refused by the drive, the operator is told which method actually ran
and why. This is the first appearance of what became a governing rule of the
certificate: *the document says what was actually done, not what was asked
for.*

**SMART health per drive** (`b9c086b`, `870e5fb`), with a health percentage and
SATA SSD coverage.

## Two small things that matter more than they look

**`8dc7af9` — hold the wipe result on screen until Enter.** An unattended
machine that finishes and reboots shows the operator nothing. The result has to
survive until a human has read it.

**`9cebd35` — exit 0 on success.** The tool was returning non-zero on success,
which meant anything automating it saw every good run as a failure.

## Why it matters

Everything in the September remediation programme exists because this version,
while broadly right in structure, made claims it could not fully support:
verification that did not verify unreadable drives, TRIM treated as a wipe,
certificates issued without naming the drive, and a per-machine verdict where a
per-drive one was needed.

The structure here — ladder, fallback reason, read-back, certificate — was
sound enough that the remediation was a hardening rather than a rewrite.

## What was deliberately not built

No degaussing or physical-destruction workflow. Out of scope.

## Open questions

All superseded by the 42-step remediation of 19 September, which is where the
per-drive verdict, signed certificates, hidden-area checks and the honest
sanitisation level arrived.
