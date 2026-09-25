**Draft 1.**

---

## 1. Introduction

When an organisation replaces its computers, the old ones do not stop existing.
They go to an IT asset disposition (ITAD) company, which has two obligations
that pull in opposite directions. It must **destroy the data** those machines
hold, and prove it. And it must **describe each machine accurately** to whoever
buys it next, which means examining it closely enough to say what it is.

Both obligations produce documents. An erasure certificate is a legal
instrument: the organisation that owned the data remains accountable for it
under data-protection law, and the certificate is the evidence it relies on. A
specification is a commercial one: a buyer paying for 16 GB of memory and a
healthy drive is entitled to get them.

Both documents are **claims about a machine the issuer does not control**, made
once, briefly, by a technician with a screwdriver in one hand, about hardware
that is then packed into a pallet and sold. And this is the difficulty that
shapes everything in this paper:

> **Nothing in the normal operation of such a system tells you when it is
> wrong.**

A machine reported as having no encryption, when in fact the probe that looked
for encryption failed, produces a document that reads exactly like a correct
one. It passes review. It satisfies the buyer at the moment of sale. The error
surfaces weeks later, in somebody else's hands, if it surfaces at all. There is
no exception, no alert, no failing test, and no complaint — because the wrong
answer is the reassuring one.

Conventional software engineering has weak defences here. Tests assert that
code behaves correctly when its inputs behave correctly. Monitoring catches
things that crash. Code review reads the path the author was thinking about.
None of these reliably catch a probe that quietly returns *nothing found*
because it could not look.

### 1.1 The thesis

This paper describes a complete production system built for a working ITAD
business, and argues one idea that runs through every layer of it:

> **Every output of this system is a claim about a machine the system does not
> control. Its entire value is how honestly it separates what it has
> established from what it has merely assumed.**

That is not a slogan bolted on afterwards. It is the design constraint that
produced the offline queue's visible-failure rule, the audit station's
refusal to report its own hardware as the machine's, the wipe engine's
insistence on reading the drive back, the three-valued verdicts in lock
detection and functional testing, and — at the limit — the decision that
certain questions about a machine have **no offline answer at all** and must be
reported as unanswered rather than guessed.

### 1.2 The system

| | |
| --- | --- |
| Built | 9 July – 24 September 2026, 78 days |
| Commits | 535 |
| Code | ~101,000 lines across four deployable components |
| Domain entities | 23, over 62 schema migrations |
| Test files | 96 (46 server-side, 50 for the audit station) |
| Engineers | 1 |

Four components: a **NestJS API** with Postgres, a **Next.js web application**,
a **PowerSync** service giving the warehouse floor a local database that
survives losing the network, and — the unusual one — a **bootable USB audit
station** that boots a customer's machine into Linux, examines it without ever
running its operating system, erases it, and reports back.

### 1.3 Contributions

1. **A complete architecture for evidence-producing asset disposition**,
   described layer by layer (§§4–10), including the parts that are ordinarily
   left out of systems papers: the boot chain, the kiosk hardening, and how
   code reaches a USB stick in a warehouse.
2. **A four-tier framework for machine knowability** (§11) — what a powered-off
   computer can be made to tell you about itself, where inference has to
   replace measurement, and where the answer lives in somebody else's cloud and
   cannot be obtained at all. We work it through Microsoft Autopilot
   enrolment, where we reached a hard limit and documented it rather than
   guessing past it.
3. **A defect class named, measured and catalogued** (§12): the *false
   absence*, a failed observation reported as a confirmed negative. 32 call
   sites across this codebase, every one failing towards the reassuring answer
   — and the uncomfortable result that naming it in a commit, documenting it in
   the code and defending it with tests did not stop eight fresh instances
   being written within three weeks.
4. **An account of what was deliberately removed** (§13). Three working,
   shipped modules were deleted because they modelled a business that does not
   exist. We argue this is why the system stayed small enough to keep changing.

### 1.4 How to read this

Part I is the problem and the shape of the system. Part II walks the layers
from the data model outward to the machine on the bench. Part III is what the
building taught — the findings that generalise past this business. Part IV
reports what the system does in production, what is still unproven, and what we
would tell anyone building something similar.

A reader who wants only the engineering findings can read §§11–14 and skip the
rest. A reader who wants only the architecture can read Part II. The failures
are kept in throughout, in the sections where they belong, because a paper that
reports only what worked is a brochure.

## Drafting notes

- The scale table is measured, not estimated: `git rev-list --count HEAD`,
  a `find | xargs cat | wc -l` over the four source trees, and counts of
  `*.entity.ts`, `migrations/*.ts`, `*.spec.ts` and `tools/test-*`.
- "Engineers: 1" is verified — three git identities, all the same address or a
  typo of it. It is load-bearing in §12 and should not be softened.
- §1.1's thesis must be the same wording used in §17. Check at assembly.
- Do not let this section grow. Everything it gestures at gets a full section
  later; the introduction's job is to make the reader want them.
