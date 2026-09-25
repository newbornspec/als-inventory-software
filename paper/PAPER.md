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

## 4. Layer 1: the inventory model

The first design mistake available in this domain is to believe that a
warehouse contains one kind of thing. It contains three, and they need three
different models.

| Tier | Example | Identity | Counted by |
| --- | --- | --- | --- |
| **Serialised asset** | A laptop | Its own serial number | One row per physical device |
| **Pallet line** | Forty identical 24-inch monitors | The variant, not the unit | Quantity per variant |
| **Consumable** | Caddies, cables, screws | The stock line | A running balance |

Forcing monitors into the asset table means inventing serial numbers for
devices nobody will ever look up individually. Forcing cables in means forty
rows for one box. Both were considered and rejected early, and the three-tier
split has survived every subsequent redesign.

The system is honest about what this costs: a pallet line **cannot tell you
which physical monitor is which**, and that is recorded as the correct model
for the business rather than a limitation awaiting a fix.

### 4.1 The hierarchy, and the one deliberate exception

Stock arrives as a **purchase lot** — a pallet or van-load bought from a
supplier — which contains devices, each of which has hardware. The interface
follows that shape: **Lot → Asset → Hardware**, with a breadcrumb trail and
Total / Audited / Pending counts on each lot card, so the state of a lot is
legible without opening it.

One screen deliberately does not follow the hierarchy. The global assets page
was kept as a **search**, because *what is in this lot* and *where is this
serial number* are different questions and forcing the second through the first
makes it slow and annoying. Consistency was traded for fitness, knowingly.

### 4.2 Expected against actual

A supplier describes a lot in a spreadsheet before it arrives. A lot therefore
exists, with expected quantities and a supplier, before a single device is
touched — and receiving becomes **reconciliation** rather than data entry.

The manifest importer parses CSV and XLSX **in the browser**, not on the
server. The files are small and the formats are inconsistent, and the operator
needs to see what the system understood before any of it is committed.

The reconciliation has a rule worth stating, because it is an instance of the
paper's thesis applied to a business process: **a false "extra" is an
accusation**. If the system reports that a device arrived which was not on the
manifest, it is implicitly saying somebody added it. That claim has to be
correct, so the matching is conservative and unmatched items are presented as
unmatched rather than as discrepancies.

### 4.3 Stock as a derived balance

Consumables are modelled as `StockLine` plus `StockMovement`. The quantity on
hand is **derived from the movements**, never a number a person edits. Every
change carries a reason. The result is that "we have eleven caddies" is a
statement with a history behind it rather than an assertion somebody typed, and
the low-stock alert that replaced a removed feature (§13) answers a question
the warehouse actually asks.

The pallet model has an equivalent invariant, arrived at after two rebuilds:
**a merge moves lines, it never copies them.** Merging pallet B into pallet A
must leave the total count unchanged. Copying would double stock; moving cannot.
Stated that way the rule is obvious, which is exactly why it needs to be
written down — the implementation that copies looks correct in every test that
does not add up the totals afterwards.

### 4.4 Ownership, and the lesson that generalises

With several managers buying and processing stock, the system had to answer
*whose stock is this, and who did this?* Ownership was added to batches and
then enforced in six passes:

| Pass | Scope |
| --- | --- |
| E1 | Batch reads |
| E2 | Asset reads, via their batch's owner |
| E3 | Dashboard, reports and certificates |
| E4 | Write guards, and admin reassignment |
| **E5** | **The PowerSync upload path *and* the sync rules** |
| E6 | The activity log |

**E5 is the one worth extracting.** Scoping the HTTP API is not sufficient when
clients synchronise a local database directly. Without scoping the sync
*rules* as well, a manager's phone would download rows it could not have
fetched over HTTP — the guard on the front door held while the side door stayed
open. Any system combining a permissions layer with a sync engine has two
separate enforcement surfaces, and securing one reads exactly like securing
both.

Two scoping decisions were made explicitly and recorded rather than
discovered later: **scoping applies to managers only** (technicians are floor
staff who scan into any lot, and scoping them breaks the job), and
**technician-created lots belong to an unowned pool** visible to all managers,
without which a technician's work would have become invisible to everyone.

### 4.5 Append-only history

The activity log is system-wide and append-only, and asset history is kept
rather than overwritten. This is the data-model expression of the invariant in
§3.3: *evidence flows inward, and the record is never edited to agree with it.*
When a second audit contradicts the first, both survive, and the question
"what did we believe, and when?" stays answerable.

It also constrains a feature the business asked for later. Deleting a user
would destroy the audit trail that names them, so users are **disabled, never
deleted** — a rule that then required its own work on session invalidation,
because a disabled account with a valid token is still signed in (§10.3).

## 5. Layer 2: offline-first capture

R1 says capture must work with no connection. That single requirement produces
the component with the worst failure mode in the entire system, because **a
queue that loses work looks exactly like a queue with nothing to do.**

### 5.1 The architecture

The client holds a local SQLite database. PowerSync streams rows down according
to sync rules and carries writes back up. The technician's phone is therefore a
full participant rather than a thin client: scanning works in a loading bay
with no signal, and reconciles when signal returns.

The web application, by contrast, was **deliberately not made offline-capable**.
Only the scanning and capture paths are offline-first; reporting and
administration assume a connection. Offline reporting would have meant
replicating business rules into the client for no operational gain.

### 5.2 Four faults in the first week, three of them silent

PowerSync did not work out of the box, and each failure is load-bearing enough
that it is still shaping the codebase:

| Fault | How it presented |
| --- | --- |
| Worker assets never copied into the build | Sync **hung silently** — indistinguishable from nothing to sync |
| JWTs signed with the wrong `kid` | Auth failed for a reason documented nowhere obvious |
| Multi-word columns dropped on upload | Data looked saved on the device and **arrived incomplete** |
| One deleted batch reference | Wedged the **entire** upload queue behind it, indefinitely |

Three of the four announced nothing. The fourth announced nothing useful: an
unresolvable foreign key stopped every queued write behind it, forever, and the
device carried on accepting work.

That last one produced a rule that recurs throughout the project and is
restated in §17: **a record the server refuses must become visible, not be
retried forever in silence.** A queue that retries indefinitely is not
resilient; it is a way of hiding a permanent failure behind a temporary-looking
one.

### 5.3 Scanning: the decision, and what a warehouse did to it

Every device enters the system through its serial or service tag. Typing them
is slow and wrong; the labels are small, worn, and often carry no barcode at
all.

A commercial scanning SDK was evaluated and **rejected in favour of free
platform capabilities**: the browser's native `BarcodeDetector`, plus
full-resolution camera OCR for text-only labels. The reasoning was that a paid
SDK is a per-device licence on hardware the business keeps buying, for a job
the platform can already do. The accepted trade-off is that `BarcodeDetector`
support varies by browser and OCR on a worn label is worse than a dedicated
engine's.

The first version worked in an office and badly in a warehouse. Three
corrections, each generalisable:

**Know what you are looking for.** A Dell label carries the service tag, the
express service code, FCC identifiers, regulatory model numbers and
certification marks. Naive OCR returns whichever string it read most
confidently — frequently a regulatory number. The fix was to encode what a
vendor's tag actually looks like, rather than trusting confidence.

**A still photograph beats a video stream.** An aiming box was added to help
the operator, then removed. Cropping discarded the pixels OCR needed, and a
live video frame is lower resolution than a still. Full-frame detection plus a
full-resolution still photo outperformed the thing that looked more helpful.

**Show the operator what the software is doing.** The torch toggle failed on
some devices and nothing indicated which detection engine was running, so a
failure to scan was indistinguishable from a failure to aim. On-screen engine
status fixed more perceived bugs than any detection change.

One further correction is a data-model point: the same device scanned from a
barcode and read by OCR produced **different strings**. A single normaliser,
applied to both paths, is what makes the two agree.

### 5.4 The queue that had to survive a power cut

The audit station kept queued records **in memory**. A technician who audited
six machines with no network and then powered the bench down lost all six, and
nothing said so. On a bench where machines are powered off as a matter of
course, that was a question of when rather than whether.

The queue moved onto the USB stick — the one component guaranteed to still
exist after a power cut.

A month later the same component produced the most serious defect in the whole
catalogue. A queue file that existed but **could not be fully parsed** was
treated as empty, and then rewritten — destroying the records it had failed to
read. It is the only instance in §12's dataset that reached nobody, because it
produced no wrong sentence: it produced no sentence at all.

> **Making storage durable and making it safe to read are two different jobs.**
> The first was done deliberately and the second was assumed.

### 5.5 Two instrumentation faults with the same shape

**Ping is not the internet.** The station's connectivity check tested one
address by ICMP. A site that filters ping — as this one does — produced a red
failure on a station that was uploading perfectly well. The check now tries
several addresses over both protocols, shows the routing table, and, decisively,
judges the station by **whether it can reach the ALS API**, not by whether it
can reach the internet in the abstract.

**A silent success looks like a hang.** An OS restore writes several gigabytes
with no output. The operator sees a still screen and cannot distinguish a
working restore from a dead one. The system knew it was fine and was not saying
so.

Both are the same defect as the queue, pointed the other way: the first
reported a failure that had not happened, the second failed to report a success
that had. In each case the code held the information and discarded it before it
reached a person.

## 6. Layer 3: the audit station

The audit station is a bootable USB stick. A technician plugs it into a machine
that arrived that morning, boots it, and gets one full-screen interface that
examines the machine, erases it, and uploads what it found.

Booting the customer's own Windows was never an option. Many arrive locked or
encrypted; booting changes the machine, which is evidence (R3); and a great
deal of what needs to be read — the registry, the hidden partitions, the raw
drive — is easier and safer to reach when Windows is not running. **The
machine's operating system is never started.**

### 6.1 The base, and the constraint that chose it

The station runs Ubuntu 24.04. That choice was made for **Secure Boot**: a
significant share of incoming machines will not boot an unsigned image without
a firmware change the technician should not be making on a customer's hardware.

The live session, though, is amnesiac. Every `apt install` is discarded at
reboot — and without `nvme-cli` an NVMe drive cannot be secure-erased, which is
most of what comes through the door. So the station carries a **casper overlay
layer**: an additional squashfs stacked on the stock image, holding the extra
packages and the kiosk.

How casper selects layers had to be read **out of the stick's own initrd**,
because most of what is written about it online is wrong for 24.04. Selection
is driven by one variable:

```
LAYERFS_PATH=minimal.standard.live.squashfs
```

casper builds the stack by repeatedly stripping the last dot-component, and the
**longest name ends up highest priority**. A layer named
`minimal.standard.live.als.squashfs` therefore extends the chain and sits on
top.

The trap, which the build script now refuses to be talked out of: the chain
only walks *up*, by stripping. Name the layer `als.squashfs` and the chain is
just "als" — casper mounts a few hundred kilobytes **as the entire root**,
finds no `/sbin/init`, and panics. **The name must extend a chain whose every
ancestor already exists.**

### 6.2 Seven attempts to make a browser fill a screen

The station is an appliance: one interface, full screen, no desktop, no browser
chrome, no way to end up somewhere else. The hardware it runs on is whatever
came through the door — any manufacturer, any graphics chip, any panel,
sometimes no working display driver. There is no fixed target to develop
against.

| Approach | Why it failed |
| --- | --- |
| Firefox kiosk mode | Hides the toolbar, opens at ~90%, never fills |
| Cage (Wayland kiosk compositor) | Correct when present — not on the image |
| Auto-install Cage at boot | Needs a network; the bench often has none |
| X fallback with a window manager | Another dependency not on the image |
| Window resize via an external tool | Deterministic, still an install |
| **python + libX11 via ctypes** | **Worked.** No packages, any display |

The lesson, paid for over seven attempts and fifteen commits:

> **On a live-boot appliance, a dependency you have to install is a dependency
> you do not have.**

Every approach needing a package worked on the development machine and failed
on the bench. What shipped talks to libX11 through ctypes and resizes whatever
top-level window appears, using only what the stock image already carries.

Progress became possible only after a **Display readout** was added to the
status bar showing the resolution *and which of the five launch paths had
actually run*. Until then every failure looked identical: a window that was not
full screen. Most of the subsequent progress is attributable to being able to
see which mechanism had fired — the same instrumentation principle as §5.5.

### 6.3 Who owns a keypress

An appliance has to survive its operator. During functional keyboard testing a
technician pressed keys on a Lenovo laptop and the entire interface disappeared
to a black screen. Investigating produced a model that turned out to be
generally useful:

| Layer | Owns | Can software refuse it? |
| --- | --- | --- |
| The page | Ordinary keys, Escape, function keys | **Yes** — the event can be cancelled |
| The X server | Virtual-terminal switching | **No** — intercepted below the client |
| The machine | Brightness, display output, vendor app-commands | **No** — firmware or the keyboard controller acts first |

Only the first layer offers a veto. The second required disabling server key
bindings at the X level; the third required clearing the offending keysyms
outright, because the machine acts before any software is consulted. A test
that asks a technician to press every key must therefore be defended at all
three layers — and the parts that cannot be defended have to be designed
around rather than trapped.

### 6.4 The station's hardware is not the machine's

The very first version of the audit tool enumerated block devices and took the
first one as the machine's drive. The first device was **the USB stick it had
booted from**. Every audit recorded the stick's model and capacity as the
machine's storage.

That defect is the ancestor of a rule now enforced in several independent
places: never report the station's Ubuntu as the machine's operating system;
never wipe the boot device whatever it reports itself as; skip removable and
USB devices in the storage scan. R4 exists because this confusion is easy to
write and invisible in a result that otherwise looks complete.

### 6.5 Accountability at the bench

Certificates are legal documents, so the station requires an **operator
sign-in**: the person who performed a wipe is recorded against it, not merely
the station that ran it. The station authenticates with a restricted account,
never an administrator (R6), and the kiosk service was hardened so the
interface cannot be escaped into a shell.

### 6.6 How code reaches a warehouse

There is no deployment pipeline to a USB stick on a bench. Getting a change
onto the stations is a physical act, and its cost differs by an order of
magnitude depending on which file changed:

| Change | What it takes |
| --- | --- |
| Interface, probes, autostart script | **Stick sync.** Copy files, checksum each, done |
| Anything inside the overlay layer | **Layer rebuild** plus a reboot on the audit machine |

This boundary is a real design input, and one decision shows why. The Autopilot
work needed an event-log reader that is not on the stock image, so it was added
to the layer build — gating the whole feature behind a rebuild. The rebuild
could not be run off the target machine, and the reason is more interesting
than the absence of build tools on Windows: the build has a safety gate that
simulates installing the packages against the **host's** package database, to
catch a package that would be an *upgrade* of something already on the live
image. In a container, that database is the container's. The gate would report
"none of these is an upgrade" not because it is true but because it **cannot
see** — passing vacuously, silently disabling the check that exists to prevent
exactly that failure.

The alternative shipped instead: the live session is writable and the stick is
already synced, so the packages ride on the stick and are installed at boot.
They stay in the layer list as well; whichever arrives first wins, because the
installer returns early if the tool is already present.

Two further details of the sync path are worth recording, because both hid real
faults. The stick carries a **version stamp**, without which a bug report
cannot be tied to a build. And the sync **flushes the write cache**, because
Windows reports a copy to removable media as complete before the data has left
the buffer — pull the stick immediately and you get a truncated file that
verifies as *present*.
