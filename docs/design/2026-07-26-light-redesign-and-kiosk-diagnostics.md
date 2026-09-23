# The light redesign, and teaching the station to explain itself

## Status

Shipped, 26–27 July 2026. `62ddd37` · `1dd5ebf` — and `c56662a` · `0e54a81` ·
`8f89420` · `011170d` · `af1a63e` · `833dc0d` · `69b7b9e` · `4e523ba` ·
`1a91f17` · `ba0bed9` · `364bd0e`

Two separate pieces of work on the same two days.

## The web app: dark to light

`62ddd37` converted the navigation and Lots page; `1dd5ebf` completed the
remaining **24 pages** in one pass.

Doing it as one commit for 24 pages was deliberate. A theme conversion done
page by page leaves the app visibly half-converted for as long as it takes, and
every shared component has to work in both themes meanwhile.

The chart palette was validated for contrast rather than picked by eye — the
same discipline that later became the WCAG 2.2 AA pass in August.

## The station: five ways of not working, made distinguishable

The kiosk worked on the bench and failed in the field for reasons nobody could
see. This is the work that made failures legible.

**`011170d` — Network check: name the broken layer instead of "not
connected".** The old message covered no cable, no DHCP lease, no gateway, no
DNS, no route to the internet and an unreachable API. Six faults with six
different fixes, reported identically. The check now walks the layers and names
the first that fails.

**`af1a63e`, `833dc0d`, `69b7b9e` — the clock.** A live-booted machine with a
dead CMOS battery believes it is years ago, and **a wrong clock breaks HTTPS**:
the server's certificate reads as not-yet-valid, the connection is refused
before any data flows, and it surfaces as a bare "not connected" with no error
text. Three commits: sync the clock, actually fix it, and make the fix
permanent for machines whose battery is dead. This is why the station carries
an offline time floor and a one-click *Fix clock now*.

**`4e523ba` — never block the web server on the clock sync.** The fix for the
clock introduced a worse fault: the server waited for the sync, and if it hung
the kiosk showed a blank screen. A diagnostic that can hang the thing it is
diagnosing.

**`1a91f17`, `ba0bed9` — audit the whole startup path.** Two deliberate passes
over everything between power-on and a usable interface, on the principle that
anything that *can* block the interface eventually will.

**`0e54a81` — make Settings actually save, and never lose a record offline.**
Two faults in one commit, both silent: settings that appeared to save and did
not, and audit records lost when the station went offline.

**`364bd0e` — warn when a machine has already been audited into this batch.**
A duplicate audit is easy to do and hard to notice.

## Why it matters

Every one of these is the same class of problem: **the station knew something
and was not saying it.** The pattern of naming the failing layer, rather than
reporting a generic negative, is what the false-absence work formalised two
months later.

## What was deliberately not built

No remote diagnostics or phone-home. The station explains itself on its own
screen, to the person standing in front of it.

## Open questions

The network check was rebuilt again in September (`1b98245`, `6dbf8e8`) to
judge the station by whether it can reach ALS Inventory, rather than treating
every layer as a failure in its own right — it had been crying wolf on stations
that were working.
