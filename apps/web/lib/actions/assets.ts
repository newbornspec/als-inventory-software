'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-server';

export interface Asset {
  id: string;
  tag: string;
  name: string;
  category: string;
  stockStatus: string;
  conditionGrade: string | null;
  auditStatus: string | null;
  locationId: string | null;
  ownerId: string | null;
  imageUrl: string | null;
  purchaseCost: number | null;
  batchId: string | null;
  lotId: string | null;
  updatedAt: string;
  location?: { id: string; name: string } | null;
  // Auto-captured hardware audit (Phase 4). hardwareProfile is only present on
  // the detail fetch (select:false on the server); it's an open-ended document.
  serialNumber?: string | null;
  expressServiceCode?: string | null;
  deviceType?: string | null;
  hardwareProfile?: Record<string, unknown> | null;
}

export interface ActionState {
  error: string | null;
}

export async function createAsset(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const dto = {
    tag: String(formData.get('tag') ?? '').trim(),
    name: String(formData.get('name') ?? '').trim(),
    category: String(formData.get('category') ?? '').trim(),
    stockStatus: String(formData.get('stockStatus') ?? 'received'),
    conditionGrade: emptyToUndefined(formData.get('conditionGrade')),
    locationId: emptyToUndefined(formData.get('locationId')),
  };

  if (!dto.tag || !dto.name || !dto.category) {
    return { error: 'Tag, name, and category are required.' };
  }

  let created: Asset;
  try {
    created = await apiFetch<Asset>('/assets', { method: 'POST', body: JSON.stringify(dto) });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to create asset.' };
  }

  revalidatePath('/assets');
  redirect(`/assets/${created.id}`);
}

export async function updateAsset(
  id: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const dto = {
    name: String(formData.get('name') ?? '').trim(),
    category: String(formData.get('category') ?? '').trim(),
    stockStatus: String(formData.get('stockStatus') ?? ''),
    conditionGrade: emptyToUndefined(formData.get('conditionGrade')),
    locationId: emptyToUndefined(formData.get('locationId')),
    purchaseCost: toNumberOrUndefined(formData.get('purchaseCost')),
  };

  try {
    await apiFetch(`/assets/${id}`, { method: 'PATCH', body: JSON.stringify(dto) });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to update asset.' };
  }

  revalidatePath('/assets');
  revalidatePath(`/assets/${id}`);
  return { error: null };
}

// Manually add a device into a lot. Routes through the SAME endpoint the capture
// tool uses (/devices/hardware-audit with an explicit lotId), so a hand-entered
// device is identical to an audited one: it lands in the lot, gets a hardware
// profile + audit record, and shows in lists, search, reports and totals.
export async function addManualAsset(
  batchId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const s = (k: string) => {
    const v = String(formData.get(k) ?? '').trim();
    return v === '' ? undefined : v;
  };
  const ramRaw = String(formData.get('ramGb') ?? '').trim();
  const ramGb = ramRaw === '' ? undefined : parseInt(ramRaw, 10);

  if (!s('manufacturer') && !s('model') && !s('serialNumber')) {
    return { error: 'Enter at least a manufacturer, model, or serial number.' };
  }

  const ident: Record<string, string> = {};
  for (const k of ['manufacturer', 'model', 'deviceType', 'serialNumber'] as const) {
    const v = s(k);
    if (v) ident[k] = v;
  }
  const profile: Record<string, unknown> = {};
  if (Object.keys(ident).length) profile.identification = ident;
  if (s('cpu')) profile.cpu = { model: s('cpu') };
  if (ramGb != null && !Number.isNaN(ramGb)) profile.memory = { totalGb: ramGb };
  if (s('storage')) profile.storage = [{ capacity: s('storage') }];
  if (s('screenSize')) profile.display = { size: s('screenSize') };
  if (s('batteryHealth')) profile.battery = { health: s('batteryHealth') };

  try {
    await apiFetch('/devices/hardware-audit', {
      method: 'POST',
      body: JSON.stringify({ lotId: batchId, manual: true, notes: s('notes'), profile }),
    });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to add asset.' };
  }

  revalidatePath(`/batches/${batchId}`);
  revalidatePath('/assets');
  return { error: null };
}

export async function deleteAsset(id: string): Promise<void> {
  try {
    await apiFetch(`/assets/${id}`, { method: 'DELETE' });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  revalidatePath('/assets');
  redirect('/assets');
}

function emptyToUndefined(value: FormDataEntryValue | null): string | undefined {
  const str = String(value ?? '').trim();
  return str === '' ? undefined : str;
}

function toNumberOrUndefined(value: FormDataEntryValue | null): number | undefined {
  const str = String(value ?? '').trim();
  if (str === '') return undefined;
  const n = parseFloat(str);
  return Number.isNaN(n) ? undefined : n;
}
