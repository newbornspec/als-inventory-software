import { PowerSyncDatabase, WASQLiteOpenFactory } from '@powersync/web';
import { AppSchema } from './schema';
import { ApiConnector } from './connector';

// Singleton so the local SQLite connection (and its upload queue) survives
// across route navigations within the app — only created once, client-side.
let db: PowerSyncDatabase | null = null;

export function getPowerSyncDb(): PowerSyncDatabase {
  if (typeof window === 'undefined') {
    throw new Error('PowerSync can only be used in the browser');
  }
  if (!db) {
    // eslint-disable-next-line no-console
    console.log('[PowerSync] NEXT_PUBLIC_POWERSYNC_URL =', process.env.NEXT_PUBLIC_POWERSYNC_URL);
    db = new PowerSyncDatabase({
      // Worker paths point at files copied into public/@powersync by the
      // `postinstall: powersync-web copy-assets -o public` script — without
      // that script actually running, these paths 404 and the database
      // hangs silently waiting on a worker that was never there.
      database: new WASQLiteOpenFactory({
        dbFilename: 'als-inventory.db',
        worker: '/@powersync/worker/WASQLiteDB.umd.js',
      }),
      schema: AppSchema,
      sync: { worker: '/@powersync/worker/SharedSyncImplementation.umd.js' },
    });
    db.connect(new ApiConnector()).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[PowerSync] connect() failed:', err);
    });
  }
  return db;
}
