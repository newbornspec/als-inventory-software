'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-server';
import type { Asset } from '@/lib/actions/assets';

export interface TransferResult {
  error?: string;
  moved?: number;
  // Tags typed in that matched no device, so the operator can see exactly which
  // ones to check rather than being told "some failed".
  notFound?: string[];
}

function msg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// Move serialized devices to another location.
//
// This does NOT need a new endpoint: PATCH /assets/:id with a locationId already
// writes an AssetEventType.TRANSFERRED row to the device's history
// (assets.service.ts), so the audit trail has existed all along — what was
// missing is a way to move more than one device without opening each in turn.
//
// Devices are resolved by TAG because that is what is printed on the label in
// the operator's hand. A tag that matches nothing is reported back rather than
// silently skipped.
export async function transferDevices(
  _prev: TransferResult,
  formData: FormData,
): Promise<TransferResult> {
  const toLocationId = String(formData.get('toLocationId') ?? '').trim();
  if (!toLocationId) return { error: 'Choose a destination location.' };

  const tags = String(formData.get('tags') ?? '')
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tags.length === 0) return { error: 'Scan or type at least one device tag.' };

  const notFound: string[] = [];
  const ids: string[] = [];

  for (const tag of tags) {
    try {
      const matches = await apiFetch<Asset[]>(`/assets?search=${encodeURIComponent(tag)}`);
      // Exact tag or unit id only. A search for "DELL" would otherwise move
      // every Dell in the warehouse.
      const exact = matches.find((a) => a.tag === tag || a.unitId === tag);
      if (exact) ids.push(exact.id);
      else notFound.push(tag);
    } catch {
      notFound.push(tag);
    }
  }

  if (ids.length === 0) {
    return { error: 'None of those tags matched a device.', notFound };
  }

  let moved = 0;
  for (const id of ids) {
    try {
      await apiFetch(`/assets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ locationId: toLocationId }),
      });
      moved += 1;
    } catch (err) {
      return {
        error: `Moved ${moved} of ${ids.length}, then: ${msg(err, 'the move failed.')}`,
        moved,
        notFound,
      };
    }
  }

  revalidatePath('/assets');
  revalidatePath('/dashboard');
  revalidatePath('/inventory');
  return { moved, notFound };
}

// Move consumable quantity between locations. Unlike a device, a stock line IS
// (item, location), so the API splits the quantity across two lines rather than
// relocating one — see StockService.transfer.
export async function transferStock(
  _prev: TransferResult,
  formData: FormData,
): Promise<TransferResult> {
  const stockLineId = String(formData.get('stockLineId') ?? '').trim();
  const toLocationId = String(formData.get('toLocationId') ?? '').trim();
  const quantity = parseInt(String(formData.get('quantity') ?? ''), 10);

  if (!stockLineId) return { error: 'Choose an item to move.' };
  if (!toLocationId) return { error: 'Choose a destination location.' };
  if (!Number.isFinite(quantity) || quantity < 1) {
    return { error: 'Enter how many to move.' };
  }

  try {
    await apiFetch(`/stock/${stockLineId}/transfer`, {
      method: 'POST',
      body: JSON.stringify({
        toLocationId,
        quantity,
        note: String(formData.get('note') ?? '').trim() || undefined,
      }),
    });
  } catch (err) {
    return { error: msg(err, 'Failed to move that stock.') };
  }

  revalidatePath('/stock');
  revalidatePath(`/stock/${stockLineId}`);
  revalidatePath('/dashboard');
  revalidatePath('/inventory');
  return { moved: quantity };
}
