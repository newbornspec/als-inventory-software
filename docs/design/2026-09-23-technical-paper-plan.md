# Starting the technical paper

## Status

Plan, 23 September 2026. Not work that shipped — a working plan for the paper,
kept here because it is the thing the design records exist to feed.

## 1. Which paper to write first

You have material for at least three. Write **one**, and make it this one:

> **False absence: a defect class in systems that report on external state.**

Not "we built an ITAD audit platform". A system-description paper is read by
people who want to build the same system, which is nobody. A **defect-class**
paper is read by anyone whose software examines something it does not control —
medical devices, network monitors, security scanners, compliance tooling, CI
infrastructure. That is a large audience with the same bug and no name for it.

### The claim, in one sentence

> In software that reports on external state, the dominant defect class is the
> probe whose failure is indistinguishable from a negative result — and naming
> the class is not sufficient to prevent its recurrence.

The second half is what makes it publishable. Plenty of people have observed
the first half informally. **Nobody has the natural experiment you have:** the
class was named, in a commit message, on 2 September, and fixed six times at
once. Nineteen days later a systematic sweep found twenty-two more, most in the
two files that commit had itself edited.

That is a finding, not an anecdote.

## 2. What you already have

| Asset | Where | Strength |
| --- | --- | --- |
| 23 catalogued instances, dated, with commits | `2026-09-22-false-absence-sweep.md` | **Strong** — this is the paper's spine |
| 100% directional bias (23/23 towards the reassuring answer) | Same | **Strong** — quantified, striking |
| Recurrence after naming | `533a61a` → the September sweep | **Strongest single finding** |
| Detection-method comparison | The "Found by" column | Strong |
| A clean-engine / dirty-edges contrast | Same record | Counter-intuitive, quotable |
| 38 design records, 526 commits | `docs/design/` | Context and provenance |
| Two worked narratives | keypress-ownership, autopilot-research | Good for illustrative sections |

## 3. What is missing, and must be collected before writing

This is the difference between a blog post and a paper. Four fields per
instance, all recoverable from git:

1. **Latency** — commits (or days) between the defect being introduced and
   being detected. `git log -S` on the relevant line finds the introducing
   commit.
2. **User-visible?** — did it reach a screen, a report or a certificate?
3. **Was there a test that should have caught it?** — and if so, why didn't it?
   (Several fixtures modelled a command that cannot fail.)
4. **Inclusion criteria** — write down, before analysing, what counts as *one*
   instance. `d958b21` fixed five checks in one commit: is that one instance or
   five? Decide once, state it, apply it consistently.

Without (4) a reviewer will say the count is arbitrary, and they will be right.

## 4. Be honest about the threats to validity

Put these in the paper; do not wait to be asked.

- **n = 1 system.** One codebase, one domain.
- **Single observer.** The person cataloguing the defects is the person who
  wrote and fixed them. There is no independent classification.
- **Retrospective.** Instances were classified after the fact, knowing the
  conclusion.
- **No base rate.** You cannot say whether 23 in 82 days is high or low,
  because nobody has measured a comparable system.

Stating these plainly *strengthens* the paper. The recurrence finding survives
all four, because it is an observation about one codebase's own timeline and
does not depend on comparison.

## 5. Venue

| Venue | Length | Fit |
| --- | --- | --- |
| **IEEE Software** | ~4,000 words | **Best first target.** Practitioner-facing, takes industrial experience, respected |
| ICSE SEIP | 8–10 pp | Industrial track of the main SE conference. Deadline-driven |
| ACM Queue | Long-form | Practitioner, excellent reach, editorially led |
| arXiv preprint | Any | **Do this regardless**, first. Citable immediately, no gatekeeping |

Recommended sequence: **arXiv preprint → IEEE Software submission.** The
preprint costs nothing, establishes the date, and can be linked from anywhere.

## 6. Structure

1. **Introduction** — the BitLocker machine reported as having no operating
   system. One concrete case, 200 words. The reader must feel it before any
   abstraction.
2. **The class** — definition, and why it is asymmetric.
3. **Context** — the system, in two pages. Enough to make the instances legible
   and no more.
4. **Method** — how instances were found and classified. Inclusion criteria.
5. **Results** — the evidence table, the directional bias, the latency
   distribution, the detection-method comparison.
6. **The recurrence finding** — its own section. This is the paper.
7. **Why it survives testing** — the fixture argument: a fixture is written
   from the successful path, so no test constructs "probe broken AND subject
   dirty".
8. **The rule** — the three questions, and the two corollaries.
9. **Threats to validity.**
10. **Related work** — see below.

## 7. The one piece of homework

**Read the related work before writing section 2.** The class certainly
overlaps existing literature and you must position against it:

- **Error handling / exception swallowing** — Chen et al. on error-handling
  bugs in distributed systems.
- **Silent failures and fail-silent behaviour** — classical dependability
  literature (Laprie, Avižienis taxonomy of faults/errors/failures).
- **Sensor validation and fault detection** in control systems; the
  instrumentation literature already distinguishes "no signal" from "signal
  zero".
- **Alarm fatigue and false negatives** in medical device monitoring.
- **Null-vs-absent** in database and API design (the `NULL` semantics debate,
  and `Option`/`Maybe` types).

Your contribution is not that failures can be silent. It is: **in a specific,
common architectural position — the probe that reports on external state —
this defect has a consistent direction, survives conventional testing for a
structural reason, and recurs after being named.**

## 8. The first working session, concretely

1. **Write the 150-word abstract.** If you cannot, the claim is not yet clear.
   Do this before anything else.
2. **Build `paper/instances.csv`** — one row per instance, with the four new
   fields from section 3.
3. **Write the inclusion criteria** in one paragraph, and apply them to the
   grouped commits (`533a61a`, `d958b21`, `5ab21f1`).
4. **Recount.** The number will change. That is fine and expected; what matters
   is that it is now defensible.

Two or three hours. At the end you have a dataset, a claim, and a count you can
defend — which is the whole hard part.

## Open questions

- Does the paper name the business, or anonymise it? Naming it is more
  credible and commits you to the defects being public.
- Solo author, or bring in an academic co-author for the methodology? A
  co-author materially improves the odds at a refereed venue and costs you
  editorial control.
