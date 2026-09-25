**Draft 1.**

---

## 11. The knowability framework

Building the inspection layer forced a question that turned out to be more
general than the system: **what can a computer that is not running be made to
tell you about itself, and what can it not?**

The answer is not a single line between possible and impossible. It is four
levels, and the distinction between them is operational — it determines whether
a claim can be measured, inferred, recovered only at a moment that has already
passed, or not obtained at all.

### 11.1 Four tiers

| Tier | The claim is… | Example from this system | Costs |
| --- | --- | --- | --- |
| **K1** | **Measured.** The hardware reports it on request | Processor, memory, SMART attributes, TPM presence | A probe |
| **K2** | **Recovered.** The absent OS left an artefact behind | Domain join, encryption state, installed Windows, event logs | A parser, and knowing where to look |
| **K3** | **Perishable.** Obtainable only before an earlier step destroyed it | The device hardware hash, available before the wipe | Process change, not code |
| **K4** | **Withheld.** The answer lives with a third party, behind their authentication | Autopilot registration | Not obtainable. Full stop |

K1 and K2 are engineering. K3 is a **process** problem wearing an engineering
costume — no amount of code recovers something that has been overwritten, and
the fix is always to capture it earlier. K4 is neither: it is a boundary, and
the only correct engineering response is to report the question as unanswered.

The practical value of the framework is that it tells you **which kind of
effort will work**. Time spent writing a cleverer probe for a K3 fact is wasted;
time spent on a K4 fact is worse than wasted, because any answer it produces is
a guess wearing the costume of a measurement.

### 11.2 The worked example

Microsoft Autopilot is a provisioning service. A device registered to an
organisation will, at its first boot after a reset, contact Microsoft, discover
it is claimed, and enrol itself into that organisation — potentially in
somebody else's hands.

For a refurbisher this is the worst commercial failure available: a machine is
bought, audited, wiped, refurbished, sold, and at the buyer's first boot it is
claimed by an organisation nobody knew about. The money is already spent.

So the question *is this machine Autopilot-registered?* is the single most
valuable thing the system could answer. It is also K4.

**The registration is a row in Microsoft's cloud**, keyed to the device's
hardware hash. It is not on the disk. Wiping does not touch it. Reinstalling
Windows does not touch it. The device learns about it only by asking, at first
boot, over a network — a sequence that ends in an authenticated request for the
device's provisioning profile, returning either a profile or a
not-registered error.

There is no public interface into that final step for anyone except the tenant
that owns the device. The engineer who built Autopilot at Microsoft has
documented the flow publicly and described the ability to check a device's
status as something that **"would be nice to be able to check"** — that is,
as a thing that would be useful rather than a thing that exists.

When the person best placed to know describes a capability as desirable rather
than available, that is as close to a definitive answer as this kind of
question gets.

### 11.3 What was built instead

Rather than guess, the system was given three of the four tiers and told to be
explicit about which one produced each answer:

| | What it does | Answers a wiped disk? |
| --- | --- | --- |
| **Tier 1 — offline artefacts** | Reads the Autopilot traces still present on the mounted volume: the enrolment profile, the diagnostic entries, the event log the OS wrote | **No.** Only if the disk still holds them |
| **Tier 2 — capture at intake** | Record the hardware hash *before* wiping, so the machine can be checked against a tenant later | **No** — it makes the later check possible |
| **Tier 3 — observe first boot** | Record what the machine's own first-boot setup screen actually said | **Yes, definitively** |
| **Tier 4 — reimplement the query** | Perform the device's authenticated request independently | Yes, until Microsoft changes it |

**Tier 3 is the only one that yields certainty**, and it does so by abandoning
the attempt to deduce the answer and instead observing the event where the
machine itself finds out. The machine will tell you it is claimed at the moment
it discovers it, and a technician can record what appeared on screen. It is not
elegant. It is evidence.

**Tier 2 is blocked, and the reason is instructive.** The hardware hash is the
only identifier Microsoft will act on, and the station currently wipes it away
without recording it. It cannot be read from Linux: it comes from a Windows
management interface that requires Windows to be running. The established route
without the installed OS is a pre-installation environment, which means adding
a Windows PE image to the stick, the vendor toolkit, and a real machine to
prove it on. **It is blocked rather than skipped**, because writing it blind
would produce something nobody could verify — and an unverified hash capture is
worse than none, since it would be trusted.

One honesty point belongs in the record if Tier 2 is ever built: a hash
captured in a pre-installation environment is **not byte-identical** to one
captured from the full operating system, because several components are
missing. It is close enough for the tooling people use daily, and the record
must say which kind it holds.

**Tier 4 was recommended against**, and the recommendation is a judgement
rather than a technical impossibility. Reimplementing an undocumented
authentication sequence would probably work, for a while. But the output of
this system is a legal document, and a certificate whose most valuable claim
rests on an undocumented protocol that a third party may change without notice
is a liability dressed as a feature. The failure mode is not that it stops
working — it is that it keeps *appearing* to work while returning something
that no longer means what it used to.

### 11.4 The general form

Strip out the vendor and the framework applies to any system that reports on
state it does not own:

1. **Classify every claim by tier before implementing the probe.** The tier
   determines whether code, process change, or nothing will produce the answer.
2. **A K3 fact needs a process change, not a better probe.** If a fact is
   destroyed by a step in your own pipeline, the fix is upstream of that step.
3. **A K4 fact must be reported as unanswered.** Not "no evidence found",
   which a reader will take as "not registered" — but an explicit statement
   that this question has no offline answer, with the reason.
4. **The tier must reach the record.** It is not enough to know internally that
   a finding was inferred rather than measured; the person reading the document
   has to be able to tell.

Point 3 is where this framework and §12's defect class meet. A K4 question
answered with the *absence* of evidence is a false absence with extra steps —
and it is the most dangerous kind, because the probe genuinely ran, genuinely
found nothing, and genuinely could never have found anything.

## Drafting notes

- The Autopilot request sequence is described rather than reproduced. The exact
  endpoints are in `docs/design/2026-09-22-autopilot-research.md`; putting them
  in a paper dates it and invites a reviewer to test an undocumented flow.
- The quoted fragment is short and attributed by role. If the paper is
  submitted, cite the original post properly in §18 — this is one of the
  citations §18's notes flag as needing checking against the source.
- §11.4 is the most portable thing in the paper. If a short version is ever
  written for a magazine, it is §11.4 plus §12's recurrence result.
- Tier 2's blocked status is current as of 24 September 2026. If it is built,
  this section changes and §16 loses one limitation.
