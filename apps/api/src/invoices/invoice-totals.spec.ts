import { calculateTotals } from './invoice-totals';

// The whole point of this module is that the printed lines add up to the
// printed total on a VAT document. Floats do not guarantee that, so these tests
// pin the arithmetic rather than the implementation.

const line = (quantity: number, unitPrice: number | null) => ({ quantity, unitPrice });

describe('calculateTotals', () => {
  it('multiplies quantity by unit price per line', () => {
    const t = calculateTotals({
      lines: [line(4, 12.5), line(34, 10)],
      vatRegistered: false,
    });
    expect(t.lineTotals).toEqual([50, 340]);
    expect(t.subtotal).toBe(390);
  });

  it('adds no VAT when the business is not registered', () => {
    const t = calculateTotals({
      lines: [line(10, 10)],
      vatRegistered: false,
      // A rate present but unused: "not registered" must win, or a stale rate
      // left in the form would silently tax the customer.
      vatRate: 20,
    });
    expect(t.vatAmount).toBe(0);
    expect(t.total).toBe(100);
  });

  it('never assumes a rate when registered but none was given', () => {
    const t = calculateTotals({ lines: [line(10, 10)], vatRegistered: true, vatRate: null });
    expect(t.vatAmount).toBe(0);
    expect(t.total).toBe(100);
  });

  it('applies the given rate', () => {
    const t = calculateTotals({ lines: [line(10, 10)], vatRegistered: true, vatRate: 20 });
    expect(t.subtotal).toBe(100);
    expect(t.vatAmount).toBe(20);
    expect(t.total).toBe(120);
  });

  it('handles a fractional rate', () => {
    const t = calculateTotals({ lines: [line(1, 100)], vatRegistered: true, vatRate: 17.5 });
    expect(t.vatAmount).toBe(17.5);
    expect(t.total).toBe(117.5);
  });

  it('produces an exact subtotal on values floats get wrong', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754. Summed in pence it is exact.
    const t = calculateTotals({
      lines: [line(1, 0.1), line(1, 0.2)],
      vatRegistered: false,
    });
    expect(t.subtotal).toBe(0.3);
  });

  it('reconciles only when summed in pence — which is why the PDF prints the stored subtotal', () => {
    const t = calculateTotals({
      lines: [line(1, 0.1), line(1, 0.2)],
      vatRegistered: false,
    });
    // Adding the returned decimals back up reintroduces the float error...
    const naive = t.lineTotals.reduce((s, x) => (s as number) + (x ?? 0), 0) as number;
    expect(naive).not.toBe(t.subtotal);
    // ...so any consumer must reconcile in pence, never by re-summing decimals.
    const inPence = t.lineTotals.reduce(
      (s, x) => (s as number) + Math.round((x ?? 0) * 100),
      0,
    ) as number;
    expect(inPence).toBe(Math.round(t.subtotal * 100));
  });

  it('keeps subtotal + VAT === total for a long awkward invoice', () => {
    const lines = Array.from({ length: 97 }, (_, i) => line((i % 7) + 1, 0.01 * ((i % 13) + 1)));
    const t = calculateTotals({ lines, vatRegistered: true, vatRate: 20 });
    const summed = t.lineTotals.reduce((s, x) => (s as number) + (x ?? 0), 0) as number;
    // Compare in pence: the printed figures must reconcile exactly.
    expect(Math.round(summed * 100)).toBe(Math.round(t.subtotal * 100));
    expect(Math.round(t.subtotal * 100) + Math.round(t.vatAmount * 100)).toBe(
      Math.round(t.total * 100),
    );
  });

  it('rounds VAT half away from zero', () => {
    // 1.11 x 5 = 5.55 subtotal; 20% = 1.11 exactly.
    expect(calculateTotals({ lines: [line(5, 1.11)], vatRegistered: true, vatRate: 20 }).vatAmount)
      .toBe(1.11);
    // 0.03 subtotal at 17.5% = 0.00525 -> 0.01 (not 0.00).
    expect(calculateTotals({ lines: [line(3, 0.01)], vatRegistered: true, vatRate: 17.5 }).vatAmount)
      .toBe(0.01);
  });

  it('shows unpriced lines without inventing a zero', () => {
    const t = calculateTotals({
      lines: [line(4, 12.5), line(47, null)],
      vatRegistered: false,
    });
    expect(t.lineTotals).toEqual([50, null]);
    expect(t.subtotal).toBe(50);
  });

  it('treats a zero-quantity line as contributing nothing', () => {
    const t = calculateTotals({ lines: [line(0, 25)], vatRegistered: false });
    expect(t.lineTotals).toEqual([0]);
    expect(t.total).toBe(0);
  });

  it('survives an empty pallet', () => {
    const t = calculateTotals({ lines: [], vatRegistered: true, vatRate: 20 });
    expect(t).toMatchObject({ subtotal: 0, vatAmount: 0, total: 0 });
  });
});
