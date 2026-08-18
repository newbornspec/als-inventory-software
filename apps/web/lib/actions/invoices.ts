'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-server';

export interface InvoiceLine {
  manufacturer: string | null;
  model: string | null;
  size: string | null;
  variantType: string | null;
  stand: boolean | null;
  grade: string | null;
  quantity: number;
  unitPrice: number | null;
  lineTotal: number | null;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  palletId: string | null;
  palletNumber: string;
  buyerName: string;
  buyerAddress1: string | null;
  buyerAddress2: string | null;
  buyerCity: string | null;
  buyerPostcode: string | null;
  buyerCountry: string | null;
  vatRegistered: boolean;
  vatNumber: string | null;
  vatRate: number | null;
  subtotal: number;
  vatAmount: number;
  total: number;
  lines: InvoiceLine[];
  notes: string | null;
  createdAt: string;
}

// Per-field errors, keyed by input name. The app's shared ActionState carries a
// single error string, which is all every other form needed; an invoice has
// enough fields that one line at the bottom cannot say WHICH one is wrong.
export interface InvoiceFormState {
  error: string | null;
  fieldErrors: Record<string, string>;
  invoiceId?: string;
  invoiceNumber?: string;
}

export async function getNextInvoiceNumber(): Promise<string> {
  try {
    const r = await apiFetch<{ invoiceNumber: string }>('/invoices/next-number');
    return r.invoiceNumber;
  } catch {
    return '';
  }
}

export async function getPalletInvoices(palletId: string): Promise<Invoice[]> {
  try {
    return await apiFetch<Invoice[]>(`/pallets/${palletId}/invoices`);
  } catch {
    return [];
  }
}

const str = (v: FormDataEntryValue | null): string => (typeof v === 'string' ? v.trim() : '');

// Maps the API's class-validator messages back onto the field they belong to.
// The API is the authority on what is valid; this only decides where to SHOW
// what it said, so the two can never disagree about the rules themselves.
const FIELD_HINTS: Array<[RegExp, string]> = [
  [/buyer name/i, 'buyerName'],
  [/registration number/i, 'vatNumber'],
  [/vat rate/i, 'vatRate'],
  [/invoice date/i, 'invoiceDate'],
  [/vat registered/i, 'vatRegistered'],
];

export async function createInvoice(
  palletId: string,
  _prev: InvoiceFormState,
  formData: FormData,
): Promise<InvoiceFormState> {
  const vatRegistered = str(formData.get('vatRegistered')) === 'yes';
  const rateRaw = str(formData.get('vatRate'));

  // Client-side checks first, so the obvious mistakes are named next to the
  // field without a round trip. The API repeats all of them — this is for
  // speed and clarity, never the only line of defence.
  const fieldErrors: Record<string, string> = {};
  if (!str(formData.get('buyerName'))) {
    fieldErrors.buyerName = 'Enter the buyer’s name.';
  }
  if (vatRegistered) {
    if (!str(formData.get('vatNumber'))) {
      fieldErrors.vatNumber = 'Enter your VAT registration number.';
    }
    if (!rateRaw) {
      fieldErrors.vatRate = 'Enter the VAT rate.';
    } else {
      const rate = Number(rateRaw);
      if (Number.isNaN(rate)) fieldErrors.vatRate = 'VAT rate must be a number.';
      else if (rate < 0) fieldErrors.vatRate = 'VAT rate cannot be negative.';
      else if (rate > 100) fieldErrors.vatRate = 'VAT rate cannot be more than 100%.';
    }
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: null, fieldErrors };
  }

  const dto = {
    buyerName: str(formData.get('buyerName')),
    buyerAddress1: str(formData.get('buyerAddress1')) || undefined,
    buyerAddress2: str(formData.get('buyerAddress2')) || undefined,
    buyerCity: str(formData.get('buyerCity')) || undefined,
    buyerPostcode: str(formData.get('buyerPostcode')) || undefined,
    buyerCountry: str(formData.get('buyerCountry')) || undefined,
    vatRegistered,
    // Sent only when registered: an unused rate left in the form must never
    // reach the invoice.
    vatNumber: vatRegistered ? str(formData.get('vatNumber')) : undefined,
    vatRate: vatRegistered && rateRaw ? Number(rateRaw) : undefined,
    invoiceDate: str(formData.get('invoiceDate')) || undefined,
    notes: str(formData.get('notes')) || undefined,
  };

  let created: Invoice;
  try {
    created = await apiFetch<Invoice>(`/pallets/${palletId}/invoices`, {
      method: 'POST',
      body: JSON.stringify(dto),
    });
  } catch (err) {
    const message = err instanceof ApiError ? err.message : 'Could not create the invoice.';
    // class-validator returns one message per broken rule; put each beside its
    // own field where the text identifies one.
    const parts = message.split(/,(?![^(]*\))/).map((m) => m.trim());
    const mapped: Record<string, string> = {};
    for (const part of parts) {
      const hit = FIELD_HINTS.find(([re]) => re.test(part));
      if (hit) mapped[hit[1]] = part;
    }
    return {
      error: Object.keys(mapped).length ? null : message,
      fieldErrors: mapped,
    };
  }

  revalidatePath(`/pallets/${palletId}`);
  return {
    error: null,
    fieldErrors: {},
    invoiceId: created.id,
    invoiceNumber: created.invoiceNumber,
  };
}
