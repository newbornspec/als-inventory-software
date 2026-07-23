'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-server';
import type { ActionState } from './assets';

export interface Batch {
  id: string;
  batchNumber: string;
  source: string | null; // supplier the lot was purchased from
  locationId: string | null;
  receivedDate: string | null;
  purchaseOrder: string | null;
  deliveryNote: string | null;
  purchaseDate: string | null;
  expectedUnitCount: number | null;
  totalCost: number | null;
  status: string;
  notes: string | null;
  actualUnitCount: number;
  readyForSale: number;
  scrap: number;
  quarantine: number;
  audited: number;
  createdAt: string;
  location?: { id: string; name: string } | null;
  receivedBy?: { id: string; name: string } | null;
}

export interface Lot {
  id: string;
  lotNumber: string;
  batchId: string | null;
  description: string | null;
  manufacturer: string | null;
  model: string | null;
  cpu: string | null;
  ramGb: number | null;
  storage: string | null;
  screenSize: string | null;
  expectedUnitCount: number | null;
  status: string;
  notes: string | null;
  actualUnitCount: number;
}

export interface ExpectedLineItem {
  id: string;
  batchId: string;
  assetTag: string | null;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  cpu: string | null;
  ramGb: number | null;
  storage: string | null;
  screenSize: string | null;
  condition: string | null;
  grade: string | null;
  quantity: number;
  verificationStatus: string;
  createdAt: string;
}

// The parsed-and-mapped rows the client sends up from a supplier file.
export type ExpectedLineItemInput = Partial<
  Omit<ExpectedLineItem, 'id' | 'batchId' | 'verificationStatus' | 'createdAt'>
>;

export interface ReconciliationResult {
  summary: {
    expectedSerialized: number;
    found: number;
    missing: number;
    extra: number;
    scanned: number;
    quantityOnlyLines: number;
  };
  lines: {
    expected: ExpectedLineItem;
    status: 'found' | 'missing';
    matchedAssetId: string | null;
    matchedTag: string | null;
  }[];
  extras: { id: string; tag: string; name: string }[];
  quantityOnly: ExpectedLineItem[];
}

export async function createBatch(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const dto = {
    source: emptyToUndefined(formData.get('source')),
    locationId: emptyToUndefined(formData.get('locationId')),
    receivedDate: emptyToUndefined(formData.get('receivedDate')),
    purchaseOrder: emptyToUndefined(formData.get('purchaseOrder')),
    deliveryNote: emptyToUndefined(formData.get('deliveryNote')),
    purchaseDate: emptyToUndefined(formData.get('purchaseDate')),
    expectedUnitCount: toIntOrUndefined(formData.get('expectedUnitCount')),
    // A newly created purchase lot is expected but not yet physically received.
    status: emptyToUndefined(formData.get('status')) ?? 'awaiting_arrival',
    notes: emptyToUndefined(formData.get('notes')),
  };

  let created: Batch;
  try {
    created = await apiFetch<Batch>('/batches', { method: 'POST', body: JSON.stringify(dto) });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to create purchase lot.' };
  }

  revalidatePath('/batches');
  redirect(`/batches/${created.id}`);
}

export async function updateBatchStatus(id: string, formData: FormData): Promise<void> {
  const status = String(formData.get('status') ?? '');
  await apiFetch(`/batches/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
  revalidatePath(`/batches/${id}`);
  revalidatePath('/batches');
}

export async function updateBatchCost(id: string, formData: FormData): Promise<void> {
  const raw = String(formData.get('totalCost') ?? '').trim();
  const totalCost = raw === '' ? undefined : parseFloat(raw);
  await apiFetch(`/batches/${id}`, { method: 'PATCH', body: JSON.stringify({ totalCost }) });
  revalidatePath(`/batches/${id}`);
  revalidatePath('/batches');
  revalidatePath('/reports');
}

export async function createLot(
  batchId: string | undefined,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const dto = {
    batchId,
    description: emptyToUndefined(formData.get('description')),
    manufacturer: emptyToUndefined(formData.get('manufacturer')),
    model: emptyToUndefined(formData.get('model')),
    cpu: emptyToUndefined(formData.get('cpu')),
    ramGb: toIntOrUndefined(formData.get('ramGb')),
    storage: emptyToUndefined(formData.get('storage')),
    screenSize: emptyToUndefined(formData.get('screenSize')),
    expectedUnitCount: toIntOrUndefined(formData.get('expectedUnitCount')),
    notes: emptyToUndefined(formData.get('notes')),
  };

  try {
    await apiFetch('/lots', { method: 'POST', body: JSON.stringify(dto) });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to create sub-lot.' };
  }

  if (batchId) revalidatePath(`/batches/${batchId}`);
  revalidatePath('/batches');
  return { error: null };
}

// Delete a sub-lot. Its assets are automatically returned to the parent lot
// (asset.lot_id FK is ON DELETE SET NULL) — they are never deleted.
export async function deleteSubLot(lotId: string, batchId: string): Promise<void> {
  await apiFetch(`/lots/${lotId}`, { method: 'DELETE' });
  revalidatePath(`/batches/${batchId}`);
  revalidatePath('/assets');
}

// Assign (or clear, with lotId=null) a device's sub-lot. The device already lives
// in the parent purchase lot; this groups it into one of that lot's sub-lots.
export async function assignSubLot(
  assetId: string,
  lotId: string | null,
  batchId: string,
): Promise<void> {
  await apiFetch(`/assets/${assetId}`, {
    method: 'PATCH',
    body: JSON.stringify({ lotId }),
  });
  revalidatePath(`/batches/${batchId}`);
  revalidatePath('/assets');
}

// Move a device to a different purchase lot. Clears its sub-lot too, since a
// sub-lot belongs to the old lot. Revalidates both lots' pages.
export async function moveAssetToBatch(
  assetId: string,
  targetBatchId: string,
  currentBatchId: string,
): Promise<{ error?: string }> {
  try {
    await apiFetch(`/assets/${assetId}`, {
      method: 'PATCH',
      body: JSON.stringify({ batchId: targetBatchId, lotId: null }),
    });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Could not move the asset.' };
  }
  revalidatePath(`/batches/${currentBatchId}`);
  revalidatePath(`/batches/${targetBatchId}`);
  revalidatePath('/assets');
  return {};
}

// Delete a device from within its lot view (admin only; API enforces the role).
// Stays on the lot page rather than redirecting like the global deleteAsset.
export async function deleteAssetFromLot(
  assetId: string,
  batchId: string,
): Promise<{ error?: string }> {
  try {
    await apiFetch(`/assets/${assetId}`, { method: 'DELETE' });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) {
      return { error: err instanceof ApiError ? err.message : 'Could not delete the asset.' };
    }
  }
  revalidatePath(`/batches/${batchId}`);
  revalidatePath('/assets');
  return {};
}

// Bulk import of a parsed supplier list — replaces the lot's expected inventory.
export async function importExpectedLineItems(
  batchId: string,
  items: ExpectedLineItemInput[],
): Promise<{ count?: number; error?: string }> {
  try {
    const created = await apiFetch<ExpectedLineItem[]>(`/batches/${batchId}/expected/import`, {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
    revalidatePath(`/batches/${batchId}`);
    return { count: created.length };
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Import failed.' };
  }
}

function emptyToUndefined(value: FormDataEntryValue | null): string | undefined {
  const str = String(value ?? '').trim();
  return str === '' ? undefined : str;
}

function toIntOrUndefined(value: FormDataEntryValue | null): number | undefined {
  const str = emptyToUndefined(value);
  if (str === undefined) return undefined;
  const n = parseInt(str, 10);
  return Number.isNaN(n) ? undefined : n;
}
