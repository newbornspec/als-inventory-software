**Draft 1.**

---

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

## Drafting notes

- §5.2's table is the paper's first concrete evidence for the thesis and is
  quoted implicitly by §12. Do not cut it for length.
- The destructive-read defect in §5.4 is also §12's single "reached nobody"
  instance. The two sections must agree; check at assembly.
- Consider whether §5.5 belongs here or in §6 with the rest of the station
  work. It is here because it is about instrumentation honesty, which is this
  section's theme, but a reviewer may read it as misplaced.
