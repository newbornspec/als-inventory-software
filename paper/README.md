# The paper

**False absence: a defect class in systems that report on external state**

Everything for the technical paper lives in this folder. Sections are written
as separate files and assembled into `PAPER.md`.

## Read this first

| File | What it is |
| --- | --- |
| **`PAPER.md`** | **The whole paper, assembled. Start here.** |
| `assemble.py` | Regenerates `PAPER.md` from the sections and counts words |

## The sections, in order

| File | Section | Prose words |
| --- | --- | --- |
| `abstract.md` | Abstract + the three required insights | 150 |
| `introduction.md` | 1. Introduction | 746 |
| `the-class.md` | 2. The class | 554 |
| `context.md` | 3. The system | 264 |
| `method.md` | 4. Method | 331 |
| `results.md` | 5. Results | 733 |
| `recurrence.md` | 6. The recurrence finding — **the main result** | 902 |
| `the-rule.md` | 7. What to do about it | 412 |
| `threats.md` | 8. Threats to validity | 374 |
| `related-work.md` | 9. Related work | 271 |

**4,587 words of prose and 7 tables.**

## The evidence

| File | What it is |
| --- | --- |
| `instances.csv` | The dataset. 32 rows, 18 fields, one row per call site |
| `inclusion-criteria.md` | What counts as an instance, written before the analysis |

Every numeric claim in the paper is recomputable from `instances.csv`. They
were all checked against it before each section was committed, and three were
wrong when checked.

Each section file ends with **drafting notes** — open questions, things to
verify before submission, and a record of what was corrected and why. Those are
excluded from `PAPER.md` and from the word counts.

## Where it can go: a decision you need to make

The draft is complete end to end. The venue is not settled, and the reason is
arithmetic.

**IEEE Software charges 250 words for every table or figure.** With 7 tables
that is 1,750 words on top of 4,587 of prose:

| | |
| --- | --- |
| Prose | 4,587 |
| 7 tables × 250 | 1,750 |
| **Charged total** | **6,337** |
| IEEE Software limit | 4,200 |
| **Over by** | **2,137** |

That is not a trim. Cutting 2,137 words — a third of the paper — would mean
dropping the results tables, the method, or the threats section. Any of those
would make it a weaker piece of work, and two of them would make it
unreviewable.

**Three options:**

1. **arXiv and/or Zenodo, as written.** No limit. Citable immediately. Zenodo
   needs no endorsement; arXiv now requires one from an established cs.SE
   author (policy changed 21 January 2026). *Recommended first step.*
2. **ICSE SEIP** — the industrial track. 8–10 pages, roughly 6,000–8,000
   words, which fits this without cutting. Refereed, deadline-driven.
3. **A separate short version for IEEE Software** — roughly 2,400 words of
   prose keeping only the §6.1 and §6.2 tables. Written *from* this draft
   rather than by cutting it, and only worth doing once the full version
   exists. It would be the recurrence finding alone.

The full version should exist first either way. A magazine cut made before the
long version is written loses the parts that make it defensible.

## Before any submission

- [ ] **Check every citation in §9 against the actual paper.** They are
      positioned from memory of the literature and at least one is likely to be
      imprecise. This is the one blocker.
- [ ] Search for a prior naming of this exact class. If one exists, the framing
      changes from *naming* to *measuring* and §6 becomes the sole
      contribution.
- [ ] Register ORCID, then Zenodo.
- [ ] Re-run `python paper/assemble.py` and re-verify every figure against
      `instances.csv`.
- [ ] Decide whether the business is named or anonymised.
- [ ] If a second rater can be found, re-rate ten random instances and report
      the agreement. That single addition answers the most serious threat in
      §8.
