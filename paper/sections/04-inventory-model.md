**Draft 1.**

---

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

## Drafting notes

- The three-tier table is the single most useful thing in this section for a
  reader from another ITAD business. Keep it first.
- §4.3's merge invariant and §4.4's E5 are both candidates for §17's lessons.
  Cross-check at assembly that they are not restated there at length.
- The "false extra is an accusation" line is from the receiving record and is
  the owner's framing, not ours. Attribute it if the paper is ever co-authored.
- Not covered here: invoices, customers, sales orders. They exist in the schema
  but §13 explains why the sales module was removed, and covering the residue
  would mislead.
