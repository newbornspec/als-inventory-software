import type { PowerSyncBackendConnector, AbstractPowerSyncDatabase } from '@powersync/web';

async function fetchToken(): Promise<string> {
  const res = await fetch('/api/powersync/token');
  if (!res.ok) throw new Error('Not authenticated');
  const { token } = await res.json();
  return token;
}

export class ApiConnector implements PowerSyncBackendConnector {
  async fetchCredentials() {
    return {
      endpoint: process.env.NEXT_PUBLIC_POWERSYNC_URL!,
      token: await fetchToken(),
    };
  }

  // Drains PowerSync's local upload queue (the ps_crud table) and pushes the
  // batch to NestJS. Called automatically whenever the device is online and
  // has queued writes — including immediately after reconnecting from offline.
  async uploadData(database: AbstractPowerSyncDatabase) {
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) return;

    const batch = transaction.crud.map((op) => ({
      op: op.op,
      table: op.table,
      id: op.id,
      data: op.opData,
    }));

    const token = await fetchToken();
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/powersync/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ batch }),
    });

    if (!res.ok) {
      // Leave the transaction uncompleted — PowerSync will retry the same
      // batch on the next connectivity/upload trigger rather than losing it.
      throw new Error(`Upload failed: ${res.status}`);
    }

    await transaction.complete();
  }
}
