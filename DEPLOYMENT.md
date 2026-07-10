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

`powersync/sync-rules.yaml` is baked into `powersync/Dockerfile`. Changing which
tables/columns sync to offline clients requires **redeploying the angelic-charm
service** so it picks up the new rules — and any table referenced there must
already be in the Postgres `powersync` publication (added via a migration).
