import { DataSource, QueryRunner } from 'typeorm';
import { openPgTestDatabase, pgTestPort } from './pg-test-db-for-spec';
import { AddUserIsStation1752660000000 } from './migrations/1752660000000-AddUserIsStation';

// A migration that ALTERs a table the live API reads on every request must
// give up quickly if it cannot get its lock (cross-check, wave 2).
//
// ALTER TABLE users needs a brief ACCESS EXCLUSIVE lock. With no lock
// timeout, a long transaction holding any lock on users (a report or export
// joining users) when Railway's pre-deploy runs makes the ALTER wait - and
// every later users query (login, the permissions guard) queues behind the
// waiting ALTER, stalling the still-serving old API until that transaction
// ends. With lock_timeout the migration fails fast instead, the deploy is
// refused (Railway keeps the old deployment serving) and can simply be
// retried.
//
// Runs only when ALS_PG_TEST_PORT names a Postgres server, on its own
// "_test" database (see pg-test-db-for-spec.ts):
//   ALS_PG_TEST_PORT=55433 npx jest migration-locks.pg

const maybe = pgTestPort ? describe : describe.skip;

maybe('migrations that alter users (Postgres)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await openPgTestDatabase();
  }, 60000);

  afterAll(async () => {
    await ds?.destroy();
  });

  async function inTransaction(): Promise<QueryRunner> {
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    return qr;
  }

  it('AddUserIsStation gives up within seconds when users is locked, instead of queueing every login behind it', async () => {
    const blocker = await inTransaction();
    const migration = await inTransaction();
    try {
      // What a long report holds on users for as long as it runs.
      await blocker.query('LOCK TABLE "users" IN ACCESS SHARE MODE');
      // The safety net for the test itself: without the migration's own
      // lock_timeout the ALTER would wait for as long as the blocker lives.
      await migration.query(`SET LOCAL statement_timeout = '20s'`);
      const started = Date.now();
      const err = await new AddUserIsStation1752660000000()
        .up(migration)
        .then(() => null)
        .catch((e: { code?: string; driverError?: { code?: string } }) => e);
      expect(err?.driverError?.code ?? err?.code).toBe('55P03'); // lock_not_available
      expect(Date.now() - started).toBeLessThan(15000);
    } finally {
      await migration.rollbackTransaction().catch(() => undefined);
      await migration.release();
      await blocker.rollbackTransaction().catch(() => undefined);
      await blocker.release();
    }
  }, 60000);

  it('AddUserIsStation still runs when nothing is in its way', async () => {
    const migration = await inTransaction();
    try {
      await new AddUserIsStation1752660000000().up(migration);
      const cols = (await migration.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'is_station'`,
      )) as unknown[];
      expect(cols).toHaveLength(1);
    } finally {
      await migration.rollbackTransaction();
      await migration.release();
    }
  });
});
