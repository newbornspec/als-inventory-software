# Technical paper: complete draft

## Status

**Draft complete end to end. Not submitted, and no venue chosen.**
24 September 2026.

Commits: `3ea5e06`, `5c83bd6`, `79d46d5`, `4d9f292`, `8a50c2c`, `3ac9091`,
`e6eb3ed`. Everything lives in `paper/`.

## The problem

The false-absence sweep (see `2026-09-22-false-absence-sweep.md`) produced a
result that is worth reporting outside this business, but the evidence for it
existed only as commit messages, one design record, and memory. None of that is
citable, and none of it survives the moment the author stops remembering it.

A second problem, discovered while writing: the sweep's own catalogue had been
counted by *defect* rather than by *call site*, and the two counts differ.

## Why it matters

The claim the paper makes is uncomfortable and therefore has to be airtight:
that naming a defect class, documenting it in the code, and defending it with
tests **did not stop the same author writing eight fresh instances of it in the
same codebase within three weeks**. A reviewer will attack that. If any figure
supporting it is unrecomputable, the whole thing goes.

## What was built

`paper/` — 15 files.

| File | What it is |
| --- | --- |
| `PAPER.md` | The assembled paper. Generated, not edited. |
| `assemble.py` | Rebuilds `PAPER.md`; counts prose and tables separately |
| 10 section files | One per section, each ending in **drafting notes** |
| `instances.csv` | The dataset: 32 rows, 19 fields, one row per call site |
| `inclusion-criteria.md` | What counts as an instance, fixed before analysis |
| `README.md` | Orientation, the venue arithmetic, the pre-submission list |

Nine sections, **4,587 words of prose and 7 tables**. The main result is §6,
the recurrence finding, which splits what had been one claim into three
separately-evidenced ones: 6 fixed by the naming commit, 18 introduced before
it and found later (a failure of **search**), and 8 introduced after it (a
failure of **prevention** — the actual finding).

The drafting notes are part of the deliverable, not scaffolding. They record
what was corrected and why, and they are excluded from `PAPER.md` and from the
word counts.

## What was deliberately NOT built

**The paper was not cut to fit IEEE Software.** That venue charges 250 words
per table; 7 tables plus 4,587 words of prose is 6,337 against a 4,200 limit.
Closing a 2,137-word gap means dropping the results tables, the method, or the
threats section. Two of those make it unreviewable. The full version stands and
a short version can be written *from* it later — never the other way round.
Only 610 words of genuine duplication were removed.

**No static-analysis tool.** §4.1 says plainly that the sweep was manual and
that automatability is untested. Without that sentence a reviewer assumes a
detector exists and asks for its precision and recall.

**No claim that the remedy worked.** §7.4 and §6.4 both close by saying the
observation window ends with the sweep. The three changes made afterwards are
reported as a response, not a result.

**The false-presence counter-example was excluded from the 32** — a binary
registry value reported as the literal domain `hex` — but is named in §5.1.
Including it would have flattered the direction statistic; hiding it would have
been worse.

## How it was proved

Every numeric claim was recomputed from `instances.csv` immediately before the
section that carried it was committed. **Three were wrong when checked**, and
each is recorded in the relevant drafting notes rather than quietly fixed:

- the recurrence count, written as "twenty-two more", was 26;
- "six of the eight" were introduced in the two-day burst — it was all eight;
- the abstract's word count, asserted three times before it was measured.

A fourth was a counting bug, not a claim: the word counter read a section of
~1,000 words as 152, because markdown table separators are also `---`.

Commit ordering in §6 was **verified, not assumed**:
`git merge-base --is-ancestor a61f70b 533a61a`. The ten same-day instances
genuinely pre-date the naming commit.

## Open questions

1. **Venue.** Three options with the arithmetic in `paper/README.md`: arXiv
   and/or Zenodo as written (recommended first; Zenodo needs no endorsement,
   arXiv now does), ICSE SEIP (6–8k words, fits), or a separate ~2,400-word
   IEEE Software version. Owner's call.
2. **The §9 citations are the one hard blocker.** They are positioned from
   memory of the literature and at least one is likely imprecise. They must be
   checked against the actual papers before anything is submitted.
3. **Has this class been named before?** If it has, the contribution narrows
   from *naming* to *measuring*, and §6 stands alone.
4. Whether the business is named or anonymised.
5. A second rater on ten random instances would answer the most serious threat
   in §8. None available so far.
6. **The recount.** The sweep record of 22 September says twenty-three defects;
   the paper says 32 call sites across 15 fix commits. Same catalogue, counted
   per call site rather than per fix. Both records now say so.
