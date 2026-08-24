import Link from 'next/link';
import { Boxes, Layers, Package } from 'lucide-react';
import { apiFetch } from '@/lib/api-server';
import type { Batch } from '@/lib/actions/batches';
import type { Asset } from '@/lib/actions/assets';
import type { Pallet } from '@/lib/actions/pallets';
import type { StockLine } from '@/lib/actions/stock';
import { Nav } from '@/app/components/nav';
import { Breadcrumbs } from '@/app/components/breadcrumbs';

// A single roll-up of everything held, across all three inventory types —
// serialized devices (Assets), pallet quantities (Pallets) and bulk consumables
// (Consumables). It only reads the existing list endpoints and sums them; each
// section links out to its own detail page. Ownership scoping is inherited from
// those endpoints, so a manager sees only what they'd see on each page.
//
// The three tiers are not a presentation choice — they are how the warehouse
// actually counts. A serialized device is one row per physical unit; a pallet
// line is a quantity of an anonymous variant; a consumable is a count by SKU.
// Each section says which it is, so a reader never has to guess whether "412"
// means 412 rows or 412 things.

const TH =
  'px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-500';
const TD = 'px-4 py-3 text-left text-sm';

const num = (n: number) => n.toLocaleString('en-GB');

export default async function InventoryPage() {
  const [batches, unassigned, pallets, stock] = await Promise.all([
    apiFetch<Batch[]>('/batches').catch(() => [] as Batch[]),
    // held=true, not the bare list: the register's default only drops SOLD
    // devices, so a shipped or disposed unit with no lot would be counted as
    // held on a page whose headline is exactly that.
    apiFetch<Asset[]>('/assets?noBatch=true&held=true').catch(() => [] as Asset[]),
    apiFetch<Pallet[]>('/pallets').catch(() => [] as Pallet[]),
    apiFetch<StockLine[]>('/stock').catch(() => [] as StockLine[]),
  ]);

  // Merged pallets hold no stock — their lines moved to the pallet that
  // replaced them — so they are excluded alongside shipped ones. Counting them
  // as held would list ghost rows with zero units in the Pallet stock table.
  const heldPallets = pallets.filter(
    (p) => p.status !== 'shipped' && p.status !== 'merged',
  );
  const shippedCount = pallets.filter((p) => p.status === 'shipped').length;

  // heldUnitCount excludes shipped and disposed as well as sold; actualUnitCount
  // only excludes sold, because it answers a different question (see the type).
  // The ?? keeps this working against an API that predates the field.
  const heldOf = (b: Batch) => b.heldUnitCount ?? b.actualUnitCount ?? 0;
  const serializedUnits = batches.reduce((s, b) => s + heldOf(b), 0) + unassigned.length;
  // Devices that belonged to a lot and have since left the building. Both counts
  // already exclude sold, so the difference is exactly shipped + disposed.
  const goneFromLots = batches.reduce(
    (s, b) => s + Math.max(0, (b.actualUnitCount ?? 0) - heldOf(b)),
    0,
  );
  const palletUnits = heldPallets.reduce((s, p) => s + (p.totalQuantity ?? 0), 0);
  const consumableUnits = stock.reduce((s, x) => s + (x.quantity ?? 0), 0);
  const grandTotal = serializedUnits + palletUnits + consumableUnits;

  const lotRows = [...batches].sort((a, b) => heldOf(b) - heldOf(a));
  const palletRows = [...heldPallets].sort(
    (a, b) => (b.totalQuantity ?? 0) - (a.totalQuantity ?? 0),
  );
  const stockRows = [...stock].sort((a, b) => (b.quantity ?? 0) - (a.quantity ?? 0));

  return (
    <>
      <Nav />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-screen bg-neutral-50 text-neutral-950 px-4 py-6 sm:px-8 sm:py-8"
      >
        <div className="mx-auto max-w-[90rem]">
          <Breadcrumbs
            items={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Inventory' }]}
          />

          <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">All Inventory</h1>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-neutral-600">
                Everything you hold, across all three ways this warehouse counts stock. Each
                section links to its own page for the detail.
              </p>
            </div>
            <div className="rounded-xl border border-neutral-200 bg-white px-5 py-3 text-right">
              <div className="text-[11px] uppercase tracking-wide text-neutral-500">
                Total units held
              </div>
              <div className="mt-0.5 text-3xl font-semibold tabular-nums">{num(grandTotal)}</div>
            </div>
          </div>

          {/* One hairline panel rather than three floating cards: the tiers add
              up to the figure above, so they should read as parts of a whole. */}
          <div className="mt-4 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-neutral-200 bg-neutral-200 sm:grid-cols-3">
            <StatTile
              icon={Boxes}
              label="Serialized devices"
              units={serializedUnits}
              unit="units"
              sub={`${num(batches.length)} lot${batches.length === 1 ? '' : 's'}${
                goneFromLots
                  ? ` · ${num(goneFromLots)} shipped or disposed`
                  : ''
              }`}
              href="/assets"
            />
            <StatTile
              icon={Layers}
              label="Pallet stock"
              units={palletUnits}
              unit="units"
              sub={`${num(heldPallets.length)} pallet${heldPallets.length === 1 ? '' : 's'}${
                shippedCount ? ` · ${num(shippedCount)} shipped` : ''
              }`}
              href="/pallets"
            />
            <StatTile
              icon={Package}
              label="Consumables"
              units={consumableUnits}
              unit="units"
              sub={`${num(stock.length)} item${stock.length === 1 ? '' : 's'}`}
              href="/stock"
            />
          </div>

          {/* Serialized devices — grouped by purchase lot, mirroring the Assets page. */}
          <Section
            id="serialized"
            title="Serialized devices"
            units={serializedUnits}
            rows={lotRows.length + (unassigned.length > 0 ? 1 : 0)}
            href="/assets"
            hint="One row per physical unit"
          >
            <Table
              label="Serialized devices by lot"
              head={['Lot', 'Supplier', 'Units']}
              empty="No serialized devices yet."
              rows={lotRows.length + (unassigned.length > 0 ? 1 : 0)}
            >
              {lotRows.map((b) => (
                <Row
                  key={b.id}
                  href={`/batches/${b.id}`}
                  cells={[b.batchNumber, b.source || '—']}
                  units={heldOf(b)}
                />
              ))}
              {unassigned.length > 0 && (
                <Row
                  href="/assets?noBatch=true"
                  cells={['Unassigned', 'No lot']}
                  units={unassigned.length}
                  muted
                />
              )}
            </Table>
          </Section>

          {/* Pallet stock — counted quantities by variant, not individual rows. */}
          <Section
            id="pallet-stock"
            title="Pallet stock"
            units={palletUnits}
            rows={palletRows.length}
            href="/pallets"
            hint="Counted by variant, not per unit"
          >
            <Table
              label="Pallet stock by pallet"
              head={['Pallet', 'Description', 'Variants', 'Units']}
              empty="No active pallets."
              rows={palletRows.length}
            >
              {palletRows.map((p) => (
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
          <Section
            id="consumables"
            title="Consumables"
            units={consumableUnits}
            rows={stockRows.length}
            href="/stock"
            hint="Counted by SKU"
          >
            <Table
              label="Consumables by item"
              head={['Item', 'SKU', 'On hand']}
              empty="No consumables yet."
              rows={stockRows.length}
            >
              {stockRows.map((s) => (
                <Row
                  key={s.id}
                  href={`/stock/${s.id}`}
                  cells={[s.name, s.sku || '—']}
                  units={s.quantity ?? 0}
                />
              ))}
            </Table>
          </Section>
        </div>
      </main>
    </>
  );
}

// Deliberately no share-of-total bar here. The three tiers add up arithmetically
// but they do not compare: 79 serialized laptops against 641 antistatic bags is
// not "devices are 8% of stock" in any sense a warehouse cares about. Drawing
// that ratio would give a misleading comparison the most visual weight on the
// page. Each tile states its own tier and links to it; the counting basis is
// spelled out on the section below.
function StatTile({
  icon: Icon,
  label,
  units,
  unit,
  sub,
  href,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;
  label: string;
  units: number;
  unit: string;
  sub: string;
  href: string;
}) {
  return (
    <Link href={href} className="block bg-white p-4 transition-colors hover:bg-neutral-50">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-[#2b7fff]" aria-hidden="true" />
        <span className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{num(units)}</span>
        <span className="text-xs text-neutral-600">{unit}</span>
      </div>
      <div className="mt-1 text-xs text-neutral-600">{sub}</div>
    </Link>
  );
}

function Section({
  id,
  title,
  units,
  rows,
  href,
  hint,
  children,
}: {
  id: string;
  title: string;
  units: number;
  rows: number;
  href: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="mt-4 min-w-0 overflow-hidden rounded-xl border border-neutral-200 bg-white"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-neutral-200 px-4 py-3">
        <div className="min-w-0">
          <h2 id={id} className="text-xs font-semibold uppercase tracking-wide text-neutral-900">
            {title}
          </h2>
          <p className="mt-1 text-sm text-neutral-600">
            <span className="font-medium text-neutral-900 tabular-nums">{num(units)}</span> units
            across {num(rows)} {rows === 1 ? 'row' : 'rows'} · {hint}
          </p>
        </div>
        {/* Rendered three times on this page — Assets, Pallets, Consumables —
            so without the section name in the accessible name a screen reader's
            link list reads "View all" three times with three destinations. The
            arrow is decoration; unhidden it is announced as "right arrow". */}
        <Link
          href={href}
          aria-label={`View all ${title}`}
          className="shrink-0 text-sm font-medium text-[#1a6ef5] hover:underline"
        >
          View all <span aria-hidden="true">→</span>
        </Link>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Table({
  label,
  head,
  empty,
  rows,
  children,
}: {
  label: string;
  head: string[];
  empty: string;
  rows: number;
  children: React.ReactNode;
}) {
  if (rows === 0) {
    return <p className="text-sm text-neutral-600">{empty}</p>;
  }
  return (
    // `relative` is load-bearing: the sr-only caption is position:absolute, and
    // without a positioned ancestor it resolves against the initial containing
    // block — landing past the viewport on a phone, where overflow further up
    // cannot clip it, and scrolling the whole page sideways.
    //
    // The region's name carries the section, because this component renders
    // three times: three scroll regions all called "Inventory breakdown" are
    // indistinguishable in a screen reader's landmark list.
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="relative min-w-0 overflow-x-auto rounded-lg border border-neutral-200"
    >
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{label}</caption>
        <thead className="bg-neutral-50">
          <tr>
            {head.map((h, i) => (
              <th
                scope="col"
                key={h}
                className={`${TH} ${i === head.length - 1 ? 'text-right' : ''}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
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
    <tr className="border-t border-neutral-200 transition-colors hover:bg-neutral-50">
      {cells.map((c, i) =>
        i === 0 ? (
          // The row's subject is a th, so a screen reader announces it with
          // each figure that follows rather than reading bare numbers.
          <th scope="row" key={i} className={`${TD} font-medium`}>
            <Link
              href={href}
              className={muted ? 'text-neutral-600 hover:underline' : 'text-[#1a6ef5] hover:underline'}
            >
              {c}
            </Link>
          </th>
        ) : (
          <td key={i} className={`${TD} text-neutral-600`}>
            {c}
          </td>
        ),
      )}
      <td className={`${TD} text-right font-medium tabular-nums`}>{num(units)}</td>
    </tr>
  );
}
