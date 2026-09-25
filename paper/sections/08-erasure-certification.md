**Draft 1.**

---

## 8. Layer 5: erasure and certification

This is the layer the business exists to produce. Everything else in the system
is, in the end, apparatus for making one document true: a certificate saying
that the data on a specific drive in a specific machine is gone.

### 8.1 A ladder, not a technique

Drives differ, so the engine holds a ladder of methods and descends it:

| Method | Applies to |
| --- | --- |
| Cryptographic erase | Self-encrypting drives — discard the key |
| Firmware secure erase / sanitize | SATA and NVMe, at the controller |
| Block erase | NVMe |
| Overwrite | The fallback when nothing above is available or accepted |

A method may be refused by the drive. When that happens the operator is told
**which method actually ran and why the faster one was declined**, and that
statement reaches the certificate. This is the earliest appearance of the rule
that now governs the whole document:

> **The certificate says what was actually done, not what was asked for.**

Every erase is followed by a **read-back**: the drive is read to confirm the
data is gone, rather than trusting the command's exit status.

### 8.2 Seven things that were wrong, and one of them was already on paper

The engine shipped in July was structurally sound and made claims it could not
support. A remediation programme in September — a 42-step plan across four
tracks, roughly 100 commits, the largest single body of work in the project —
fixed seven distinct failures. They are worth listing individually, because
each is a different way for a true-looking document to be false:

**1. TRIM was being certified as an erasure.** Issuing a TRIM marks blocks
unused; the data may remain readable. This one had already produced wrong
certificates, so the fix was not only to stop doing it but to **de-certify
records already issued** from earlier sticks. A defect that has reached a
customer is not fixed by preventing the next one.

**2. An unreadable drive "verified".** The read-back pass treated a drive it
could not read as having passed — the exact shape of §12's defect class, in the
most consequential place it could occur. Read-back now happens after *every*
erase, and "controller-confirmed" was dropped as a category entirely: the
controller reporting success is not evidence that it succeeded.

**3. The verdict was per machine, not per drive.** A machine with two drives,
one of which failed to wipe, was being called wiped. Each drive is now decided
on its own evidence, the machine's status follows from the per-drive verdicts,
and a certificate is **refused** when a sibling drive's wipe failed.

**4. Drives were identified by path or serial alone.** Paths move between
boots; serials are sometimes blank or duplicated. The engine now identifies a
drive by the combination of what it reports about itself, records each drive's
own identity and timings, and **refuses to act on the wrong drive**. The
failure mode being prevented is erasing a disk that was not the subject.

**5. NVMe namespaces were mishandled.** An NVMe drive can present several
namespaces. The engine first refused the second one, then learned to wipe every
namespace in turn, sanitize the correct controller first, and never issue a
partial format.

**6. Hidden areas were never checked.** SATA drives can carry host-protected
or device-configuration areas — regions hidden from the operating system that
an erase does not reach. These are now checked before wiping, by reading the
kernel's view of the drive's size, and **without making any permanent
configuration change to the customer's hardware**.

**7. The sanitize result was parsed as English.** The status was matched
against text strings that vary between tool versions. It is now read as
numbers.

The structure built in July — ladder, fallback reason, read-back, certificate —
was sound enough that all of this was a hardening rather than a rewrite. That
is worth recording in a paper about getting things wrong: the original design
was right and its *claims* were overconfident, and those are separable
failures.

### 8.3 Making the document tamper-evident

An erasure certificate is a PDF, and a PDF can be edited. Nothing stopped
somebody altering a serial number, a date, or a verdict on a document the
business had issued, and nothing let a buyer confirm that the copy in their
hand was the one that was issued.

Certificates are therefore **stored, signed and chained**: each entry is linked
to the one before it, so altering any entry breaks the chain from that point
forward. The ledger is tamper-evident rather than merely tamper-resistant —
it does not prevent an edit, it makes an edit detectable.

A buyer can check a certificate through a **public endpoint reached by a QR
code on the document**, which reports whether the certificate is genuine and
what it says. It is **off by default**: a public endpoint on a system holding
customer data should be an explicit decision, not something a deployment
inherits.

### 8.4 What making it public cost

Three separate pieces of work exist only because that endpoint is
unauthenticated, and they generalise to any public verification surface:

- **Bound the cost of a single check.** An unauthenticated endpoint that does
  real work is a denial-of-service surface.
- **Spend the budget only on certificates that exist.** A request for a
  non-existent certificate must be cheap, or the budget is consumed by
  enumeration attempts.
- **Never render a link that claims more than it can deliver.** The internal
  asset page could hang while checking the ledger and — worse — could display a
  verification link for a certificate that was not actually verifiable. A link
  labelled *verified* that leads nowhere is a false claim in exactly the sense
  this paper is about.

### 8.5 Keys

The signing key never leaves the server. Verification uses the public key; the
private key has never appeared in a log, an error message, or a conversation
about the system, and the discipline of not exposing it was treated as a
standing rule rather than a one-off precaution.

Keys are rotated, and a certificate signed with a retired key must still
verify. When a retired key cannot be read, the failure **names the entry at
fault** rather than failing the whole ledger — otherwise one unreadable key
turns every historical certificate into an unverifiable one.

### 8.6 What the certificate refuses to say

Three refusals define the document as much as its contents:

| It will not say | Because |
| --- | --- |
| That an unreadable drive was verified | Failing to read is not a pass (§12) |
| That a machine is wiped when one of its drives is not | The verdict is per drive (§8.2) |
| That the fastest method ran when it was refused | The document reports what happened (§8.1) |

Two questions remain open and belong to the business rather than to
engineering: whether a machine whose drive is hidden behind a RAID controller
should be certifiable at all, and whether a lock discovered *after* issue
should reach a certificate already in a buyer's hands. Both are recorded in
§16 rather than silently defaulted.

## Drafting notes

- The seven-failure list is the strongest evidence in the paper that the thesis
  is not retrospective decoration: each one is a claim the document made and
  could not support, fixed for that reason.
- Failure 1 (de-certifying issued certificates) is the only place in the
  project where a defect was known to have reached customers. Do not soften it.
- Failure 2 is also instance-level evidence in §12. Cross-check the wording.
- §8.6's two open questions are genuinely unanswered. If the owner decides
  either before submission, move it out of §16 and state the decision here.
- Consider whether §8.4 is too much detail for a systems paper. It stays for
  now because "we made it public and here is what that cost" is rarer in the
  literature than the design itself.
