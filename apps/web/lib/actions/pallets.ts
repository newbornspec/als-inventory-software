'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-server';
import type { ActionState } from './assets';

// 'merged' is terminal and set only by merging — it is deliberately absent
// from the status dropdown, and the API rejects any attempt to set it directly.
export type PalletStatus = 'open' | 'ready' | 'shipped' | 'merged';

export interface PalletLine {
  id: string;
  palletId: string;
  // Server-composed display label ("Dell · P2419H · 24\" · Frameless · Stand").
  // Not edited directly any more — it is rebuilt from the fields below.
  variant: string;
  manufacturer: string | null;
  model: string | null;
  size: string | null;
  variantType: string | null;
  // true = Yes, false = No, null = not recorded.
  stand: boolean | null;
  tier: string | null;
  quantity: number;
  grade: string | null;
  unitCost: number | null;
  productId: string | null;
  createdAt: string;
  // Where this item came from, if it arrived by a merge. pallet_id is where it
  // IS; this is where it CAME FROM. The number is a snapshot, so it survives
  // deletion of the original.
  sourcePalletId?: string | null;
  sourcePalletNumber?: string | null;
  // Loaded on the pallet detail endpoint so the Layout 2 grid can rebuild rows.
  product?: {
    manufacturer: string | null;
    model: string | null;
    chassis: string | null;
    cpu: string | null;
    gen: string | null;
    ramGb: number | null;
    storage: string | null;
  } | null;
}

// A device row on an asset pallet's detail page — the API projects it (never
// the raw entity), so this mirrors PalletAssetRow on the server.
export interface PalletAssetRow {
  id: string;
  unitId: string | null;
  tag: string;
  name: string;
  // Per-device configuration from the capture tool's hardware profile —
  // null where a device was hand-entered without a capture.
  manufacturer: string | null;
  model: string | null;
  deviceType: string | null;
  serialNumber: string | null;
  cpu: string | null;
  ramGb: number | null;
  storage: string | null;
  screenSize: string | null;
  batteryHealth: string | null;
  conditionGrade: string | null;
  auditStatus: string | null;
  movedToPalletAt: string | null;
  movedToPalletByName: string | null;
  // Set when the device sold WITH the pallet (the link stays as the shipped
  // manifest). An open pallet never shows sold rows.
  soldAt: string | null;
  salePrice: number | null;
}

export interface Pallet {
  id: string;
  palletNumber: string;
  description: string | null;
  supplier: string | null;
  buyer: string | null;
  locationId: string | null;
  status: PalletStatus;
  notes: string | null;
  shippedAt: string | null;
  entryLayout?: string; // 'variant' | 'spec' | 'asset' — what this pallet holds
  // Present on the detail endpoint for entryLayout='asset' pallets: the
  // serialized devices allocated to it. [] / absent everywhere else.
  assets?: PalletAssetRow[];
  // Stamped by the database when the pallet is created. The API has always sent
  // it and ordered by it; this type simply never declared it, so the Pallets
  // page could not show a Created column.
  createdAt: string;
  totalQuantity: number;
  lineCount: number;
  location?: { id: string; name: string } | null;
  lines?: PalletLine[];

  // --- merge history (detail endpoint only) ---------------------------------
  // Read from the merge EVENT, not from the lines: derive it from the lines and
  // a source disappears the moment its last contributed line is sold.
  mergedFrom?: {
    id: string | null; // null once the original is deleted; the number remains
    palletNumber: string;
    units: number;
    lines: number;
    mergedAt: string;
  }[];
  // Set on a pallet that was itself merged away — where its stock went.
  mergedInto?: { id: string; palletNumber: string; mergedAt: string } | null;
  // What a merged pallet contributed, as it now sits on its successor. This is
  // the historical record the original still shows once its stock has moved.
  contributedLines?: PalletLine[];
}

export interface MergeCandidate {
  id: string;
  palletNumber: string;
  status: string;
  entryLayout: string | null;
  totalQuantity: number;
  lineCount: number;
}

export interface MergePreview {
  sources: MergeCandidate[];
  blockers: string[];
}

export async function createPallet(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const dto = {
    palletNumber: str(formData.get('palletNumber')),
    description: str(formData.get('description')),
    supplier: str(formData.get('supplier')),
    buyer: str(formData.get('buyer')),
    locationId: str(formData.get('locationId')),
    notes: str(formData.get('notes')),
  };
  let created: Pallet;
  try {
    created = await apiFetch<Pallet>('/pallets', { method: 'POST', body: JSON.stringify(dto) });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to create pallet.' };
  }
  revalidatePath('/pallets');
  redirect(`/pallets/${created.id}`);
}

export interface SpecRow {
  manufacturer?: string;
  model?: string;
  chassis?: string;
  cpu?: string;
  gen?: string;
  ram?: string;
  storage?: string;
  quantity: number;
}

// Layout 2: picking the layout creates the pallet right away — number
// generated, empty grid. The pallet page then opens straight into the editor.
export async function createEmptySpecPallet(): Promise<{ id?: string; error?: string }> {
  try {
    const created = await apiFetch<Pallet>('/pallets/spec', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    revalidatePath('/pallets');
    return { id: created.id };
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to create pallet.' };
  }
}

// Layout 2 editor: one save replaces the pallet's metadata + all its rows with
// what's in the grid. Empty text fields clear the stored value (null).
export async function savePalletSpec(
  id: string,
  input: {
    description?: string;
    supplier?: string;
    buyer?: string;
    locationId?: string;
    notes?: string;
    rows: SpecRow[];
  },
): Promise<{ pallet?: Pallet; error?: string }> {
  const rows = input.rows
    .filter((r) => [r.manufacturer, r.model, r.chassis, r.cpu, r.gen, r.ram, r.storage].some((v) => v?.trim()) || r.quantity > 0)
    .map((r) => ({ ...r, quantity: Math.max(0, Math.trunc(r.quantity) || 0) }));
  const clean = (s?: string) => (s && s.trim() ? s.trim() : null);
  try {
    // Returns the fresh pallet (lines + products) so the grid editor can
    // re-link its rows to the recreated lines after a save.
    const pallet = await apiFetch<Pallet>(`/pallets/${id}/spec`, {
      method: 'PUT',
      body: JSON.stringify({
        description: clean(input.description),
        supplier: clean(input.supplier),
        buyer: clean(input.buyer),
        locationId: clean(input.locationId),
        notes: clean(input.notes),
        rows,
      }),
    });
    revalidatePath(`/pallets/${id}`);
    revalidatePath('/pallets');
    return { pallet };
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to save pallet.' };
  }
}

export async function updatePalletStatus(id: string, formData: FormData): Promise<void> {
  const status = String(formData.get('status') ?? '');
  await apiFetch(`/pallets/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
  revalidatePath(`/pallets/${id}`);
  revalidatePath('/pallets');
}

export async function updatePalletSupplier(id: string, formData: FormData): Promise<void> {
  const supplier = String(formData.get('supplier') ?? '').trim();
  await apiFetch(`/pallets/${id}`, { method: 'PATCH', body: JSON.stringify({ supplier }) });
  revalidatePath(`/pallets/${id}`);
  revalidatePath('/pallets');
}

export async function updatePalletBuyer(id: string, formData: FormData): Promise<void> {
  const buyer = String(formData.get('buyer') ?? '').trim();
  await apiFetch(`/pallets/${id}`, { method: 'PATCH', body: JSON.stringify({ buyer }) });
  revalidatePath(`/pallets/${id}`);
  revalidatePath('/pallets');
}

export async function deletePallet(id: string): Promise<void> {
  try {
    await apiFetch(`/pallets/${id}`, { method: 'DELETE' });
  } catch (err) {
    // Already deleted (e.g. double-click, or removed in another tab)? The goal
    // is already met — go to the list rather than crashing. Re-throw anything else.
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  revalidatePath('/pallets');
  redirect('/pallets');
}

// Bulk results report per-pallet failures BY NUMBER, not id — the operator
// reads pallet numbers, and a partial failure ("2 of 5 refused: not empty")
// must say which two without a lookup.
export interface BulkPalletResult {
  done: number;
  failed: { palletNumber: string; error: string }[];
}

// Change status on a selection, one PATCH per pallet — the same endpoint and
// permission as the single-row change; a selection is just a bigger hand.
// Each failure (e.g. a merged pallet, which PATCH rejects by design) is
// collected rather than aborting the rest.
export async function setPalletsStatus(
  pallets: { id: string; palletNumber: string }[],
  status: string,
): Promise<BulkPalletResult> {
  const failed: BulkPalletResult['failed'] = [];
  let done = 0;
  for (const p of pallets) {
    try {
      await apiFetch(`/pallets/${p.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      done += 1;
    } catch (err) {
      failed.push({
        palletNumber: p.palletNumber,
        error: err instanceof ApiError ? err.message : 'Failed to update.',
      });
    }
  }
  revalidatePath('/pallets');
  return { done, failed };
}

// Bulk delete. The server refuses a pallet that still holds lines or devices
// (that is the delete guard, not an error in the UI) — those come back in
// `failed` with the server's own explanation.
export async function deletePallets(
  pallets: { id: string; palletNumber: string }[],
): Promise<BulkPalletResult> {
  const failed: BulkPalletResult['failed'] = [];
  let done = 0;
  for (const p of pallets) {
    try {
      await apiFetch(`/pallets/${p.id}`, { method: 'DELETE' });
      done += 1;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        done += 1; // already gone — the goal is met
        continue;
      }
      failed.push({
        palletNumber: p.palletNumber,
        error: err instanceof ApiError ? err.message : 'Failed to delete.',
      });
    }
  }
  revalidatePath('/pallets');
  return { done, failed };
}

// One row of the Layout 1 table. Every field optional so an edit can send just
// the one that changed — the API recomposes the display label from the merged
// row, so a partial patch never blanks the rest.
export interface PalletLinePatch {
  manufacturer?: string | null;
  model?: string | null;
  size?: string | null;
  variantType?: string | null;
  stand?: boolean | null;
  quantity?: number;
  grade?: string | null;
  unitCost?: number | null;
  tier?: string | null;
}

// Blank strings mean "not set" and must reach the API as null, not "" — an
// empty string would fail @IsIn on variantType and store '' as a manufacturer.
function clean(patch: PalletLinePatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = typeof v === 'string' && v.trim() === '' ? null : v;
  }
  if (typeof out.quantity === 'number') {
    out.quantity = Math.max(0, Math.trunc(out.quantity) || 0);
  }
  return out;
}

// The same label the API composes, computed here as well so a create still
// works against an API that has not deployed yet. The web and the API ship on
// one push but build separately, so there is a window where this page is live
// and the old API is still up — and its DTO still requires `variant`, which
// this page no longer sends. Without this, adding a line 400s for those few
// minutes. The new API prefers a supplied variant, so the value is identical
// either way.
function composeVariantLabel(p: PalletLinePatch): string {
  return (
    [
      p.manufacturer,
      p.model,
      p.size,
      p.variantType ? p.variantType.replace(/\b\w/g, (c) => c.toUpperCase()) : '',
      p.stand === true ? 'Stand' : p.stand === false ? 'No stand' : '',
    ]
      .map((x) => (x ?? '').trim())
      .filter(Boolean)
      .join(' · ') || 'Unspecified'
  );
}

export async function addPalletLine(
  palletId: string,
  patch: PalletLinePatch,
): Promise<{ error?: string }> {
  try {
    await apiFetch(`/pallets/${palletId}/lines`, {
      method: 'POST',
      body: JSON.stringify({ ...clean(patch), variant: composeVariantLabel(patch) }),
    });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to add line.' };
  }
  revalidatePath(`/pallets/${palletId}`);
  revalidatePath('/pallets');
  return {};
}

export async function updatePalletLine(
  palletId: string,
  lineId: string,
  patch: PalletLinePatch,
): Promise<void> {
  await apiFetch(`/pallets/${palletId}/lines/${lineId}`, {
    method: 'PATCH',
    body: JSON.stringify(clean(patch)),
  });
  revalidatePath(`/pallets/${palletId}`);
  revalidatePath('/pallets');
}

// The suggested number for a new pallet. The operator can overwrite it; a blank
// field falls back to the same sequence server-side.
export async function getNextPalletNumber(): Promise<string> {
  try {
    const r = await apiFetch<{ palletNumber: string }>('/pallets/next-number');
    return r.palletNumber;
  } catch {
    return '';
  }
}

export async function deletePalletLine(palletId: string, lineId: string): Promise<void> {
  try {
    await apiFetch(`/pallets/${palletId}/lines/${lineId}`, { method: 'DELETE' });
  } catch (err) {
    // Already gone? That's the desired end state. Anything else (e.g. an expired
    // session -> 401) propagates so the caller can show it instead of failing silently.
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  revalidatePath(`/pallets/${palletId}`);
  revalidatePath('/pallets');
}

// What merging this selection would do, and why it can't if it can't. Called
// when the dialog opens so the confirmation states real numbers and the button
// is disabled with a reason rather than failing on submit.
export async function previewMerge(palletIds: string[]): Promise<MergePreview> {
  try {
    return await apiFetch<MergePreview>('/pallets/merge/preview', {
      method: 'POST',
      body: JSON.stringify({ palletIds }),
    });
  } catch (err) {
    return {
      sources: [],
      blockers: [err instanceof ApiError ? err.message : 'Could not check these pallets.'],
    };
  }
}

// Merge the selected pallets onto a new one. Returns the new pallet's number on
// success so the caller can say where the stock went; the merge itself is
// atomic server-side.
export async function mergePallets(
  palletIds: string[],
  opts: { palletNumber?: string; description?: string; locationId?: string } = {},
): Promise<{ ok: true; pallet: Pallet } | { ok: false; error: string }> {
  try {
    // Blank fields are omitted rather than sent as '': the DTO validates
    // palletNumber's shape when present, and an empty string would fail it
    // instead of falling back to the sequence.
    const body: Record<string, unknown> = { palletIds };
    for (const [k, v] of Object.entries(opts)) {
      const trimmed = typeof v === 'string' ? v.trim() : v;
      if (trimmed) body[k] = trimmed;
    }
    const pallet = await apiFetch<Pallet>('/pallets/merge', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    revalidatePath('/pallets');
    revalidatePath('/inventory');
    for (const id of palletIds) revalidatePath(`/pallets/${id}`);
    return { ok: true, pallet };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof ApiError ? err.message : 'The merge could not be completed.',
    };
  }
}

function str(value: FormDataEntryValue | null): string | undefined {
  const s = String(value ?? '').trim();
  return s === '' ? undefined : s;
}

// --- Goods In allocation (Move to Pallet) ---

export interface MoveResult {
  error: string | null;
  moved: number;
  palletNumber?: string;
  skipped?: { id: string; reason: string }[];
}

// Move selected devices onto an asset pallet — creating the destination first
// when asked (the API numbers it from the sequence). Two calls, not a
// transaction: if the move half fails the new pallet exists but is empty,
// which is visible and harmless rather than half-allocated.
export async function moveAssetsToPallet(
  target: { palletId?: string; createNew?: boolean },
  assetIds: string[],
): Promise<MoveResult> {
  try {
    let palletId = target.palletId;
    if (!palletId) {
      const created = await apiFetch<Pallet>('/pallets', {
        method: 'POST',
        body: JSON.stringify({ entryLayout: 'asset' }),
      });
      palletId = created.id;
    }
    const result = await apiFetch<{ moved: number; skipped: { id: string; reason: string }[] }>(
      `/pallets/${palletId}/assets`,
      { method: 'POST', body: JSON.stringify({ assetIds }) },
    );
    const pallet = await apiFetch<Pallet>(`/pallets/${palletId}`);
    revalidatePath('/batches');
    revalidatePath('/pallets');
    revalidatePath(`/pallets/${palletId}`);
    return {
      error: null,
      moved: result.moved,
      skipped: result.skipped,
      palletNumber: pallet.palletNumber,
    };
  } catch (err) {
    return {
      error: err instanceof ApiError ? err.message : 'Could not move the devices.',
      moved: 0,
    };
  }
}

// Batch-level transfer: new auto-numbered pallet, every eligible device from
// the lot. Redirects to the new pallet on success (the spec's "show the newly
// created pallet"), so only failures ever return to the caller.
export async function transferBatchToPallet(
  batchId: string,
): Promise<{ error: string } | never> {
  let palletId: string;
  try {
    const result = await apiFetch<{ palletId: string; palletNumber: string; moved: number }>(
      '/pallets/transfer-batch',
      { method: 'POST', body: JSON.stringify({ batchId }) },
    );
    palletId = result.palletId;
  } catch (err) {
    return {
      error: err instanceof ApiError ? err.message : 'Could not transfer the batch.',
    };
  }
  revalidatePath('/batches');
  revalidatePath('/pallets');
  redirect(`/pallets/${palletId}`);
}

// The reverse: back into each device's lot pool. Admin-grade per the client's
// correction — the pallet owns its devices; the optional reason lands on the
// device's history line.
export async function removeAssetsFromPallet(
  assetIds: string[],
  palletId: string,
  reason?: string,
): Promise<{ error: string | null; removed: number }> {
  try {
    const result = await apiFetch<{ removed: number }>('/pallets/assets/remove', {
      method: 'POST',
      body: JSON.stringify({ assetIds, reason }),
    });
    revalidatePath('/batches');
    revalidatePath('/pallets');
    revalidatePath(`/pallets/${palletId}`);
    return { error: null, removed: result.removed };
  } catch (err) {
    return {
      error: err instanceof ApiError ? err.message : 'Could not remove the devices.',
      removed: 0,
    };
  }
}
