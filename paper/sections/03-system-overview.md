**Draft 1.**

---

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

## Drafting notes

- The figure is ASCII deliberately: it survives `git diff`, renders in a
  terminal and in every markdown viewer, and costs nothing to keep accurate.
  If the paper goes to a venue wanting vector art, redraw it then.
- Line counts measured by `find | xargs cat | wc -l` over each tree, excluding
  `node_modules`. Web figure combines `apps/web/app` and `apps/web/lib`.
- §3.3's invariant is quoted again in §4 and §8. Keep the wording identical.
- The web app has no test files and the table says so with an em dash rather
  than a zero. Do not dress this up; §16 lists it as a limitation.
