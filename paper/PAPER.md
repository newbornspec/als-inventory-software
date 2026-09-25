# Proving what a second-hand computer is

**An evidence-first architecture for IT asset disposition**

*Assembled from `paper/sections/` -- edit those files, not this one.*
*Drafting notes are excluded. Regenerate with `python paper/assemble.py`.*

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

## 2. Requirements and constraints

The shape of this system is almost entirely explained by four facts about where
it runs and what it is for. None of them are software requirements in the usual
sense; all four eliminate designs that would otherwise be obvious.

### 2.1 The floor is not a network

Machines are received in a loading bay, examined in a back room, and stacked on
pallets in a warehouse. Wi-Fi reaches some of those places some of the time. A
system that stops accepting work when the connection drops is a system that
technicians route around, usually onto paper, and the paper never reaches the
database.

**R1. Capture must work with no connection at all, and reconcile later.**
This forces a local database on the client and an upload queue — and, as §5
describes, the queue then becomes the single most dangerous component in the
system, because its failure mode is losing somebody's work silently.

### 2.2 The operator has a screwdriver in one hand

The person using the audit station is a warehouse technician, not a system
administrator. They are standing at a bench, often with the machine open. They
will not read a manual, mount a filesystem, or type a command. If the tool
requires a decision they are not equipped to make, they will pick whichever
option lets them continue.

**R2. The station must run without being typed at**, boot straight into its
interface, and never present a question whose wrong answer is invisible. This
requirement drove a long sequence of work — autorun, a desktop launcher, a
kiosk session, full-screen enforcement — described in §6.

### 2.3 The machine is somebody else's, and it is evidence

The subject of every examination is a computer that belonged to a customer,
still holds their data, and may have to be returned or accounted for. Until the
moment an erasure is deliberately authorised, nothing about it may change.

**R3. Read-only by default.** The customer's volumes are mounted read-only. The
registry is read out of the hive files offline; the machine's own Windows is
never booted. **R4. The station's hardware is not the subject's.** This sounds
trivial and is not: the very first version of the audit tool recorded the USB
stick it had booted from as the machine's hard drive (§6.4), and the same
confusion recurs in OS detection and in the wipe engine's drive selection,
where the consequence is erasing the wrong disk.

### 2.4 The output is a legal document

An erasure certificate is relied upon by the organisation that owned the data
to discharge an obligation it cannot delegate. A specification is relied upon
by a buyer paying money. Both are produced from automated probes of unfamiliar
hardware, in a single pass, by a non-expert.

**R5. Every claim must be separable into what was established and what was
assumed**, and that separation has to survive all the way to the sentence a
person reads. A certificate that cannot express *we could not check this* will
express *this is fine* instead — which is the defect class §12 is about.

### 2.5 Two constraints that are not about the machine

**R6. The station carries credentials, on a stick that can be lost.** It needs
network configuration and a server account to upload what it finds. Its
configuration file has therefore never been in the repository, and a standing
rule forbids reading or printing its values anywhere — presence and format
only. The account it uses is a restricted station account, never an
administrator.

**R7. Code has to reach a stick in a warehouse.** There is no deployment
pipeline to a USB device on a bench. Getting a change onto the stations is a
physical act, and the cost of that act differs by an order of magnitude
depending on which file changed (§6.6). This constraint shaped real design
decisions — including, in one case, shipping a Debian package by file copy
rather than rebuilding a filesystem image.

### 2.6 What this rules out

| Obvious design | Why it fails here |
| --- | --- |
| Web app on the technician's phone, server-side truth | R1: no connection in the bay |
| Agent installed into the customer's Windows | R3: booting their OS changes it; many arrive locked or encrypted |
| Cloud API for device status | R3 and §11: the machine is offline and the answer is behind somebody else's authentication |
| Two-valued results (present / absent) | R5: cannot express a probe that failed |
| Continuous deployment to the stations | R7: they are USB sticks in a warehouse |

## 3. System overview

Four deployable components, two trust zones, and one direction of travel:
evidence is produced at the bench and flows inward to a record that is never
edited to match it.

### 3.1 The components

```
   TRUSTED ZONE (the business)                UNTRUSTED ZONE (the bench)
 ------------------------------------      -------------------------------
                                          
  Next.js web app  ......  Vercel          ALS Audit Station
    30 pages                                 bootable Ubuntu USB
    admin, reports, certificates             |
        |                                    |  boots the CUSTOMER's machine
        |  HTTPS                             |  into Linux; that machine's
        v                                    |  Windows never runs
  NestJS API  ..........  Railway            |
    23 controllers                           |   - reads hardware directly
    23 entities, 62 migrations               |   - mounts volumes READ-ONLY
    certificate signing                      |   - parses registry hives offline
        |                                    |   - erases, then reads back
        |                                    |
        v                                    +--> HTTPS, restricted station
  PostgreSQL 16  .......  Railway                  account, durable local queue
    private network only                           (survives power loss)
        ^
        |  logical replication
        |
  PowerSync  ...........  Railway
    sync service                            Phone / PWA  (warehouse floor)
        ^                                     scanning: barcode + OCR
        +-------------------------------->    local SQLite, offline-first
```

The **web application** is the office: receiving, the inventory hierarchy,
pallets, sales status, reporting, user administration, and the certificates.
The **API** holds all business rules and is the only writer to the database.
**PowerSync** gives the phone a local SQLite database that reconciles when a
connection returns. The **audit station** is a USB stick.

### 3.2 The trust boundary

The right-hand side of the diagram is the interesting one. The audit station
runs on hardware nobody in the business owns, on a machine that may be
encrypted, locked, broken, or carrying somebody else's data. It holds
credentials. It can be physically lost.

Three rules follow, and each is enforced in code rather than by convention:

1. **It writes nothing to the subject** unless an erasure has been explicitly
   authorised for that machine (R3).
2. **It authenticates as a restricted station account**, never an
   administrator, so a lost stick cannot administer the system (R6).
3. **Everything it reports is attributed to the station**, with the operator
   who was signed in recorded alongside it, so a wrong claim can be traced to a
   machine and a person rather than appearing as an anonymous fact.

### 3.3 The direction of travel

The system has one invariant that is worth stating on its own, because several
later decisions are consequences of it:

> **Evidence flows inward. The record is never edited to agree with it.**

An audit produces a profile. A wipe produces a verdict. A functional test
produces a result. These accumulate on the asset as *findings with provenance*
— which station, which operator, which run — and the asset's status is derived
from them. When a later audit contradicts an earlier one, both are kept. When a
finding is one the system could not establish, that is itself recorded (§7.3),
rather than being resolved into a clean value on the way in.

This is why the data model in §4 separates an asset from its audits, why
certificates are signed artefacts rather than rendered views, and why the
activity log is append-only.

### 3.4 Deployment, and the hazard in it

The API and web app deploy on push to `master`; Railway builds the API, Vercel
builds the web app. The audit station does not deploy — it is synced to a USB
stick by hand (§6.6).

One deployment detail is load-bearing enough to belong in the architecture
rather than an appendix. TypeORM issues a `SELECT` naming **every mapped
column**. If a deploy ships an entity carrying a new column before the
migration that creates it, every query against that table fails until the
migration runs. This happened once, taking three tables down in the gap between
deploy and migrate. The fix is that migrations run as a **pre-deploy command**
on the newly built image, while the previous version is still serving traffic:
if the migration fails the deploy aborts and the old version keeps running.
Code and schema move together or not at all.

### 3.5 What each part is made of

| Component | Language / stack | Size | Tests |
| --- | --- | --- | --- |
| API | TypeScript, NestJS, TypeORM, Postgres 16 | ~34,500 lines | 46 spec files |
| Web | TypeScript, Next.js 15, React | ~24,800 lines | — |
| Audit station | Bash, Python, HTML/JS on Ubuntu | ~41,900 lines | 50 test scripts |
| Sync | PowerSync, self-hosted | config + sync rules | — |

The station being the largest single component is not an accident of style. It
is where the system touches hardware it does not control, and §12 shows it is
also where 28 of 32 catalogued defects of the most dangerous class were found.
