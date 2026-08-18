// Invoice arithmetic, in integer pence.
//
// Money is numeric(12,2) in Postgres but arrives in JS as an ordinary float
// (common/numeric.transformer parseFloats it), and there is no decimal library
// in this project. Doing VAT in floats produces invoices whose printed lines do
// not add up to the printed total — 0.1 + 0.2 is the classic case, and a
// customer noticing a penny discrepancy on a VAT document is a real problem.
//
// So: convert to pence at the boundary, keep every line total and the subtotal
// as exact integer arithmetic, and round EXACTLY ONCE, on the VAT multiply.
// Rounding each line's VAT instead would let the sum of the lines disagree with
// the VAT shown, which is the bug this ordering exists to prevent.

export interface TotalsInput {
  lines: Array<{ quantity: number; unitPrice: number | null }>;
  vatRegistered: boolean;
  /** Percent, as a person states it: 20 means 20%. Ignored unless registered. */
  vatRate?: number | null;
}

export interface Totals {
  /** Per-line totals in the same order as the input, null where unpriced. */
  lineTotals: Array<number | null>;
  subtotal: number;
  vatAmount: number;
  total: number;
}

/** £12.345 -> 1234 pence. Half away from zero, so 0.005 rounds up not down. */
function toPence(amount: number): number {
  return Math.round(amount * 100);
}

function fromPence(pence: number): number {
  return pence / 100;
}

// NOTE FOR CONSUMERS: do not re-sum `lineTotals` in floats to check the
// subtotal — 0.1 + 0.2 gives 0.30000000000000004 and will disagree with the
// exact figure returned here. Print the returned subtotal, or reconcile in
// pence. The spec pins this behaviour.
export function calculateTotals(input: TotalsInput): Totals {
  const lineTotals: Array<number | null> = [];
  let subtotalPence = 0;

  for (const line of input.lines) {
    if (line.unitPrice == null) {
      // Unpriced lines still appear on the invoice — they just contribute
      // nothing. Treating them as zero would print a misleading £0.00.
      lineTotals.push(null);
      continue;
    }
    const qty = Math.max(0, Math.trunc(line.quantity) || 0);
    // Integer x integer: exact, no rounding needed or wanted here.
    const linePence = toPence(line.unitPrice) * qty;
    subtotalPence += linePence;
    lineTotals.push(fromPence(linePence));
  }

  // No rate is applied unless the business says it is registered AND gives a
  // rate. Nothing defaults to 20%.
  const rate = input.vatRegistered ? (input.vatRate ?? null) : null;
  const vatPence =
    rate != null && rate > 0 ? Math.round((subtotalPence * rate) / 100) : 0;

  return {
    lineTotals,
    subtotal: fromPence(subtotalPence),
    vatAmount: fromPence(vatPence),
    total: fromPence(subtotalPence + vatPence),
  };
}
