# Technical design records

One dated document per piece of work, written when the work is done, kept in
this repository. The purpose is a paper trail an engineer — or a technical
paper — can be written from later, without having to reconstruct the reasoning
from commit messages and memory.

## The convention

    docs/design/YYYY-MM-DD-<short-slug>.md

The date is the date the work shipped. A slug is two to five words, lower case,
hyphenated. One document per coherent change, not one per commit: a change that
took four commits gets one record, and its commits are listed inside it.

## What every record contains

The headings are fixed, because the value of these documents is that they can
be read against each other.

| Section | What goes in it |
| --- | --- |
| **Status** | Shipped / partial / blocked, the date, and the commit hashes |
| **The problem** | What was wrong, and how it was found. Name the machine or the report if it came from the bench. |
| **Why it matters** | What the defect cost, or would have cost, in the real business |
| **What was built** | The mechanism, concretely enough to re-derive it |
| **What was deliberately NOT built** | And why. This is often the most valuable section. |
| **How it was proved** | Tests, counts, what ran where. Anything unverified is named as unverified. |
| **Open questions** | Decisions left to the owner, and anything still unproven on real hardware |

## Rules

1. **Honesty over tidiness.** A record that says "this was never tested on
   hardware" is worth more than one that implies it was. Where a fix was found
   by accident, say so; where a test passed for the wrong reason, say that too.
2. **No record is written before the work is done.** These are records of what
   happened, not plans. Plans that never shipped belong in the Open questions
   of the record that supersedes them.
3. **The reasoning, not just the outcome.** Anyone can read the diff. What they
   cannot recover is why one approach was chosen over another that looked
   equally good at the time.
4. **Name the failure modes.** Especially the ones that survived review.

## Index

Newest first.

| Date | Record | What it covers |
| --- | --- | --- |
| 2026-09-23 | [autopilot-oobe-check.md](2026-09-23-autopilot-oobe-check.md) | The first-boot OOBE check: the only Autopilot answer that is not inference |
| 2026-09-23 | [event-log-reader-on-stick.md](2026-09-23-event-log-reader-on-stick.md) | Shipping a package by file copy instead of a squashfs rebuild |
| 2026-09-22 | [autopilot-offline-evidence.md](2026-09-22-autopilot-offline-evidence.md) | Reading the Autopilot artefacts already on the mounted volume |
| 2026-09-22 | [autopilot-research.md](2026-09-22-autopilot-research.md) | What is and is not knowable about Autopilot registration, and the four tiers |
| 2026-09-22 | [keypress-ownership.md](2026-09-22-keypress-ownership.md) | Three layers own a keypress; only one offers software a veto |
| 2026-09-22 | [false-absence-sweep.md](2026-09-22-false-absence-sweep.md) | The recurring bug class, its evidence table, and the rule that closes it |
