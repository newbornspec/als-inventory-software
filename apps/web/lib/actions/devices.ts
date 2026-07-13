'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api-server';

export interface AuditTarget {
  batchId: string;
  batchNumber: string;
}

// Sets the lot the capture tool will file hardware audits into (per user).
export async function setAuditLot(batchId: string): Promise<void> {
  await apiFetch('/devices/active-lot', { method: 'POST', body: JSON.stringify({ batchId }) });
  revalidatePath('/batches');
}
