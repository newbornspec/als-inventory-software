import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import type { Asset } from '@/lib/actions/assets';
import { Nav } from '@/app/components/nav';
import { AUDIT_STATUSES, CONDITION_GRADES, STOCK_STATUSES, formatLabel } from '@/lib/asset-options';
import {
  LIFECYCLE_STYLE,
  LIFECYCLE_TABS,
  SAVED_VIEWS,
  lifecycleOf,
} from '@/lib/asset-lifecycle';

interface AssetSummary {
  assets: number;
  held: number;
  wiped: number;
  ready: number;
  sold: number;
  quarantine: number;
}

// Every parameter the register understands. Preserved across tab clicks and
// saved views so switching a tab narrows what you were already looking at
// rather than throwing the question away.
const FILTER_KEYS = [
  'search',
  'stockStatus',
  'conditionGrade',
  'auditStatus',
  'category',
  'locationId',
  'noLocation',
  'noAudit',
  'noBatch',
  'noSerial',
  'onPallet',
] as const;

// Owned by the <Select> controls in the Filters popover. They must never also
// be emitted as hidden inputs — see the form below.
const POPOVER_KEYS = ['stockStatus', 'conditionGrade', 'auditStatus'] as const;

type Params = Partial<Record<(typeof FILTER_KEYS)[number] | 'lifecycle', string>>;

function queryFrom(params: Params, overrides: Record<string, string | undefined> = {}) {
  const q = new URLSearchParams();
  for (const k of FILTER_KEYS) if (params[k]) q.set(k, params[k]!);
  if (params.lifecycle) q.set('lifecycle', params.lifecycle);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) q.delete(k);
    else q.set(k, v);
  }
  return q;
}

const N = (n: number) => n.toLocaleString('en-GB');

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const params = await searchParams;
  const user = await getSessionUser();
  const canCreate = user?.role === 'admin' || user?.role === 'manager';
  // A tab is only "chosen" when the URL says so. Arriving from a dashboard or
  // report deep link (which carry filters but no lifecycle) must keep the
  // app-wide default of excluding sold devices — sending lifecycle=all would
  // suppress that guard server-side and make /assets?noBatch=true disagree
  // with the Inventory count that links to it.
  const chosen =
    params.lifecycle && LIFECYCLE_TABS.some((t) => t.value === params.lifecycle)
      ? params.lifecycle
      : null;
  const tab = chosen ?? 'all';

  const listQuery = queryFrom(params, { lifecycle: chosen ?? undefined });
  const [rows, summary] = await Promise.all([
    apiFetch<Asset[]>(`/assets?${listQuery.toString()}`),
    // Headline counts are computed server-side over the WHOLE register, not
    // over the rows below — so they stay true whatever tab is open. A failure
    // here must not take the register down with it.
    apiFetch<AssetSummary>('/assets/summary').catch(() => null),
  ]);

  // Which saved view (if any) is currently applied, so its chip can show as on.
  const activeSaved = SAVED_VIEWS.find((v) =>
    Object.entries(v.params).every(([k, val]) => (params as Record<string, string>)[k] === val),
  );
  const filtersOn = FILTER_KEYS.filter((k) => params[k]).length;

  const cards: { label: string; value: number | null }[] = [
    { label: 'Assets', value: summary?.assets ?? null },
    // Not "In stock": the dashboard tile of that name counts a narrower set,
    // and one label with two numbers across two pages is a support ticket.
    { label: 'Held', value: summary?.held ?? null },
    { label: 'Wiped', value: summary?.wiped ?? null },
    { label: 'Ready', value: summary?.ready ?? null },
    { label: 'Sold', value: summary?.sold ?? null },
    { label: 'Quarantine', value: summary?.quarantine ?? null },
  ];

  return (
    <>
      <Nav />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-screen bg-neutral-50 text-neutral-950 px-4 py-6 sm:p-8"
      >
        <div className="mx-auto max-w-[90rem]">
          {/* --- header ---------------------------------------------------- */}
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-2xl">
              <h1 className="text-2xl font-semibold tracking-tight">Assets</h1>
              <p className="mt-1 text-sm leading-6 text-neutral-600">
                Serialized devices — track every physical device through its audit, sanitization,
                grading and disposition lifecycle.
              </p>
            </div>
            {canCreate && (
              <Link
                href="/assets/new"
                className="shrink-0 rounded-md bg-[#12324f] px-4 py-2 text-xs font-semibold uppercase tracking-wide text-white hover:bg-[#0d2740]"
              >
                + New asset
              </Link>
            )}
          </div>

          {/* --- lifecycle tabs -------------------------------------------- */}
          <nav aria-label="Lifecycle" className="mt-6 flex flex-wrap items-center gap-1 border-b border-neutral-200">
            {LIFECYCLE_TABS.map((t) => {
              const on = t.value === tab;
              return (
                <Link
                  key={t.value}
                  href={`/assets?${queryFrom(params, { lifecycle: t.value === 'all' ? undefined : t.value }).toString()}`}
                  // 'all' clears the parameter rather than sending
                  // lifecycle=all, so the default view keeps the app-wide
                  // sold exclusion and every deep link keeps its meaning.
                  aria-current={on ? 'page' : undefined}
                  className={
                    'mb-[-1px] rounded-t-md px-3 py-2 text-xs font-semibold uppercase tracking-wide ' +
                    (on
                      ? 'border border-neutral-800 border-b-white bg-white text-neutral-950'
                      : 'border border-transparent text-neutral-500 hover:text-neutral-900')
                  }
                >
                  {t.label}
                </Link>
              );
            })}
          </nav>

          {/* --- headline counts -------------------------------------------
              Whole-register figures, independent of the tab below. */}
          {/* gap-px over a grey ground draws the rules: divide-x/border-b are
              DOM-ordered, not grid-aware, and left the base layout with no
              vertical rule and the sm layout with no rule between its rows. */}
          <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-neutral-200 bg-neutral-200 sm:grid-cols-3 lg:grid-cols-6">
            {cards.map((c) => (
              <div key={c.label} className="bg-white px-4 py-3">
                <div className="text-xl font-semibold tabular-nums text-neutral-950">
                  {c.value == null ? '—' : N(c.value)}
                </div>
                <div className="mt-0.5 text-[11px] uppercase tracking-wide text-neutral-500">
                  {c.label}
                </div>
              </div>
            ))}
          </div>

          {/* --- search + filters ------------------------------------------- */}
          <form action="/assets" className="mt-4 flex flex-wrap items-center gap-2">
            {/* Carry the tab and every filter the box itself doesn't own. */}
            {tab !== 'all' && <input type="hidden" name="lifecycle" value={tab} />}
            {/* Everything the visible controls DON'T own. The three selects
                live inside the <details> below and are submitted even while it
                is closed (only `disabled` excludes a control), so repeating
                them here sent each key twice — the API then saw
                "in_stock,in_stock", failed enum validation and 500'd the
                page. */}
            {FILTER_KEYS.filter(
              (k) => !POPOVER_KEYS.includes(k as (typeof POPOVER_KEYS)[number]) && k !== 'search' && params[k],
            ).map((k) => (
              <input key={k} type="hidden" name={k} value={params[k]} />
            ))}
            <label htmlFor="assets-search" className="sr-only">
              Search asset ID, serial, model, tag, lot, pallet or location
            </label>
            <input
              id="assets-search"
              name="search"
              type="search"
              defaultValue={params.search}
              placeholder="Search asset ID, serial, model, tag, pallet…"
              className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-700 hover:bg-neutral-50"
            >
              Search
            </button>
            <details className="relative">
              <summary className="cursor-pointer list-none rounded-md border border-neutral-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-700 hover:bg-neutral-50">
                Filters{filtersOn > 0 ? ` (${filtersOn})` : ''}
              </summary>
              <div className="absolute right-0 z-20 mt-1 w-72 space-y-3 rounded-md border border-neutral-200 bg-white p-3 shadow-lg">
                <Select name="stockStatus" label="Stock status" value={params.stockStatus} options={STOCK_STATUSES} />
                <Select name="conditionGrade" label="Grade" value={params.conditionGrade} options={CONDITION_GRADES} />
                <Select name="auditStatus" label="Audit verdict" value={params.auditStatus} options={AUDIT_STATUSES} />
                <button
                  type="submit"
                  className="w-full rounded-md bg-[#12324f] px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-white hover:bg-[#0d2740]"
                >
                  Apply
                </button>
              </div>
            </details>
          </form>

          {/* --- saved views ------------------------------------------------ */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-wide text-neutral-500">Saved</span>
            {SAVED_VIEWS.map((v) => {
              const on = activeSaved?.label === v.label;
              return (
                <Link
                  key={v.label}
                  href={`/assets?${new URLSearchParams(v.params).toString()}`}
                  title={v.hint}
                  aria-current={on ? 'true' : undefined}
                  className={
                    'rounded border px-2.5 py-1 text-xs ' +
                    (on
                      ? 'border-neutral-800 bg-neutral-900 text-white'
                      : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50')
                  }
                >
                  {v.label}
                </Link>
              );
            })}
            {(filtersOn > 0 || tab !== 'all') && (
              <Link href="/assets" className="text-xs text-neutral-500 underline hover:text-neutral-900">
                Clear
              </Link>
            )}
          </div>

          {/* --- register ---------------------------------------------------- */}
          <div
            role="region"
            aria-label="Assets"
            tabIndex={0}
            className="mt-3 overflow-x-auto rounded-md border border-neutral-200 bg-white"
          >
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">
                Serialized devices in the {LIFECYCLE_TABS.find((t) => t.value === tab)?.label} view
              </caption>
              <thead className="bg-neutral-50">
                <tr className="text-[11px] uppercase tracking-wide text-neutral-500">
                  <th scope="col" className="px-4 py-3 font-medium">Asset</th>
                  <th scope="col" className="px-4 py-3 font-medium">Device</th>
                  <th scope="col" className="hidden px-4 py-3 font-medium sm:table-cell">Serial</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium">Grade</th>
                  <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">Audit</th>
                  <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">Pallet</th>
                  <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">Location</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const state = lifecycleOf(a);
                  const style = LIFECYCLE_STYLE[state];
                  // A device that left names HOW it left rather than reading
                  // the generic "Gone".
                  const stateLabel = state === 'gone' ? formatLabel(a.stockStatus) : style.label;
                  return (
                    <tr key={a.id} className="border-t border-neutral-200 hover:bg-neutral-50">
                      <th scope="row" className="px-4 py-3 font-normal">
                        <Link
                          href={`/assets/${a.id}`}
                          className="font-mono text-xs text-[#1a6ef5] hover:underline"
                        >
                          {a.unitId ?? a.tag}
                        </Link>
                      </th>
                      <td className="px-4 py-3">
                        <Link href={`/assets/${a.id}`} className="font-medium text-neutral-900 hover:underline">
                          {[a.manufacturer, a.model].filter(Boolean).join(' ') || a.name}
                        </Link>
                      </td>
                      <td className="hidden px-4 py-3 font-mono text-xs text-neutral-500 sm:table-cell">
                        {a.serialNumber ?? a.tag}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${style.pill}`}
                        >
                          <span className={`size-1.5 rounded-full ${style.dot}`} aria-hidden="true" />
                          {stateLabel}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {a.conditionGrade ? (
                          <span className="inline-flex min-w-6 items-center justify-center rounded border border-neutral-300 px-1.5 py-0.5 text-xs font-semibold text-neutral-800">
                            {GRADE_LETTER[a.conditionGrade] ?? formatLabel(a.conditionGrade)}
                          </span>
                        ) : (
                          <span className="text-neutral-400">—</span>
                        )}
                      </td>
                      <td className="hidden px-4 py-3 text-neutral-600 md:table-cell">
                        {a.auditStatus ? formatLabel(a.auditStatus) : '—'}
                      </td>
                      <td className="hidden px-4 py-3 md:table-cell">
                        {a.pallet ? (
                          <Link
                            href={`/pallets/${a.pallet.id}`}
                            className="font-mono text-xs text-neutral-700 hover:underline"
                          >
                            {a.pallet.palletNumber}
                          </Link>
                        ) : (
                          <span className="text-neutral-400">—</span>
                        )}
                      </td>
                      <td className="hidden px-4 py-3 text-neutral-600 lg:table-cell">
                        {a.location?.name ?? '—'}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-sm text-neutral-500">
                      No assets match this view.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-neutral-500">
            Showing {N(rows.length)} record{rows.length === 1 ? '' : 's'}
            {summary && tab === 'all' && filtersOn === 0
              ? ` of ${N(summary.assets)}`
              : ' in this view'}{' '}
            · Inventory answers quantity; Assets answer identity.
          </p>
        </div>
      </main>
    </>
  );
}

const GRADE_LETTER: Record<string, string> = {
  grade_a: 'A',
  grade_b: 'B',
  grade_c: 'C',
  grade_d: 'D',
  for_parts: 'FP',
  scrap: 'SC',
};

function Select({
  name,
  label,
  value,
  options,
}: {
  name: string;
  label: string;
  value?: string;
  options: readonly string[];
}) {
  return (
    <div>
      <label htmlFor={`f-${name}`} className="block text-xs text-neutral-600">
        {label}
      </label>
      <select
        id={`f-${name}`}
        name={name}
        defaultValue={value ?? ''}
        className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm"
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {formatLabel(o)}
          </option>
        ))}
      </select>
    </div>
  );
}
