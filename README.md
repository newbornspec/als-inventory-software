# Als Inventory Software

Offline-capable IT asset inventory system: NestJS + PostgreSQL API, Next.js 15
web app, PowerSync for offline scanning sync.

## Structure

- `apps/api` — NestJS backend (auth, asset data, PowerSync upload endpoint)
- `apps/web` — Next.js 15 web app (dashboard, login, offline scan page)
- `powersync/` — PowerSync self-hosted service config + sync rules
- `docker-compose.yml` — Postgres (logical replication enabled) + PowerSync service

## First-time setup

```bash
npm install                                   # installs all workspaces
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.local.example apps/web/.env.local

docker compose up -d                          # Postgres + PowerSync service
npm run migration:run --workspace=apps/api    # creates schema + powersync_publication
npm run seed --workspace=apps/api             # creates test users, locations, assets
```

Seeded logins (password `password123` for all):
- `admin@als.com` — full access
- `manager@als.com` — can create/edit assets
- `tech@als.com` — assigned to "Main Warehouse", scoped in PowerSync sync rules

## Running

```bash
npm run dev:api   # NestJS on :3001
npm run dev:web   # Next.js on :3000
```

Visit `http://localhost:3000` → redirects to `/login`.

## Using it as an Android app (PWA)

`/scan` works as an installable phone app — no native build, no Play Store,
no app-store review. Chrome on Android turns any site meeting a few criteria
into a home-screen app with its own icon and full-screen window; this app
meets them (`app/manifest.ts`, `public/sw.js`, HTTPS). Install flow on the
phone: open the site in Chrome → menu (⋮) → **"Install app"** (or Chrome may
prompt automatically). It then behaves like any other installed app icon.

On that installed page, tap **Camera** (next to **Keyboard**) on the scan
screen to use the phone's back camera — it decodes QR and Code128 in real
time via `@zxing/browser` and writes the scan through the exact same
PowerSync-backed local SQLite path as the keyboard-wedge input, so it's
online/offline-safe the same way. It's the same account, same role scoping,
same backend — installing on a phone doesn't create a separate system, it's
just another client talking to the same NestJS API and Postgres database.

**The one hard requirement: HTTPS.** Camera access (`getUserMedia`) and
service worker registration (required for installability) are both blocked
by the browser on any plain `http://` origin except `localhost` itself. Your
phone hitting your PC's LAN IP over `http://` will fail both silently — the
camera tab will show a permission error, and Chrome won't offer to install.
Two ways to get HTTPS for testing:

1. **Tunnel (fastest for dev):** run `npx localtunnel --port 3000` or
   `ngrok http 3000` to get a public HTTPS URL forwarding to your dev server,
   and open that URL on the phone instead of the LAN IP. If PowerSync is also
   needed (it will be, for the scan page), tunnel port 8080 too and set
   `NEXT_PUBLIC_POWERSYNC_URL` in `apps/web/.env.local` to that tunnel's HTTPS
   URL before starting `npm run dev:web` — otherwise the browser will block
   the PowerSync connection as mixed content (an `http://` request from a
   page loaded over `https://`).
2. **Real deployment (for actual use):** host `apps/web` somewhere with a
   real HTTPS certificate (Vercel, or your own server behind Caddy/nginx),
   and self-host the PowerSync service behind HTTPS too (a reverse proxy
   with a cert, or PowerSync Cloud, which is HTTPS by default). This is the
   right setup once you're past testing — no tunnel juggling.

`API_URL` (server-only, used by Next.js's own Server Components/Actions to
call NestJS) does **not** need to be phone-reachable — that traffic runs
server-to-server on your machine regardless of what device loaded the page.

## API reference (so far)

```
POST   /auth/login          { email, password } -> { accessToken, refreshToken, user }
POST   /auth/refresh        { refreshToken }
POST   /auth/me             (auth required)
POST   /auth/logout         (auth required)

GET    /assets              ?search=&category=&stockStatus=&conditionGrade=&auditStatus=&locationId=&batchId=&lotId=  (any role)
GET    /assets/:id                                                    (any role)
GET    /assets/:id/history                                            (any role)
POST   /assets              (admin, manager)
PATCH  /assets/:id          (admin, manager) — logs status_changed / condition_changed / transferred events automatically
DELETE /assets/:id          (admin only)

GET    /assets/:id/audits   (any role) — full ITAD audit trail
POST   /assets/:id/audits   (any role) — technicians record audits in the field, not just admins/managers

GET    /assets/:id/barcode  ?type=qr|code128 -> PNG   (any role)

GET    /locations           (any role)

GET    /notifications       (any role) — computed warranty-expiry + in-repair alerts
GET    /reports/assets.csv  (admin, manager) — CSV export of all assets

GET    /users                (admin only)
POST   /users                (admin only)
PATCH  /users/:id            (admin only)
DELETE /users/:id            (admin only) — blocked from deleting your own account

GET    /batches              (any role) — includes live actualUnitCount per batch
GET    /batches/:id          (any role)
POST   /batches              (admin, manager) — auto-generates batchNumber (BATCH-000001, ...)
PATCH  /batches/:id          (admin, manager)
DELETE /batches/:id          (admin only)

GET    /lots                 ?batchId=  (any role) — includes live actualUnitCount per lot
GET    /lots/:id             (any role)
POST   /lots                 (admin, manager) — auto-generates lotNumber
PATCH  /lots/:id             (admin, manager)
DELETE /lots/:id             (admin only)

POST   /powersync/upload    (auth required) — called by the PowerSync client SDK, not directly
```

## Status

Scaffolded: auth (JWT login/refresh/me/logout), asset/location/history schema
+ migration, seed script with 3 test users + 5 assets, asset CRUD API with
role guards and automatic history logging, PowerSync upload endpoint + sync
rules, and a full Next.js UI: login, dashboard (real asset-status counts),
assets list with search/filter, asset detail with history + inline edit,
new-asset form, and the offline scan page — all behind middleware auth and
role-gated (technicians can view/scan but not create/edit/delete; only
admins can delete). Assets/detail/create pages use Server Components +
Server Actions, so the JWT stays server-side except for the one deliberate
PowerSync exception noted in `app/api/powersync/token/route.ts`.

Barcode/QR generation is wired end to end: `GET /assets/:id/barcode?type=qr|code128`
renders a PNG from the asset's tag (`qrcode` for QR, `bwip-js` for Code128),
proxied through a Next.js route handler (same httpOnly-cookie pattern as the
PowerSync token) so `<img>` tags can load it without exposing the JWT. Shown
inline on the asset detail page, plus a dedicated `/assets/:id/label` page
sized for printing via the browser's print dialog.

Reporting & notifications: assets carry an optional `warrantyExpiresAt` date.
`/notifications` computes real alerts (warranty expired, warranty expiring
within 30 days, status = in_repair) shown on the dashboard, linking straight
to the affected asset. `/reports` offers a category breakdown and a one-click
CSV export of the full inventory (proxied the same way as barcodes, so the
download carries auth without exposing the token).

User management: `/users` (admin-only, both in the nav and enforced server-side)
lists everyone, lets an admin create a user with a temporary password and a
role, change anyone else's role inline, and delete accounts — deleting your
own account is blocked both in the UI (no delete button on your own row) and
in the API (`UsersService.remove` throws if the target id matches the
requester's). The nav itself is role-aware: it calls `GET /api/me` (decodes
the httpOnly JWT server-side, returns just the role) to decide whether to
show the Reports/Users links at all.

The scan page also now works as an installable Android app (PWA): a real
`app/manifest.ts`, a hand-rolled `public/sw.js` service worker (network-first
with an app-shell fallback so the installed app can still *open* offline —
actual data offline-ness is PowerSync's job, not the service worker's), and
camera-based QR/Code128 scanning via `@zxing/browser` as a second input mode
alongside the existing keyboard-wedge/manual entry. Both modes funnel into
the same `processScan()` function, so there's no separate "phone path" —
it's the identical local-SQLite read/write PowerSync already syncs. See
"Using it as an Android app" above for the HTTPS requirement this needs to
actually work on a real device.

## ITAD status, grading, and audit trail

The original `assets.status` enum (in_stock/assigned/in_repair/retired) was
conflating three independent concerns, so it's split into three fields on
`Asset`:
- **`stockStatus`** — warehouse lifecycle (in_stock, received, awaiting_audit,
  quarantined, allocated, picked, packed, shipped, disposed, etc.)
- **`conditionGrade`** — cosmetic grade (Grade A–D, For Parts, Scrap), nullable
- **`auditStatus`** — functional/testing outcome (Passed Testing, POST Failed,
  BIOS Locked, Data Wiped, Ready for Sale, BER, etc.), nullable

A new **`asset_audits`** table holds the full ITAD audit trail — one row per
audit event (manufacturer, model, serial, CPU/RAM/storage, screen, battery
health, a JSONB functional-test checklist, BIOS/charger/data-wipe status with
method e.g. "NIST 800-88 Purge", final disposition, who/when). The asset's
`conditionGrade`/`auditStatus` are denormalized from the *latest* audit so
list/filter views don't need to join audit history for the common case.
`POST /assets/:id/audits` is open to any role — recording a physical audit is
field work a technician does, not an admin/manager-only action, unlike
create/edit/delete on the asset record itself.

**This ties directly into the offline-scanning module**: the `AuditForm`
component (`app/components/audit-form.tsx`) writes straight to local
PowerSync SQLite — same offline-safe path `/scan` already uses — and is
embedded both on the scan page (record an audit right after scanning an
asset) and the asset detail page. A technician grading a pallet of returned
laptops with zero signal in a warehouse is exactly the scenario PowerSync was
chosen for in the first place. Because PowerSync writes bypass the NestJS
service layer (they land via a generic CRUD tunnel — see
`powersync.service.ts`), the same side effects an online audit submission
gets (denormalizing onto the asset, logging an `audited` history event) are
replicated there in `applyAuditSideEffects`, so an audit recorded offline
behaves identically once synced, not just eventually-consistent data.

## Batches and lots

Two more levels above the individual asset, matching how ITAD/warehouse
receiving actually works: a **`Batch`** is one intake event (e.g. "50 laptops
from Acme Corp, received 2026-07-09"), and an optional **`Lot`** is a
sub-grouping within a batch (e.g. "Lot A: 20 Grade-A units for resale").
Both get an auto-generated, standardized number (`BATCH-000001`,
`LOT-000001`, via Postgres sequences) rather than a user-typed code — one
less way to create a duplicate.

The critical design choice: **`actualUnitCount` is never stored.** It's
always a live `COUNT(*)` of assets pointing at that batch/lot (see
`BatchesService.withCounts`), computed fresh on every read. Storing it as a
denormalized counter would let it drift from reality the first time a
scan failed to update it; a live count physically cannot drift. This is what
gets reconciled against `expectedUnitCount` (the manifest/declared number) —
`/batches/:id` shows both side by side and flags short/over discrepancies.

**Receiving ties directly into `/scan`**: pick an open batch from the
dropdown at the top of the scan page, and every subsequent scan — camera or
keyboard, online or offline — also links that asset to the batch
(`UPDATE assets SET batch_id = ?`) and updates a live local count. This is
the same local-PowerSync-write pattern as everything else on that page;
`batches`/`lots` sync down as read-only reference data so the dropdown works
with zero signal, same as the batch selector needing to function in a
warehouse with no connectivity.

Every module from the original plan is now scaffolded and running end to
end: auth, inventory (CRUD + barcode/QR + offline sync + ITAD audit trail +
batch/lot receiving), reporting/notifications, user management, and Android
access via installable PWA. Verified live in this environment — Postgres
migrated, seeded, both dev servers up, login/assets/audits/batches/notifications
confirmed against the real API (including a full create-batch →
assign-assets → reconcile round trip). Two real bugs were caught and fixed
during this verification, not just typos: `BatchesService` and
`AssetsService.findOne` were both returning a joined `User` relation
(`receivedBy` / `owner`) with `passwordHash` still attached — fixed with a
shared `sanitizeUser()` util (`apps/api/src/users/sanitize-user.ts`) so the
same class of leak can't silently reappear in a future module that joins a
User relation. What's explicitly NOT built, flagged honestly rather than
silently skipped:
- Physical label-printer integration (ZPL/thermal output) — browser print only
- Image upload for assets — `imageUrl` is a plain text field, no file upload UI
- Email delivery for alerts — notifications are in-app only, no SMTP wired up
- Scheduled/recurring reports — CSV export is on-demand only
- Password reset / self-service account management for end users
- A "real" native Android app (React Native / Kotlin) — the PWA route was
  chosen deliberately because it reuses everything already built and could
  be verified by a clean build in this environment; a native app would be a
  separate codebase this repo doesn't contain
- The actual phone-install/camera-scan flow (as opposed to the rest of the
  app) is still untested on a real device — that needs the HTTPS tunnel step
  documented above, which requires you to run it on your own machine.
