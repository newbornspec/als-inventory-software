**Draft 1.**

---

## 13. The discipline of deletion

Three working, shipped modules were removed from this system within six weeks
of being built. That is unusual enough to report, and the reasons are the same
in all three cases.

| Feature | Built | Removed | Lifetime |
| --- | --- | --- | --- |
| Warranty tracking | 9 July (in the initial commit) | 13 July | 4 days |
| Sales, customers and orders | 12 July | 25 July | 13 days |
| Repair logging | 12 July | 20 August | 39 days |

None was removed because it was broken. Each worked. Each was removed because
**it modelled a business that does not exist.**

### 13.1 What each one got wrong

**Warranty tracking** was in the system from the very first commit, because
an asset system "obviously" tracks warranties. Nobody used it, and the data
needed to make it useful — per-device warranty terms from each manufacturer —
was never going to be entered by hand. It was the smallest of the three: fields
on the asset rather than a module, which is why it could go in a single commit
that dropped the columns with them. It was replaced with low-stock and out-of-stock alerts on
consumables, which answer a question the warehouse actually asks: *are we about
to run out of caddies?*

**The sales module** modelled an order book: customers, orders, line items,
fulfilment. The business has no order book. Stock goes to trade buyers in bulk,
and what needs recording is a **status transition** — this left, on this date,
for this price. Every screen in the module asked for information nobody had.

It was replaced by **Sold as a status rather than a module**. Selling is
terminal and locks the record; only an administrator can reverse it; and a
return **reactivates whatever the device came from**, because otherwise a
device comes back into a container that still says it has gone, and the stock
counts quietly disagree with each other.

**Repair logging** assumed a repair workshop with per-device work logs. The
warehouse grades devices and either sells them or breaks them for parts. Six
weeks of non-use made that unambiguous.

The common failure is not over-engineering in the usual sense. Each module was
a reasonable implementation of a real concept. The error was earlier: **the
concept was imported from what inventory systems generally have, rather than
derived from what this business actually does.**

### 13.2 Removing things safely

The third removal produced a house rule, which the first two were small
enough not to need:

> **Drop the code first, drop the table second. Two commits, two deploys.**

The code and the schema deploy separately. Dropping a table while code still
references it is an outage; dropping the code first means the table sits unused
for one deploy and then goes. This is the mirror image of the migration
ordering hazard in §3.4 — in both cases the rule is that **code and schema must
never be in a state where one expects something the other has not got.**

The second rule is about what survives a removal. The repairs module had
accumulated **grading verdicts that were genuinely in use**, and those were
preserved rather than going with the table. A module being wrong does not make
everything in it wrong, and the work of separating the two is what makes
deletion safe enough to do at all.

A related correction was made on the same principle: costing and invoicing had
been attached to pallets, **because that is where they were first needed, not
because they belong there**, and were unhooked. Misplaced attachment is a
quieter version of the same mistake — the feature is right, the model is
borrowed.

### 13.3 The argument

Adding a feature needs one person to think it is a good idea. Removing one
needs somebody to say, out loud, that work already paid for should be thrown
away — and to be right about it.

We think the deletions are why the system stayed buildable. The audit station,
the erasure remediation and the inspection layer are all substantial pieces of
work that arrived in August and September, into a codebase that had shed three
modules it did not need. A codebase carrying warranty tracking, an order book
and a repair workshop would have had three more sets of screens, migrations,
permissions and tests to drag through every subsequent redesign — and each of
them would have had to be kept working while the parts that mattered were
being rebuilt.

**The useful measure of a system under active development is not how much it
contains. It is how much of what it contains is load-bearing.**

### 13.4 The honest residue

The deletions were not total, and the paper should say so. The schema still
carries customer, sales-order, order-line and invoice entities, and the API
still has the corresponding modules. The user-facing sales workflow is gone and
the Sold status replaced it, but the underlying tables were not all dropped.

This is left as it is rather than presented as finished. A reader inspecting
the repository will find them, and a paper that claimed three clean removals
while the residue sits in `apps/api/src` would be making exactly the kind of
tidy, unsupported claim this project spent three months learning not to make.

## Drafting notes

- **The lifetime table was corrected against the commit history**, not the
  design records. Draft 1 had warranty tracking built on 11 July and removed on
  the 12th; it was in fact present in the initial commit of 9 July and removed
  on the 13th, and repairs lasted 39 days rather than "six weeks". The design
  records were loose here and the git log is authoritative.
- §13.4 was added after checking the repository rather than trusting the
  records. It is the honest counterweight to §13.3 and must not be cut.
- §13.3's closing line is a candidate for §17. Do not use it in both at full
  length.
- A reviewer may ask for evidence that removal *caused* the later velocity.
  There is none — it is an argument, not a measurement, and §16 says so.
