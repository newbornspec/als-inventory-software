**Draft 1.**

---

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

## Drafting notes

- Requirements are numbered R1–R7 and referenced by number in later sections.
  Keep the numbering stable; if one is added, append rather than renumber.
- §2.3's example (the stick recorded as the machine's drive) is deliberately
  placed here rather than only in §6, because it is the clearest one-sentence
  case for R4 and a reader needs it early.
- Resist adding a requirement for throughput. It was never measured, and an
  unmeasured requirement in a paper invites a reviewer to ask for the number.
