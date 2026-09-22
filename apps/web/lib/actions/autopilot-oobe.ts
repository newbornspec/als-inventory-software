'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-server';

// The first-boot OOBE check.
//
// Autopilot registration lives in Microsoft's cloud against the device's
// hardware hash. Nobody but the registering tenant can query it, so every
// check the audit station makes offline is evidence rather than proof - and on
// a wiped disk there is no evidence at all.
//
// The truth appears once, free, at the first boot after imaging: a registered
// device reaches OOBE, asks the service, and is shown the owning
// organisation's branded sign-in. The station is not running by then (it
// booted from the stick; the machine has since rebooted into Windows), so the
// observation has to be recorded here, afterwards, by the person who saw it.

export type OobeResult = 'organisation' | 'generic' | 'blocked';

export interface RecordOobeInput {
  result: OobeResult;
  organisation?: string;
  reason?: string;
  photographed?: boolean;
  note?: string;
}

export async function recordAutopilotOobe(
  assetId: string,
  input: RecordOobeInput,
): Promise<{ error?: string }> {
  try {
    await apiFetch(`/assets/${assetId}/autopilot-oobe`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  } catch (e) {
    if (e instanceof ApiError) return { error: e.message };
    return { error: 'Could not record the OOBE check.' };
  }
  revalidatePath(`/assets/${assetId}`);
  return {};
}
