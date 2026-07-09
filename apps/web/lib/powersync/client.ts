import { PowerSyncDatabase } from '@powersync/web';
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
    db = new PowerSyncDatabase({
      database: { dbFilename: 'als-inventory.db' },
      schema: AppSchema,
    });
    db.connect(new ApiConnector());
  }
  return db;
}
