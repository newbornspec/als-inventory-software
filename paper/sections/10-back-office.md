**Draft 1.**

---

## 10. Layer 7: the back office

The web application is where the evidence produced at the bench becomes a
business: receiving and reconciliation, the inventory hierarchy, pallets,
sales status, reporting, certificates, and user administration. Thirty pages.

It is the least novel layer in the system and it produced two findings worth
reporting anyway — one about where authorisation actually lives, and one about
a page that contradicted itself.

### 10.1 Permissions, inverted

Permissions had grown case by case since the ownership work in July. Each
endpoint decided for itself, which meant **the default was open**: a route
added without a guard was reachable by anyone signed in, and nobody could state
what a given role could do without reading every controller.

The rebuild inverted the default. **A route with no declared permission is
refused.** Forgetting to guard a new endpoint now produces a visible refusal in
testing rather than an invisible hole in production. The failure mode moved
from silent to loud, which is the same move the rest of this paper keeps
making.

Two consequences were made explicit rather than left to convention:

> **The UI hides what the API refuses, and the API is what enforces.**
> Hiding a button is a courtesy, never a boundary.

Every gated control in the application is gated on **the same permission the
API checks**, and navigation is built from what the signed-in user may actually
do — including landing rules that send each person to a page they can use, and
deep links that are honoured rather than bounced.

The second consequence was overdue. Every audit station's USB stick had been
authenticating **as an administrator**. A lost stick was a full compromise of
the system. Stations now hold a least-privilege account that can file audits
and nothing else (R6).

### 10.2 Deleting a user is not an option

The audit trail names the people in it, so deleting a user would destroy the
record of who did what. Users are therefore **disabled, never deleted** (§4.5).

That decision creates an obligation that is easy to miss: a disabled account
holding a valid token is **still signed in**. Bearer tokens are not revocable
by themselves — the server has already said yes, and nothing about disabling a
row reaches the token in somebody's browser. Making "disabled" mean anything
required an explicit revocation path and the client handling rejection
properly, so that a disabled account is ended rather than merely marked.

This is the authorisation equivalent of the paper's thesis: a state change that
is recorded but not enforced is a claim the system cannot support.

### 10.3 A dashboard that disagreed with itself

The operational dashboard is computed as **one SQL roll-up** rather than many
queries assembled in JavaScript. The performance gain was secondary; the real
reason is consistency. Figures computed in separate queries at slightly
different moments disagree with each other, and *a dashboard whose numbers
contradict each other is worse than no dashboard.*

The defect worth recording is subtler than a wrong number. The headline "In
stock" figure **totalled five statuses**; clicking it navigated to a filtered
list asking for **one**. Neither the number nor the list was wrong on its own.
The defect was that two parts of one page answered different questions while
appearing to answer the same one — and it only surfaces when somebody actually
clicks.

The same shape had already appeared once, in a reports filter. It is worth
naming as its own small class: **a summary and its drill-down must be computed
from the same predicate, or the page lies at the moment a user trusts it
most.**

### 10.4 Reporting

The reporting section was rebuilt from a set of tables into eleven analytical
slices — sales, batches, pallets, warehouse, users, consumables, suppliers,
activity — with filters and spreadsheet and PDF export. It is the least
architecturally interesting part of the system and among the most used, which
is a common and under-reported combination.

One rule carried over from the rest of the system: reports respect ownership
scoping (§4.4, E3), and a printed report **says who generated it**. A document
that leaves the building carries its provenance.

### 10.5 Consistency as a defect detector

Two pieces of cross-cutting work belong here because of what they *found*
rather than what they changed.

A **visual system pass** brought thirty-one pages into one design language. In
doing so it exposed ten functional defects. Pages that had been written
independently had diverged in ways nobody noticed until they were placed side
by side — controls that did nothing, states that were unreachable, labels that
meant different things on different screens.

A **WCAG 2.2 AA accessibility pass** did something similar. Its most
instructive moment is a correction: a lighter field border was introduced for
visual reasons, **failed contrast**, and had to be adjusted — the trade-off
being written down rather than quietly reverted.

Both passes are the same technique: forcing a system to be consistent is a way
of discovering where it is wrong. Inconsistency is cheap to tolerate one page
at a time and expensive in aggregate, and the aggregate is invisible until
something makes you look at all of it at once.

## Drafting notes

- §10.3's "summary and drill-down" rule is genuinely generalisable and appears
  nowhere in the literature we know of by name. Consider promoting it to §17.
- §10.2 connects to §4.5. Neither should restate the other; this one owns the
  enforcement argument, §4.5 owns the data-model reason.
- **Verified before commit**, against the design records: "ten functional
  defects" (the visual-system record says "Ten substantive faults"), thirty-one
  pages, and eleven reporting slices. This paper has already been wrong about
  three figures it asserted before measuring; these were checked first.
- The web application has no automated tests (§3.5). That fact belongs in §16,
  not here, but a reviewer reading this section will think of it.
