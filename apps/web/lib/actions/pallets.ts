'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-server';
import type { ActionState } from './assets';

export type PalletStatus = 'open' | 'ready' | 'shipped';

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
  entryLayout?: string; // 'variant' | 'spec' — which New Pallet layout made it
  // Stamped by the database when the pallet is created. The API has always sent
  // it and ordered by it; this type simply never declared it, so the Pallets
  // page could not show a Created column.
  createdAt: string;
  totalQuantity: number;
  lineCount: number;
  location?: { id: string; name: string } | null;
  lines?: PalletLine[];
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

function str(value: FormDataEntryValue | null): string | undefined {
  const s = String(value ?? '').trim();
  return s === '' ? undefined : s;
}
