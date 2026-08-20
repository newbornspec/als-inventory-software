'use client';

import { useActionState, useMemo, useState } from 'react';
import Link from 'next/link';
import { createInvoice, type InvoiceFormState } from '@/lib/actions/invoices';
import type { PalletLine } from '@/lib/actions/pallets';
import { money } from '@/lib/money';
import { formatLabel } from '@/lib/asset-options';

// Everything the invoice needs, collected before it is raised, so the PDF never
// has to be edited afterwards.

const EMPTY: InvoiceFormState = { error: null, fieldErrors: {} };

// Mirrors the API's invoice-totals.ts. Kept in pence for the same reason: the
// printed lines have to add up to the printed total, and floats do not
// guarantee that. The server recomputes on save — this is the live preview.
function totalsInPence(lines: PalletLine[], vatRegistered: boolean, rate: number | null) {
  let subtotal = 0;
  const lineTotals = lines.map((l) => {
    if (l.unitCost == null) return null;
    const p = Math.round(l.unitCost * 100) * Math.max(0, Math.trunc(l.quantity) || 0);
    subtotal += p;
    return p;
  });
  const vat = vatRegistered && rate != null && rate > 0 ? Math.round((subtotal * rate) / 100) : 0;
  return { lineTotals, subtotal, vat, total: subtotal + vat };
}

export function InvoiceForm({
  palletId,
  palletNumber,
  lines,
  nextNumber,
  today,
}: {
  palletId: string;
  palletNumber: string;
  lines: PalletLine[];
  nextNumber: string;
  today: string;
}) {
  const action = createInvoice.bind(null, palletId);
  const [state, formAction, pending] = useActionState<InvoiceFormState, FormData>(action, EMPTY);

  const [vatRegistered, setVatRegistered] = useState(false);
  const [rate, setRate] = useState('');
  const [showPreview, setShowPreview] = useState(false);

  const rateNum = rate === '' ? null : Number(rate);
  const t = useMemo(
    () => totalsInPence(lines, vatRegistered, Number.isNaN(rateNum as number) ? null : rateNum),
    [lines, vatRegistered, rateNum],
  );

  const err = (name: string) => state.fieldErrors?.[name];
  const field = (name: string) =>
    'w-full rounded-md border bg-white px-3 py-2 text-sm outline-none ' +
    (err(name) ? 'border-red-400 focus:border-red-500' : 'border-neutral-200 focus:border-neutral-300');
  const Msg = ({ name }: { name: string }) =>
    err(name) ? <p className="mt-1 text-xs text-red-600">{err(name)}</p> : null;

  // Raised successfully: the number is spent and the invoice exists, so the
  // form is replaced rather than left in a state that invites a second submit.
  if (state.invoiceId) {
    return (
      <div className="mt-8 max-w-xl rounded-lg border border-emerald-200 bg-emerald-50 p-6">
        <h2 className="text-lg font-semibold text-emerald-900">
          {state.invoiceNumber} raised
        </h2>
        <p className="mt-1 text-sm text-emerald-800">
          Saved against {palletNumber}. This number is now used and will not be issued again.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <a
            href={`/api/invoices/${state.invoiceId}/pdf`}
            className="rounded-md bg-[#1a6ef5] px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600"
          >
            Download invoice PDF
          </a>
          <Link
            href={`/pallets/${palletId}`}
            className="text-sm text-neutral-600 hover:text-neutral-900"
          >
            Back to pallet
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} className="mt-8 space-y-8">
      {/* ---------------------------------------------------- invoice ---- */}
      <section>
        <h2 className="text-sm font-medium text-neutral-500">Invoice details</h2>
        <div className="mt-3 grid max-w-2xl gap-4 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-sm text-neutral-700">Invoice number</span>
            <input
              value={nextNumber || '—'}
              readOnly
              className="w-full rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700"
            />
            <span className="block text-xs text-neutral-500">
              Allocated automatically when you generate. If someone else invoices first, you get
              the next one after theirs.
            </span>
          </label>
          <label className="space-y-1">
            <span className="text-sm text-neutral-700">Invoice date</span>
            <input type="date" name="invoiceDate" defaultValue={today} className={field('invoiceDate')} />
            <Msg name="invoiceDate" />
          </label>
        </div>
      </section>

      {/* ------------------------------------------------------ buyer ---- */}
      <section>
        <h2 className="text-sm font-medium text-neutral-500">Buyer details</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Only the name is required; everything filled in appears on the invoice.
        </p>
        <div className="mt-3 grid max-w-2xl gap-4 sm:grid-cols-2">
          <label className="space-y-1 sm:col-span-2">
            <span className="text-sm text-neutral-700">
              Buyer name <span className="text-red-600">*</span>
            </span>
            <input name="buyerName" placeholder="e.g. Acme Refurb Ltd" className={field('buyerName')} />
            <Msg name="buyerName" />
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="text-sm text-neutral-700">Address line 1</span>
            <input name="buyerAddress1" className={field('buyerAddress1')} />
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="text-sm text-neutral-700">Address line 2</span>
            <input name="buyerAddress2" className={field('buyerAddress2')} />
          </label>
          <label className="space-y-1">
            <span className="text-sm text-neutral-700">City / town</span>
            <input name="buyerCity" className={field('buyerCity')} />
          </label>
          <label className="space-y-1">
            <span className="text-sm text-neutral-700">Postcode</span>
            <input name="buyerPostcode" className={field('buyerPostcode')} />
          </label>
          <label className="space-y-1">
            <span className="text-sm text-neutral-700">Country</span>
            <input name="buyerCountry" defaultValue="United Kingdom" className={field('buyerCountry')} />
          </label>
        </div>
      </section>

      {/* -------------------------------------------------------- VAT ---- */}
      <section>
        <h2 className="text-sm font-medium text-neutral-500">VAT details</h2>
        <div className="mt-3 max-w-2xl space-y-4">
          <fieldset className="space-y-1">
            <legend className="text-sm text-neutral-700">VAT registered</legend>
            <div className="mt-1 flex items-center gap-4">
              {[
                ['yes', 'Yes'],
                ['no', 'No'],
              ].map(([value, label]) => (
                <label key={value} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="vatRegistered"
                    value={value}
                    checked={vatRegistered === (value === 'yes')}
                    onChange={() => setVatRegistered(value === 'yes')}
                  />
                  {label}
                </label>
              ))}
            </div>
            <Msg name="vatRegistered" />
          </fieldset>

          {vatRegistered ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-sm text-neutral-700">
                  VAT registration number <span className="text-red-600">*</span>
                </span>
                <input name="vatNumber" placeholder="e.g. GB123456789" className={field('vatNumber')} />
                <Msg name="vatNumber" />
              </label>
              <label className="space-y-1">
                <span className="text-sm text-neutral-700">
                  VAT rate (%) <span className="text-red-600">*</span>
                </span>
                <input
                  name="vatRate"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  placeholder="e.g. 20"
                  className={field('vatRate')}
                />
                <Msg name="vatRate" />
              </label>
            </div>
          ) : (
            // Nothing is assumed when not registered: no rate is applied and the
            // invoice says so rather than silently showing a zero VAT line.
            <p className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
              Registration number and rate are not applicable. No VAT will be added, and the
              invoice will state that.
            </p>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------ items ---- */}
      <section>
        <h2 className="text-sm font-medium text-neutral-500">
          Invoice items — {palletNumber}
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Taken from the pallet as it stands. Edit the pallet to change them.
        </p>
        <div role="region" aria-label="Invoice items" tabIndex={0} className="mt-3 overflow-x-auto rounded-lg border border-neutral-200">
          <table className="w-full min-w-[52rem] text-left text-sm">
            <thead className="bg-neutral-50 text-neutral-500">
              <tr>
                <th className="px-3 py-2">Manufacturer</th>
                <th className="px-3 py-2">Model</th>
                <th className="px-3 py-2">Size</th>
                <th className="px-3 py-2">Variant</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">Price</th>
                <th className="px-3 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.id} className="border-t border-neutral-200">
                  <td className="px-3 py-2">{l.manufacturer ?? '—'}</td>
                  <td className="px-3 py-2">{l.model ?? '—'}</td>
                  <td className="px-3 py-2">{l.size ?? '—'}</td>
                  <td className="px-3 py-2">
                    {l.variantType ? formatLabel(l.variantType) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">{l.quantity}</td>
                  <td className="px-3 py-2 text-right">
                    {l.unitCost != null ? money(l.unitCost) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {t.lineTotals[i] != null ? money(t.lineTotals[i]! / 100) : '—'}
                  </td>
                </tr>
              ))}
              {lines.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-neutral-500">
                    This pallet has no items.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ----------------------------------------------------- totals ---- */}
      <section className="max-w-sm">
        <h2 className="text-sm font-medium text-neutral-500">Totals</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-neutral-600">Subtotal</dt>
            <dd className="font-medium">{money(t.subtotal / 100)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-neutral-600">
              {vatRegistered ? `VAT${rateNum ? ` @ ${rateNum}%` : ''}` : 'VAT (not registered)'}
            </dt>
            <dd className="font-medium">{vatRegistered ? money(t.vat / 100) : '—'}</dd>
          </div>
          <div className="flex justify-between border-t border-neutral-200 pt-2 text-base">
            <dt className="font-semibold">Total</dt>
            <dd className="font-semibold">{money(t.total / 100)}</dd>
          </div>
        </dl>
      </section>

      {state.error && (
        <p className="max-w-2xl text-sm text-red-600">{state.error}</p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setShowPreview((v) => !v)}
          className="rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        >
          {showPreview ? 'Hide preview' : 'Preview invoice'}
        </button>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-[#1a6ef5] px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
        >
          {pending ? 'Generating…' : 'Generate invoice'}
        </button>
        <span className="text-xs text-neutral-500">
          Generating uses the next invoice number permanently.
        </span>
      </div>

      {showPreview && <Preview palletNumber={palletNumber} nextNumber={nextNumber} t={t} vatRegistered={vatRegistered} rate={rateNum} />}
    </form>
  );
}

// A plain-text rendering of what the PDF will say, so the figures can be checked
// before a number is spent.
function Preview({
  palletNumber,
  nextNumber,
  t,
  vatRegistered,
  rate,
}: {
  palletNumber: string;
  nextNumber: string;
  t: { subtotal: number; vat: number; total: number };
  vatRegistered: boolean;
  rate: number | null;
}) {
  return (
    <pre className="max-w-2xl overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-700">
{`INVOICE            ${nextNumber || '(next available)'}
Pallet             ${palletNumber}

Subtotal           ${money(t.subtotal / 100)}
${vatRegistered ? `VAT @ ${rate ?? 0}%${' '.repeat(Math.max(1, 12 - String(rate ?? 0).length))}${money(t.vat / 100)}` : 'VAT                not registered — none charged'}
Total              ${money(t.total / 100)}`}
    </pre>
  );
}
