# Deployment

## Services (Railway)

| Service | What it is | Deploys from |
|---|---|---|
| **als-inventory-software** | NestJS API | `master` (repo root) |
| **angelic-charm** | PowerSync sync service | `powersync/` (Dockerfile) |
| **postgres** (cube icon) | Self-hosted `postgres:16` with logical replication — the DB the app uses | Docker image |
| ~~Postgres~~ (elephant) | Old managed plugin, leftover — not used | — |
| **Vercel** | Next.js web app (`apps/web`) | `master` |

The database is on Railway's private network (`postgres.railway.internal`) and is
**not reachable from outside Railway**. Anything touching the DB (migrations,
psql) must run from inside the API service.

## Deploying

Push to `master`. Railway auto-builds the API; Vercel auto-builds the web app.

## Migrations run automatically (Pre-Deploy Command)

The API service has a **Pre-Deploy Command** configured in Railway:

```
cd apps/api && npm run migration:run
```

Railway runs this on the newly-built image **before** it replaces the running
version and takes traffic. So the schema is migrated while the old version is
still serving; if a migration fails, the deploy aborts and the old version keeps
running. `migration:run` only applies *pending* migrations, so it's a safe no-op
when there's nothing to do.

> **Why this matters — the ordering hazard.** TypeORM `SELECT`s every mapped
> column. If a deploy ships an entity with a new `@Column` *before* the matching
> migration adds that column, every query on that table 500s until the migration
> runs. This bit us once (Phase 0: `assets`/`lots`/`notifications` went down in
> the deploy→migrate gap). The Pre-Deploy Command closes that gap: code and
> schema always move together.

**This setting lives in the Railway dashboard**, not in the repo — a repo-level
`railway.json` was avoided so it can't accidentally apply to the PowerSync
service. To change or check it: `als-inventory-software` → Settings → Deploy →
Pre-Deploy Command.

### Manual fallback

If you ever need to run migrations by hand: `als-inventory-software` → **Console**:

```
cd apps/api && npm run migration:run
```

## PowerSync sync rules

`powersync/sync-rules.yaml` controls what each offline client caches in its local
SQLite. It is **baked into `powersync/Dockerfile`** (copied into the image), so
changing it requires **redeploying the angelic-charm service** — it does *not*
auto-deploy on a `git push`. Any table referenced must already be in the Postgres
`powersync` publication (added via a migration).

### Current design — per-user (owner) isolation

Mirrors the REST-side "managers-only" ownership isolation (see
`apps/api/src/common/ownership.ts`). Three buckets:

| Bucket | Who gets it | Contents |
|---|---|---|
| `reference` | everyone (global, no params) | `users` (id/name/role), `locations` |
| `owned_lots` | **managers** | `assets` / `lots` / `batches` for lots they own |
| `all_lots` | **admins + technicians** | `assets` / `lots` / `batches` for *all* lots |

Both role buckets are **parameterized by `batch_id`** so every data query
references its bucket parameter (a PowerSync requirement) — a manager's parameter
query selects only `batches WHERE owner_id = request.user_id()`; the admin/tech
one selects all, gated on `request.jwt() ->> 'role'`. This needs **no schema
denormalization** (`batches` already carries `owner_id`).

`asset_history` and `asset_audits` are **upload-only**: the offline scan/audit UI
only ever *writes* them (never reads), so they're in the client schema but in no
download bucket. Local writes still upload fine. The server-side write path also
enforces ownership — `PowerSyncService.assertManagerMayWrite` rejects a manager
uploading to a lot they don't own.

> Managers only see lots they own; admins/technicians see everything. Because
> buckets are additive (union), a manager must never be assigned the `all_lots`
> bucket — that's why the role gate lives in each parameter query.

### Redeploying after a rules change

1. Push the `powersync/sync-rules.yaml` change to `master` (it stays dormant).
2. Railway → **angelic-charm** service → newest deployment → **⋮ → Redeploy**.
3. Watch its **Logs** as it boots. Success looks like:
   - `Loaded sync config`
   - a `New checkpoint … buckets: N … param_results: […]` line listing the
     buckets a connected client resolved (e.g. `all_lots["<batch id>"]` for an
     admin, `reference[]` for the shared bucket).
   - **no** errors mentioning sync rules / buckets.
4. **Rollback:** revert the sync-rules commit and redeploy angelic-charm — the
   previous rules are always in git history.
