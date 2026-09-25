**Draft 1. Positioning only. Every citation in this section is flagged for
verification against the source before submission — see the notes.**

---

## 18. Related work

This work sits at the intersection of four literatures, and is not squarely
inside any of them. That is the honest description of a systems paper about an
industrial problem: the components are well studied, the combination is not.

### 18.1 Media sanitisation and asset disposition

The technical basis for erasure is standardised. NIST's media-sanitization
guidance establishes the distinction between clearing, purging and destroying
media, and per-medium expectations for each — the framework §8's method ladder
implements. Industry certification schemes for asset disposition specify process
and audit requirements for refurbishers.

What that literature does not address, and what §8 reports, is the **software
engineering** of producing a certificate that is true: the per-drive verdict,
the read-back that must not treat an unreadable drive as verified, the hidden
areas an erase does not reach, and the case where a certificate already issued
turns out to be wrong. Standards specify what must be achieved. They do not
specify how a program that cannot read a drive should describe what it did.

### 18.2 Offline-first and local-first systems

The architecture of §5 — local database, background reconciliation, eventual
convergence — is the local-first pattern, and the literature on it is concerned
mainly with data convergence and user data ownership. Our contribution to that
discussion is narrow and operational: in a system where the client's writes are
**evidence**, the queue's failure modes matter more than its merge semantics,
and three of the four faults we hit in the first week were failures to *report*
rather than failures to converge.

### 18.3 Dependability and error handling

The fault / error / failure taxonomy gives the vocabulary for silent failure and
for a **fail-silent** component, which stops rather than emitting a wrong
result. The class in §12 is the complement: the component neither stops nor
signals, and emits a result that is wrong in a consistent direction.

Empirical studies of error handling in distributed systems establish that
error-handling code is disproportionately defective and under-tested. §12 is
narrower and orthogonal: we characterise what the erroneous handler *produces*,
and show that in a reporting system its output has a direction — always towards
the reassuring answer.

Two adjacent traditions are worth naming because both already solved a version
of this problem. **Instrumentation and control practice** distinguishes "no
signal" from "signal reads zero" and invests in validity flags to keep them
apart; that discipline has not transferred to general-purpose software that
probes an environment. And **type systems and database theory** have long
separated *absent* from *unknown*. §12 treats that distinction as the remedy
rather than the subject, and contributes evidence that knowing about it is not
sufficient to apply it.

### 18.4 Alarm design, inverted

Work on alarm fatigue in clinical monitoring documents the cost of false
positives, and the design responses to them. The class described here is the
mirror image: a failure mode that generates **no alarms at all**, and is
therefore invisible to every process built to respond to them. We are not aware
of a literature on the inverse problem — systems whose failures are silent
because their failure value is indistinguishable from good news — and would
welcome being told one exists.

### 18.5 What we did not find

We searched for a prior naming of the defect class in §12 and did not find one,
but that search is not exhaustive and its result is provisional. **If a prior
naming exists, this paper's framing changes**: the contribution narrows from
naming and measuring to measuring alone, and §12.4's recurrence result becomes
the sole novel finding. We would rather state that conditionally than discover
it in review.

We also found no prior treatment of what §11 calls knowability tiers as an
explicit engineering framework, though the underlying distinctions are
commonplace in practice. §16.6 states plainly that the tier which makes the
framework interesting rests on a single worked example.

## Drafting notes

- **This section must not be submitted as drafted.** The citations are
  positioned from knowledge of these literatures, not from the sources in hand,
  and at least one attribution is likely imprecise. Every claim about what a
  specific work says needs checking against that work.
- Specific items to verify: the NIST sanitization guidance's revision and its
  exact clear/purge/destroy definitions; the correct citation and claims of the
  dependability taxonomy; the specific empirical error-handling study intended
  in §18.3 and what it actually measured; the local-first citation; whether the
  alarm-fatigue literature contains a treatment of the inverse case.
- The certification schemes in §18.1 are referred to generically on purpose
  until the right ones for this business's jurisdiction are confirmed.
- §18.5 is doing real work: it makes the framing conditional and honest. Keep
  it even if the search is later completed, converting it to a statement of
  what was searched and found.
- Reference budget: this section implies 8–12 citations. Leave room for the
  system's own published artefacts (the dataset, the design records).
