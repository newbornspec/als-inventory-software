**Draft 1.**

---

## 16. Limitations and threats to validity

### 16.1 One site, one business, one engineer

Everything here comes from a single ITAD business, a single codebase, and a
single developer. The architecture is shaped by this business's actual
processes — bulk trade sales rather than an order book, grading rather than
repair — and §13 argues that fitting those processes closely was a virtue. The
same argument means the design may not transfer to an ITAD operation that works
differently.

The single-engineer fact cuts two ways in §12. It **strengthens** the
recurrence finding — the author who wrote the defects was the author who named
the class, so there is no question of the lesson failing to reach somebody. It
**weakens** any generalisation to teams, where the mechanisms of transmission
and forgetting are different and probably worse.

### 16.2 The defect catalogue classifies its own author's work

The 32 instances in §12 were identified, classified and counted by the person
who wrote them. There is **no second rater**, and no inter-rater agreement to
report. The inclusion criteria were fixed before the analysis and are published
so the judgement can be inspected, but a reader who suspects the boundary was
drawn to favour the result cannot presently be answered with anything except
the dataset itself.

Re-rating ten randomly selected instances with an independent rater would
address this, and is the single highest-value addition the work could receive.

Two narrower threats to the same catalogue:

- **It is a census, not a sample.** It reports every instance found in one
  codebase. The rates in §12 describe this system, and nothing licenses
  extrapolating them to software in general.
- **Provenance is imperfect.** The introducing commit was recovered by
  searching for a string the fix removed. Where that string post-dated the
  defect, the commit creating the enclosing function was used instead; four
  entries rest on that weaker method and are marked as such in the dataset.
- **Detection latency is an upper bound on time-to-detection, not a measure of
  exposure.** Station code does not reach a machine until the next USB sync, so
  a defect's presence in the repository is not the same as its presence on a
  bench.

### 16.3 What was never measured

**No production telemetry exists** (§15.2). There is no measured throughput, no
error rate in the field, and no before-and-after comparison against the manual
process the system replaced. Claims about the system's operational value rest
on it being in continued daily use, which is weak evidence and is presented as
such.

**The deletion argument is an argument.** §13.3 claims the three removals are
why the system stayed buildable. Nothing measures that. The counterfactual —
the same team carrying three unused modules through the September work — does
not exist and cannot be constructed.

**The remedy in §12.5 is unevaluated.** The observation window closes with the
sweep. Whether the sweep, the third-value tests and the corrected fixtures
actually reduce the rate of new instances is unknown, and on the evidence of
§12.4 the expectation should be modest.

### 16.4 Gaps in the system itself

| Gap | Status |
| --- | --- |
| The web application has no automated tests | Real; several defects found by manual passes would have been caught |
| Station tests are harnesses, never real drives | Deliberate trade; means hardware-level assumptions go untested (§15.3) |
| Hardware-hash capture before wipe (K3) | **Blocked** — needs a pre-installation environment and a bench session |
| Per-user data isolation beyond manager scoping | Deferred |
| Sales, customer and invoice tables | Residue of a removed module (§13.4) |

### 16.5 Two decisions that are the owner's, not ours

Both are recorded here rather than silently defaulted, because each determines
what a document the business issues is allowed to say:

1. **Should a machine whose drive is hidden behind a RAID controller be
   certifiable at all?** The system can report that it could not see the drive.
   Whether that machine may then be sold with a certificate is a commercial and
   legal judgement.
2. **Should a lock discovered after issue reach a certificate already in a
   buyer's hands?** The first-boot observation of §11.3 can establish a
   registration *after* the machine has been certified and sold. There is
   currently no mechanism for amending an issued certificate, and whether there
   should be is not an engineering question.

### 16.6 Scope of the knowability framework

§11's four tiers were derived from one vendor's device-management ecosystem.
K1, K2 and K3 are mechanical and should transfer. **K4 is the interesting tier
and has exactly one worked example.** Whether other classes of withheld state
behave the same way — in particular whether they can always be converted to an
observable event the way Autopilot's first boot can — is untested, and the
framework should be read as a proposal rather than a validated taxonomy.

## Drafting notes

- §16.2's admission is the most serious threat in the paper and is deliberately
  placed before the others. A reviewer will find it anyway.
- §16.5 duplicates §8.6's closing. §8.6 should keep one sentence and point
  here; check at assembly.
- If the owner resolves either decision in §16.5 before submission, move it to
  §8 and note the resolution date.
- §16.6 was added late. The paper is stronger for admitting K4 rests on n=1
  than for implying a taxonomy it has not earned.
