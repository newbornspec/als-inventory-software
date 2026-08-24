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
  // When delivery is due — feeds the dashboard's incoming/overdue counts.
  expectedArrivalDate: string | null;
  expectedUnitCount: number | null;
  totalCost: number | null;
  status: string;
  notes: string | null;
  actualUnitCount: number;
  // Sold-inclusive. actualUnitCount omits sold devices, so a fully-sold lot reads
  // as 0 units — only this count is safe to show before a destructive action.
  totalUnitCount: number;
  // Still physically held: not sold, and also not shipped or disposed.
  // actualUnitCount keeps counting shipped and disposed devices on purpose —
  // it means "still part of this lot's story", so a dispatched lot does not
  // read "Missing 6" against its manifest. Anything headlined "held" wants
  // this one. Optional because web and API deploy independently; absent means
  // the API predates it and callers fall back to actualUnitCount.
  heldUnitCount?: number;
  // Real row counts, unrelated to the hand-typed expectedUnitCount below.
  subLotCount: number;
  expectedLineCount: number;
  // Optional: web and API deploy independently; absent means the API predates
  // the pool split and callers fall back to actualUnitCount.
  unallocatedCount?: number;
  readyForSale: number;
  scrap: number;
  quarantine: number;
  audited: number;
  createdAt: string;
  ownerId?: string | null;
  createdById?: string | null;
  location?: { id: string; name: string } | null;
  receivedBy?: { id: string; name: string } | null;
  owner?: { id: string; name: string } | null;
  createdBy?: { id: string; name: string } | null;
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
  // LIVE — sold devices excluded, matching Batch.actualUnitCount and the
  // /assets lists that fill the sub-lot's own table. Display this one.
  actualUnitCount: number;
  // Sold-inclusive; what a destructive action must be measured against.
  // Optional because web and API deploy independently — absent means the API
  // predates the split and callers fall back to actualUnitCount.
  totalUnitCount?: number;
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
    expectedArrivalDate: emptyToUndefined(formData.get('expectedArrivalDate')),
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

// Admin-only: hand a lot to a different owner. Ownership is an access axis, not
// a label — a scoped manager only sees lots they own — so a failure here has to
// be visible rather than swallowed.
export async function reassignBatchOwner(id: string, formData: FormData): Promise<ActionState> {
  const ownerId = String(formData.get('ownerId') ?? '').trim();
  if (!ownerId) return { error: null };
  try {
    await apiFetch(`/batches/${id}/owner`, {
      method: 'PATCH',
      body: JSON.stringify({ ownerId }),
    });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Could not reassign this lot.' };
  }
  revalidatePath(`/batches/${id}`);
  revalidatePath('/batches');
  return { error: null };
}

export async function updateBatchStatus(id: string, formData: FormData): Promise<ActionState> {
  const status = String(formData.get('status') ?? '');
  try {
    await apiFetch(`/batches/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Could not change the status.' };
  }
  revalidatePath(`/batches/${id}`);
  revalidatePath('/batches');
  return { error: null };
}

// Blank clears the date back to "no delivery promised", which is a meaningful
// state — such a lot is awaiting receipt but can never be counted as overdue.
export async function updateBatchExpectedArrival(
  id: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = String(formData.get('expectedArrivalDate') ?? '').trim();
  try {
    await apiFetch(`/batches/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedArrivalDate: raw === '' ? null : raw }),
    });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Could not save the arrival date.' };
  }
  revalidatePath(`/batches/${id}`);
  revalidatePath('/batches');
  revalidatePath('/dashboard');
  return { error: null };
}

// Blank clears the cost, the same way blanking the arrival date clears it above.
// It used to send `undefined`, which JSON.stringify drops from the body entirely
// — so emptying the field PATCHed `{}` and the old figure silently survived,
// with no way to remove a cost booked against the wrong consignment from a
// number that feeds margin reporting.
export async function updateBatchCost(
  id: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = String(formData.get('totalCost') ?? '').trim();
  const parsed = raw === '' ? null : parseFloat(raw);
  if (parsed !== null && (!isFinite(parsed) || parsed < 0)) {
    return { error: 'Enter a cost of 0 or more, or leave it blank.' };
  }
  try {
    await apiFetch(`/batches/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ totalCost: parsed }),
    });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Could not save the lot cost.' };
  }
  revalidatePath(`/batches/${id}`);
  revalidatePath('/batches');
  revalidatePath('/reports');
  return { error: null };
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
// Returns the failure rather than throwing: on the sub-lot page the success path
// navigates away, so without this a rejected delete left the operator on a page
// that looked exactly like a successful one.
export async function deleteSubLot(lotId: string, batchId: string): Promise<{ error?: string }> {
  try {
    await apiFetch(`/lots/${lotId}`, { method: 'DELETE' });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Could not delete this sub-lot.' };
  }
  revalidatePath(`/batches/${batchId}`);
  revalidatePath('/assets');
  return {};
}

// Assign (or clear, with lotId=null) a device's sub-lot. The device already lives
// in the parent purchase lot; this groups it into one of that lot's sub-lots.
// The <select> driving this is controlled, so a rejection re-renders it back to
// the old value — indistinguishable from a mis-click unless the error is
// returned and shown.
export async function assignSubLot(
  assetId: string,
  lotId: string | null,
  batchId: string,
): Promise<{ error?: string }> {
  try {
    await apiFetch(`/assets/${assetId}`, {
      method: 'PATCH',
      body: JSON.stringify({ lotId }),
    });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Could not change the sub-lot.' };
  }
  revalidatePath(`/batches/${batchId}`);
  revalidatePath('/assets');
  return {};
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

// Delete a whole lot and everything in it (admin only; the API enforces the
// role). Returns the error rather than redirecting, because the button lives in
// the lots list and needs to show a message in place instead of crashing the page.
export async function deleteBatch(id: string): Promise<{ error?: string }> {
  try {
    await apiFetch(`/batches/${id}`, { method: 'DELETE' });
  } catch (err) {
    // Already gone (double-click, or removed in another tab)? The goal is met.
    if (!(err instanceof ApiError && err.status === 404)) {
      return { error: err instanceof ApiError ? err.message : 'Could not delete the lot.' };
    }
  }
  revalidatePath('/batches');
  revalidatePath('/assets');
  revalidatePath('/inventory');
  revalidatePath('/reports');
  return {};
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
