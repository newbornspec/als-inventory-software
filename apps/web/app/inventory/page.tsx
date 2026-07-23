import Link from 'next/link';
import { apiFetch } from '@/lib/api-server';
import type { Batch } from '@/lib/actions/batches';
import type { Asset } from '@/lib/actions/assets';
import type { Pallet } from '@/lib/actions/pallets';
import type { StockLine } from '@/lib/actions/stock';
import { Nav } from '@/app/components/nav';

// A single roll-up of everything held, across all three inventory types —
// serialized devices (Assets), pallet quantities (Pallets) and bulk consumables
// (Consumables). It only reads the existing list endpoints and sums them; each
// section links out to its own detail page. Ownership scoping is inherited from
// those endpoints, so a manager sees only what they'd see on each page.
export default async function InventoryPage() {
  const [batches, unassigned, pallets, stock] = await Promise.all([
    apiFetch<Batch[]>('/batches').catch(() => [] as Batch[]),
    apiFetch<Asset[]>('/assets?noBatch=true').catch(() => [] as Asset[]),
    apiFetch<Pallet[]>('/pallets').catch(() => [] as Pallet[]),
    apiFetch<StockLine[]>('/stock').catch(() => [] as StockLine[]),
  ]);

  const heldPallets = pallets.filter((p) => p.status !== 'shipped');
  const shippedCount = pallets.length - heldPallets.length;

  const serializedUnits =
    batches.reduce((s, b) => s + (b.actualUnitCount ?? 0), 0) + unassigned.length;
  const palletUnits = heldPallets.reduce((s, p) => s + (p.totalQuantity ?? 0), 0);
  const consumableUnits = stock.reduce((s, x) => s + (x.quantity ?? 0), 0);
  const grandTotal = serializedUnits + palletUnits + consumableUnits;

  const num = (n: number) => n.toLocaleString('en-GB');

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">All Inventory</h1>
            <p className="mt-1 text-sm text-neutral-400">
              Everything you hold, across all three inventory types. Each section links to its own
              page for the detail.
            </p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-semibold tabular-nums">{num(grandTotal)}</div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">total units held</div>
          </div>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <StatTile label="Serialized devices" units={serializedUnits} sub={`${batches.length} lots`} href="/assets" />
          <StatTile
            label="Pallet stock"
            units={palletUnits}
            sub={`${heldPallets.length} pallets${shippedCount ? ` · ${shippedCount} shipped` : ''}`}
            href="/pallets"
          />
          <StatTile label="Consumables" units={consumableUnits} sub={`${stock.length} items`} href="/stock" />
        </div>

        {/* Serialized devices — grouped by purchase lot, mirroring the Assets page. */}
        <Section title="Serialized devices" units={serializedUnits} href="/assets" hint="one row per unit">
          <Table head={['Lot', 'Supplier', 'Units']} empty="No serialized devices yet.">
            {[...batches]
              .sort((a, b) => (b.actualUnitCount ?? 0) - (a.actualUnitCount ?? 0))
              .map((b) => (
                <Row key={b.id} href={`/batches/${b.id}`} cells={[b.batchNumber, b.source || '—']} units={b.actualUnitCount ?? 0} />
              ))}
            {unassigned.length > 0 && (
              <Row href="/assets?noBatch=true" cells={['Unassigned', 'No lot']} units={unassigned.length} muted />
            )}
          </Table>
        </Section>

        {/* Pallet stock — counted quantities by variant, not individual rows. */}
        <Section title="Pallet stock" units={palletUnits} href="/pallets" hint="counted by variant">
          <Table head={['Pallet', 'Description', 'Variants', 'Units']} empty="No active pallets.">
            {[...heldPallets]
              .sort((a, b) => (b.totalQuantity ?? 0) - (a.totalQuantity ?? 0))
              .map((p) => (
                <Row
                  key={p.id}
                  href={`/pallets/${p.id}`}
                  cells={[p.palletNumber, p.description || '—', String(p.lineCount)]}
                  units={p.totalQuantity ?? 0}
                />
              ))}
          </Table>
        </Section>

        {/* Bulk consumables — SKU + count. */}
        <Section title="Consumables" units={consumableUnits} href="/stock" hint="counted by SKU">
          <Table head={['Item', 'SKU', 'On hand']} empty="No consumables yet.">
            {[...stock]
              .sort((a, b) => (b.quantity ?? 0) - (a.quantity ?? 0))
              .map((s) => (
                <Row key={s.id} href={`/stock/${s.id}`} cells={[s.name, s.sku || '—']} units={s.quantity ?? 0} />
              ))}
          </Table>
        </Section>
      </div>
    </main>
  );
}

function StatTile({ label, units, sub, href }: { label: string; units: number; sub: string; href: string }) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4 transition hover:border-neutral-600"
    >
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{units.toLocaleString('en-GB')}</div>
      <div className="mt-0.5 text-xs text-neutral-500">{sub}</div>
    </Link>
  );
}

function Section({
  title,
  units,
  href,
  hint,
  children,
}: {
  title: string;
  units: number;
  href: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-neutral-300">
          {title}
          <span className="ml-2 text-neutral-500">· {units.toLocaleString('en-GB')} units</span>
          <span className="ml-2 text-xs text-neutral-600">({hint})</span>
        </h2>
        <Link href={href} className="shrink-0 text-sm text-neutral-400 hover:text-neutral-200">
          View all →
        </Link>
      </div>
      {children}
    </section>
  );
}

function Table({ head, empty, children }: { head: string[]; empty: string; children: React.ReactNode }) {
  const rows = Array.isArray(children) ? children.flat().filter(Boolean) : children;
  const isEmpty = Array.isArray(rows) && rows.length === 0;
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full text-left text-sm">
        <thead className="bg-neutral-900 text-neutral-400">
          <tr>
            {head.map((h, i) => (
              <th key={h} className={`px-4 py-3 ${i === head.length - 1 ? 'text-right' : ''}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {isEmpty ? (
            <tr>
              <td colSpan={head.length} className="px-4 py-8 text-center text-neutral-500">
                {empty}
              </td>
            </tr>
          ) : (
            rows
          )}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  href,
  cells,
  units,
  muted,
}: {
  href: string;
  cells: string[];
  units: number;
  muted?: boolean;
}) {
  return (
    <tr className="border-t border-neutral-800 hover:bg-neutral-900">
      {cells.map((c, i) => (
        <td key={i} className={`px-4 py-3 ${i === 0 ? '' : 'text-neutral-400'}`}>
          {i === 0 ? (
            <Link href={href} className={`underline ${muted ? 'text-neutral-400' : 'text-neutral-100'}`}>
              {c}
            </Link>
          ) : (
            c
          )}
        </td>
      ))}
      <td className="px-4 py-3 text-right font-medium tabular-nums">{units.toLocaleString('en-GB')}</td>
    </tr>
  );
}
