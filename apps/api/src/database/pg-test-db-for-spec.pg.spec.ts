import { DataSource } from 'typeorm';
import { openPgTestDatabase, pgTestPort } from './pg-test-db-for-spec';

// The helper every *.pg.spec.ts opens its database through, under the one
// condition that broke CI: several jest workers creating the test database at
// the same instant. On ubuntu-latest the workers start close enough together
// that two CREATE DATABASE collide, and Postgres reports that as 23505 on
// pg_database's own unique index - not 42P04, the only code the helper used to
// accept - so 15 specs failed on one lost race. Locally the workers start
// staggered and it never showed, so this forces the collision in one process.
//
// Uses its own database name (ALS_PG_TEST_DB is read per call) so dropping it
// cannot disturb the shared test database other spec files are using.
const maybe = pgTestPort ? describe : describe.skip;

const NAME = 'als_inventory_race_test';

const maintenance = () =>
  new DataSource({
    type: 'postgres',
    host: process.env.ALS_PG_TEST_HOST ?? 'localhost',
    port: parseInt(pgTestPort ?? '5432', 10),
    username: process.env.ALS_PG_TEST_USER ?? 'als_inventory',
    password: process.env.ALS_PG_TEST_PASSWORD ?? 'als_inventory_ci',
    database: 'postgres',
    extra: { max: 1 },
  });

async function dropDatabase(name: string): Promise<void> {
  const admin = maintenance();
  await admin.initialize();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.destroy();
  }
}

maybe('the Postgres spec helper under workers starting together', () => {
  let saved: string | undefined;

  beforeAll(async () => {
    saved = process.env.ALS_PG_TEST_DB;
    process.env.ALS_PG_TEST_DB = NAME;
    await dropDatabase(NAME);
  }, 60_000);

  afterAll(async () => {
    if (saved === undefined) delete process.env.ALS_PG_TEST_DB;
    else process.env.ALS_PG_TEST_DB = saved;
    await dropDatabase(NAME);
  }, 60_000);

  it('racing CREATE DATABASE fails with 42P04 or 23505 - both must mean "already made"', async () => {
    const probe = 'als_inventory_race_probe_test';
    await dropDatabase(probe);
    const admins = Array.from({ length: 6 }, maintenance);
    await Promise.all(admins.map((a) => a.initialize()));
    try {
      const outcomes = await Promise.all(
        admins.map((a) =>
          a.query(`CREATE DATABASE "${probe}"`).then(
            () => 'created',
            (e: { code?: string }) => e.code ?? 'unknown',
          ),
        ),
      );
      expect(outcomes.filter((o) => o === 'created')).toHaveLength(1);
      for (const o of outcomes.filter((x) => x !== 'created')) {
        expect(['42P04', '23505']).toContain(o);
      }
    } finally {
      await Promise.all(admins.map((a) => a.destroy()));
      await dropDatabase(probe);
    }
  }, 60_000);

  it('six workers opening a missing test database at once all get it', async () => {
    const opened = await Promise.all(
      Array.from({ length: 6 }, () => openPgTestDatabase()),
    );
    try {
      for (const ds of opened) {
        const rows: { n: number }[] = await ds.query('SELECT 1 AS n');
        expect(rows[0].n).toBe(1);
      }
    } finally {
      await Promise.all(opened.map((ds) => ds.destroy()));
    }
  }, 240_000);
});
