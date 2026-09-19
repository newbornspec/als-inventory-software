import * as path from 'node:path';
import { DataSource } from 'typeorm';
import { ALL_ENTITIES } from './entities';

// The database the *.pg.spec.ts files run against: a DEDICATED test
// database on the Postgres server named by ALS_PG_TEST_PORT, created and
// migrated here - never the app's own database. Not a spec itself (jest runs
// only *.spec.ts); the name ends in "spec.ts" so tsconfig.build.json keeps it
// out of dist.
//
// Why: these specs do things no real database may see. The certificate spec
// switches the insert-only trigger off, deletes every certificate and leaves
// rows signed with a throwaway key behind; a certificate the app issues later
// on the same database chains onto those rows and its public check answers
// "invalid". A review ran them against the app's dev database exactly that
// way. So the database name must end in "_test" (ALS_PG_TEST_DB, default
// als_inventory_test) and anything else is refused before connecting.
//
//   docker run -d --name als-api-pg -e POSTGRES_USER=als_inventory \
//     -e POSTGRES_PASSWORD=als_inventory_ci -e POSTGRES_DB=als_inventory \
//     -p 55437:5432 postgres:16
//   ALS_PG_TEST_PORT=55437 npx jest pg.spec
//
// The user needs CREATEDB (the image's POSTGRES_USER is a superuser, as is
// CI's service container). Migrations run here, under an advisory lock, so
// two spec files starting together in separate jest workers neither race to
// create the database nor apply a migration twice.

export const pgTestPort = process.env.ALS_PG_TEST_PORT;

export function pgTestDatabaseName(
  env: Record<string, string | undefined> = process.env,
): string {
  const name = env.ALS_PG_TEST_DB?.trim() || 'als_inventory_test';
  if (!/^[a-z0-9_]+_test$/.test(name))
    throw new Error(
      `ALS_PG_TEST_DB must be a dedicated test database whose name ends in "_test" (got "${name}"): the Postgres specs delete and forge rows`,
    );
  return name;
}

const connection = (database: string, max = 10) => ({
  type: 'postgres' as const,
  host: process.env.ALS_PG_TEST_HOST ?? 'localhost',
  port: parseInt(pgTestPort ?? '5432', 10),
  username: process.env.ALS_PG_TEST_USER ?? 'als_inventory',
  password: process.env.ALS_PG_TEST_PASSWORD ?? 'als_inventory_ci',
  database,
  extra: { max },
});

// Two int4 keys for pg_advisory_lock; distinct from the app's own pairs
// (0x414c53 + n in certificate-ledger.ts).
const LOCK_TEST_DB = [0x414c54, 1] as const;

export async function openPgTestDatabase(): Promise<DataSource> {
  const database = pgTestDatabaseName();

  // Create it if missing, from the server's maintenance database.
  const admin = new DataSource({ ...connection('postgres', 1) });
  await admin.initialize();
  try {
    const found: unknown[] = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [database],
    );
    if (!found.length) {
      try {
        await admin.query(`CREATE DATABASE "${database}"`);
      } catch (e) {
        // Another jest worker created it first.
        if ((e as { code?: string }).code !== '42P04') throw e;
      }
    }
  } finally {
    await admin.destroy();
  }

  const ds = new DataSource({
    ...connection(database),
    entities: ALL_ENTITIES,
    migrations: [path.join(__dirname, 'migrations', '*.ts')],
    synchronize: false,
  });
  await ds.initialize();
  const lock = ds.createQueryRunner();
  await lock.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1, $2)', [...LOCK_TEST_DB]);
    await ds.runMigrations({ transaction: 'each' });
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1, $2)', [...LOCK_TEST_DB]);
    await lock.release();
  }
  return ds;
}
