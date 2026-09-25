# The paper

**Proving what a second-hand computer is: an evidence-first architecture for IT
asset disposition**

A complete technical paper on the whole project — every layer, what was
achieved, what was rejected, and what is still unproven. 78 days, 535 commits,
~101,000 lines.

## Read this first

| File | What it is |
| --- | --- |
| **`PAPER.md`** | **The whole paper, assembled. Start here.** |
| `OUTLINE.md` | The structure and the rules this draft was written to |
| `assemble.py` | Regenerates `PAPER.md` and counts prose and tables |

`sections/` holds one file per section — edit those, never `PAPER.md`. Each
section file ends with **drafting notes**: open questions, things to verify, and
a record of what was corrected and why. Those are excluded from `PAPER.md` and
from the word counts.

## The nineteen sections

| Part | § | Section | Words |
| --- | --- | --- | --- |
| | — | Abstract | 324 |
| **I. The problem** | 1 | Introduction | 843 |
| | 2 | Requirements and constraints | 670 |
| | 3 | System overview | 683 |
| **II. The layers** | 4 | The inventory model | 814 |
| | 5 | Offline-first capture | 904 |
| | 6 | The audit station | 1,113 |
| | 7 | Deep inspection | 1,062 |
| | 8 | Erasure and certification | 1,084 |
| | 9 | Functional testing | 671 |
| | 10 | The back office | 865 |
| **III. What it taught** | 11 | The knowability framework | 1,011 |
| | 12 | Evidence integrity: the false absence | 1,066 |
| | 13 | The discipline of deletion | 833 |
| | 14 | Engineering practice | 962 |
| **IV. Closing** | 15 | Results | 403 |
| | 16 | Limitations and threats | 722 |
| | 17 | Lessons | 971 |
| | 18 | Related work | 648 |
| | 19 | Conclusion | 529 |

**16,178 words of prose, 29 tables and figures.** Regenerate the figures with
`python paper/assemble.py` — do not hand-edit them into this file.

## The three findings

1. **Knowability tiers** (§11) — claims about external state are measured,
   recovered from an artefact, perishable, or withheld by a third party, and the
   tier decides whether code, a process change, or nothing will produce an
   answer. The most valuable question in this domain sits in the fourth tier.
2. **The false absence** (§12) — a failed observation reported as a confirmed
   negative. 32 call sites, all 32 failing towards the reassuring answer, 18 on
   code paths whose existing tests caught none of them.
3. **Naming a defect class is not a control** (§12.4) — the same author wrote
   eight fresh instances within three weeks of naming it, documenting it in the
   code, and adding tests worth a third of the diff.

## The evidence

| | |
| --- | --- |
| `evidence/instances.csv` | The defect dataset: 32 rows, 19 fields, one per call site |
| `evidence/inclusion-criteria.md` | What counts as an instance, fixed before the analysis |
| `../docs/design/` | 40 dated design records. The paper is written from these |

Every figure in the paper is recomputable from the repository or the dataset.

## `archive/` — the earlier draft

The first attempt made the false-absence defect class the entire subject. That
was the most publishable single claim, not the work. It is kept intact because
it holds the full treatment of §12 — the method, the inclusion criteria, the
latency distribution, the per-dataset threats — at about 3,700 words, of which
§12 is a 1,300-word compression.

It should be offered as a **companion artefact**, not folded back in.

## Venue

Not decided, and the earlier arithmetic no longer applies: at ~16,000 words this
is a systems paper, so IEEE Software's 4,200-word limit is simply out of scope
and is dropped.

| Option | Fit |
| --- | --- |
| **arXiv cs.SE and/or Zenodo** | No limit, citable immediately. Zenodo needs no endorsement; arXiv now requires one for new submitters. *Recommended first.* |
| **ICSE SEIP / ESEM industry track** | Refereed, deadline-driven, roughly 6,000–8,000 words — would need cutting, most likely Part II |
| **A short version, later** | §11.4 plus §12.4 is a ~2,400-word article. Write it *from* this, never by hacking this down |

## Before any submission

- [ ] **Verify every citation in §18 against the source.** They are positioned
      from knowledge of those literatures, not from the papers in hand. This is
      the one hard blocker. §18's notes list exactly what to check.
- [ ] Complete the search for a prior naming of the false-absence class. §18.5
      states the framing conditionally for this reason.
- [ ] Work through the per-section drafting notes; several name a specific
      cross-check ("check §17's thesis matches §1.1 word for word").
- [ ] Verify §15.3's evidence table against each design record's "How it was
      proved" heading.
- [ ] Decide whether the business is named or anonymised.
- [ ] If a second rater can be found, re-rate ten random instances from
      `evidence/instances.csv`. That single addition answers §16.2, the most
      serious threat in the paper.
- [ ] Re-run `python paper/assemble.py` and re-verify every figure.
