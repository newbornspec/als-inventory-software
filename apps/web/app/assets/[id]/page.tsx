import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, ApiError, getSessionAccess, getSessionUser } from '@/lib/api-server';
import { hasAnyPermission, hasPermission } from '@/lib/permissions';
import { getLocations } from '@/lib/data';
import type { Asset } from '@/lib/actions/assets';
import type { Batch } from '@/lib/actions/batches';
import { Nav } from '@/app/components/nav';
import { Breadcrumbs, type Crumb } from '@/app/components/breadcrumbs';
import { formatLabel } from '@/lib/asset-options';
import { money } from '@/lib/money';
import type { PhotoMeta } from '@/lib/actions/photos';
import { AssetEditForm } from './edit-form';
import { SellAssetButton } from './sell-button';
import { DeleteAssetButton } from './delete-asset-button';
import { AuditSection, type AssetAuditRecord } from './audit-section';
import type { CertificateEligibility } from '@/lib/certificate-eligibility';
import { PhotosSection } from './photos-section';
import { HardwareSection } from './hardware-section';
import { DeviceLocksSection, type DeviceLocks } from './device-locks-section';

interface AssetHistoryEntry {
  id: string;
  eventType: string;
  notes: string | null;
  createdAt: string;
}

interface AssetCosting {
  purchaseCost: number | null;
  lotTotalCost: number | null;
  unitsInLot: number;
  evenSplit: number | null;
  allocatedCost: number | null;
  salePrice: number | null;
  sold: boolean;
  profit: number | null;
  orderId: string | null;
  orderNumber: string | null;
}

// Fetch the asset + its history/audits, turning a 404 (deleted, or created
// offline and not yet synced to the server) into Next's not-found page rather
// than an unhandled server-side exception.
async function loadAsset(
  id: string,
): Promise<[Asset, AssetHistoryEntry[], AssetAuditRecord[], PhotoMeta[]]> {
  try {
    return await Promise.all([
      apiFetch<Asset>(`/assets/${id}`),
      apiFetch<AssetHistoryEntry[]>(`/assets/${id}/history`),
      apiFetch<AssetAuditRecord[]>(`/assets/${id}/audits`),
      apiFetch<PhotoMeta[]>(`/assets/${id}/photos`),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}

// The API's per-drive answer to "may this device be certified?" (contract
// C4). null means unknown - an API that predates the endpoint answers 404, and
// any other failure must not take the page down - and the audit section then
// falls back to its local copy of the interim rule.
async function loadEligibility(id: string): Promise<CertificateEligibility | null> {
  try {
    return await apiFetch<CertificateEligibility>(`/assets/${id}/certificate-eligibility`);
  } catch {
    return null;
  }
}

export default async function AssetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSessionUser();

  // Permissions come from /auth/me, not the JWT (which carries none). Fetched
  // alongside the asset so it adds no round trip to the page.
  const [[asset, history, audits, photos], access, eligibility] = await Promise.all([
    loadAsset(id),
    getSessionAccess(),
    loadEligibility(id),
  ]);
  const mayRecordWipe = hasPermission(access, 'record_manual_wipe');
  const mayAudit = hasAnyPermission(access, ['perform_goods_in_audit', 'perform_amazon_audit']);
  // findAudits() orders by createdAt DESC, so [0] is the most recent
  // capture. Already fetched for the Lifecycle stream - no extra request.
  const latestAudit = audits[0] ?? null;
  const locations = await getLocations();

  const isSold = asset.stockStatus === 'sold';
  // A sold asset is locked: no editing for anyone here (admins use Return to
  // Inventory on the Sold page instead of editing in place).
  const canEdit = (user?.role === 'admin' || user?.role === 'manager') && !isSold;
  const canDelete = user?.role === 'admin';
  const canSell = !isSold && !!user;

  // Build the drill-down trail. If the device belongs to a lot, route back through
  // it (the hierarchy); otherwise fall back to the global Assets search.
  let lot: Batch | null = null;
  if (asset.batchId) {
    lot = await apiFetch<Batch>(`/batches/${asset.batchId}`).catch(() => null);
  }
  const crumbs: Crumb[] = lot
    ? [
        { label: 'Dashboard', href: '/dashboard' },
        { label: 'Goods In', href: '/batches' },
        { label: lot.batchNumber, href: `/batches/${lot.id}` },
        { label: asset.name },
      ]
    : [
        { label: 'Dashboard', href: '/dashboard' },
        { label: 'Assets', href: '/assets' },
        { label: asset.name },
      ];

  // Costing/profit is manager+ only — fetch it lazily and never let a failure
  // take down the asset page.
  let costing: AssetCosting | null = null;
  if (canEdit) {
    try {
      costing = await apiFetch<AssetCosting>(`/reports/assets/${id}/costing`);
    } catch {
      costing = null;
    }
  }

  // One stream for the device's whole life: warehouse events and audit events
  // interleaved in the order they happened, oldest first — the story reads
  // Received → Audited → Allocated → Sold, the way the lifecycle actually ran.
  //
  // 'audited' history events are excluded: every ingest path (kiosk, manual
  // add, web form, offline sync) writes BOTH an asset_audits row and an
  // 'audited' history twin for the same capture, and the audit row is the
  // richer record. Keeping both would show every audit twice — and an audit
  // captured offline would split into a pair hours apart, because the audit
  // row carries the capture-time clock while its twin is stamped at sync time.
  const lifecycle = [
    ...history
      .filter((h) => h.eventType !== 'audited')
      .map((h) => ({
        id: `h-${h.id}`,
        at: h.createdAt,
        isAudit: false,
        title: formatLabel(h.eventType),
        lines: h.notes ? [h.notes] : [],
      })),
    ...audits.map((a) => ({
      id: `a-${a.id}`,
      at: a.createdAt,
      isAudit: true,
      title: `Audit${a.auditStatus ? ` — ${formatLabel(a.auditStatus)}` : ' recorded'}${
        a.cosmeticGrade ? ` · ${formatLabel(a.cosmeticGrade)}` : ''
      }`,
      lines: [
        ...(a.finalDisposition ? [`Disposition: ${formatLabel(a.finalDisposition)}`] : []),
        ...(a.dataWipeStatus ? [`Data wipe: ${formatLabel(a.dataWipeStatus)}`] : []),
        ...(a.notes ? [a.notes] : []),
      ],
    })),
  ].sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime());

  return (
    <>
      <Nav />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-screen bg-neutral-50 text-neutral-950 px-4 py-6 sm:px-8 sm:py-8"
      >
        <div className="mx-auto max-w-[90rem]">
        <Breadcrumbs items={crumbs} />

        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{asset.name}</h1>
            <p className="mt-1 text-sm text-neutral-600">
              {asset.unitId && (
                <>
                  Unit ID:{' '}
                  <span className="font-mono font-medium text-neutral-900">{asset.unitId}</span>
                  {' · '}
                </>
              )}
              Tag: <span className="text-neutral-900">{asset.tag}</span> · {asset.category}
              {asset.serialNumber && asset.serialNumber !== asset.tag && (
                <> · S/N: <span className="text-neutral-900">{asset.serialNumber}</span></>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {canSell && <SellAssetButton assetId={asset.id} name={asset.name} />}
            {canDelete && !isSold && (
              <DeleteAssetButton
                assetId={asset.id}
                name={asset.name}
                tag={asset.tag}
                auditCount={audits.length}
              />
            )}
          </div>
        </div>

        {isSold && (
          <div className="mt-4 max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            <strong>SOLD</strong> — this asset has left active inventory and is locked.
            {user?.role === 'admin' ? (
              <>
                {' '}Use <Link href="/sold" className="underline">the Sold page</Link> to return it
                to inventory.
              </>
            ) : (
              ' Only an administrator can return it to inventory.'
            )}
          </div>
        )}

        {/* items-start, not the default stretch: these panels differ hugely in
            height (Origin is one line, Details is a whole form), and stretching
            them left tall empty boxes. Carded, the differences read as separate
            things rather than as gaps in a column. */}
        <div className="mt-4 grid items-start gap-4 md:grid-cols-2">
          <section className="rounded-xl border border-neutral-200 bg-white p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-900">Details</h2>
            {canEdit ? (
              <AssetEditForm asset={asset} locations={locations} />
            ) : (
              <dl className="mt-4 space-y-2 text-sm">
                <div className="flex justify-between max-w-sm">
                  <dt className="text-neutral-500">Stock status</dt>
                  <dd>{formatLabel(asset.stockStatus)}</dd>
                </div>
                <div className="flex justify-between max-w-sm">
                  <dt className="text-neutral-500">Condition grade</dt>
                  <dd>{asset.conditionGrade ? formatLabel(asset.conditionGrade) : 'Ungraded'}</dd>
                </div>
                <div className="flex justify-between max-w-sm">
                  <dt className="text-neutral-500">Audit status</dt>
                  <dd>{asset.auditStatus ? formatLabel(asset.auditStatus) : '—'}</dd>
                </div>
                <div className="flex justify-between max-w-sm">
                  <dt className="text-neutral-500">Location</dt>
                  <dd>{asset.location?.name ?? 'Unassigned'}</dd>
                  <dt className="text-neutral-500">Pallet</dt>
                  <dd>
                    {asset.pallet ? (
                      <Link
                        href={`/pallets/${asset.pallet.id}`}
                        className="text-[#1a6ef5] hover:underline"
                      >
                        {asset.pallet.palletNumber}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </dd>
                </div>
              </dl>
            )}

            {/* What the auditor actually recorded, shown to EVERYONE.
                Deliberately outside the canEdit branch above: that branch swaps
                the read-only list for the edit form, so anything added to the
                list is invisible to exactly the people who use this page most.

                Kept separate from the editable fields rather than mixed in,
                because these are captured at audit time and cannot be changed
                here - putting them among inputs would imply otherwise. It also
                makes a real distinction visible: Condition grade above is the
                CURRENT working grade and can be edited, while this is what was
                judged with the machine in front of someone. If they differ, a
                unit was regraded, and that is worth being able to see. */}
            <div className="mt-4 border-t border-neutral-200 pt-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                From the latest audit
              </h3>
              {latestAudit ? (
                <dl className="mt-2 space-y-2 text-sm">
                  <div className="flex justify-between gap-4 max-w-sm">
                    <dt className="text-neutral-500">Cosmetic grade</dt>
                    <dd>
                      {latestAudit.cosmeticGrade
                        ? formatLabel(latestAudit.cosmeticGrade)
                        : 'Not graded'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4 max-w-sm">
                    <dt className="text-neutral-500">Screen grade</dt>
                    <dd>
                      {latestAudit.screenGrade
                        ? formatLabel(latestAudit.screenGrade)
                        : 'Not graded'}
                    </dd>
                  </div>
                  {latestAudit.notes ? (
                    <div className="max-w-sm">
                      <dt className="text-neutral-500">Comment</dt>
                      {/* Clamped: the field accepts 2000 characters and an
                          operator using all of them would otherwise push every
                          panel below it off the screen. title= keeps the whole
                          thing reachable without a component or a click. */}
                      <dd
                        className="mt-1 line-clamp-3 whitespace-pre-line text-neutral-800"
                        title={latestAudit.notes}
                      >
                        {latestAudit.notes}
                      </dd>
                    </div>
                  ) : null}
                  <div className="flex justify-between gap-4 max-w-sm">
                    <dt className="text-neutral-500">Audited</dt>
                    <dd>
                      {new Date(latestAudit.createdAt).toLocaleDateString('en-GB', {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-2 text-sm text-neutral-500">Not audited yet.</p>
              )}
            </div>
          </section>

          <section className="rounded-xl border border-neutral-200 bg-white p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-900">Origin</h2>
            {/* Branch on asset.batchId, never on the lot fetch: the fetch's
                catch(() => null) covers transient failures and narrower
                permissions, and a failed fetch must degrade neutrally — not
                assert "no lot" about a device that has one. This is the
                provenance card on an ITAD traceability page. */}
            {asset.batchId ? (
              lot ? (
                <dl className="mt-4 space-y-2 text-sm">
                  <div className="flex justify-between max-w-sm">
                    <dt className="text-neutral-500">Goods In lot</dt>
                    <dd>
                      <Link
                        href={`/batches/${lot.id}`}
                        className="text-[#1a6ef5] hover:underline"
                      >
                        {lot.batchNumber}
                      </Link>
                    </dd>
                  </div>
                  <div className="flex justify-between max-w-sm">
                    <dt className="text-neutral-500">Supplier</dt>
                    <dd>{lot.source ?? '—'}</dd>
                  </div>
                  <div className="flex justify-between max-w-sm">
                    <dt className="text-neutral-500">Purchase order</dt>
                    <dd>{lot.purchaseOrder ?? '—'}</dd>
                  </div>
                  <div className="flex justify-between max-w-sm">
                    <dt className="text-neutral-500">Received</dt>
                    {/* Raw date string, exactly as the lot page shows it — no Date()
                        round-trip that could shift a day across timezones. */}
                    <dd>{lot.receivedDate ?? '—'}</dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-4 text-sm text-neutral-500">
                  This device belongs to a lot, but its details could not be loaded.{' '}
                  <Link href={`/batches/${asset.batchId}`} className="underline">
                    Open lot →
                  </Link>
                </p>
              )
            ) : (
              <p className="mt-4 text-sm text-neutral-500">
                {audits.some((a) => a.auditKind === 'amazon')
                  ? 'No lot — this device entered through the Amazon Audit workspace, which files devices without one.'
                  : 'No lot — this device was created directly, outside Goods In.'}
              </p>
            )}
          </section>

          <AuditSection
            assetId={asset.id}
            audits={audits}
            mayRecordWipe={mayRecordWipe}
            mayAudit={mayAudit}
            eligibility={eligibility}
          />

          {/* Above the hardware profile deliberately: whether the machine can
              be resold at all outranks how much RAM it has. */}
          <DeviceLocksSection
            locks={(asset.hardwareProfile as { locks?: DeviceLocks } | null)?.locks}
          />
          <HardwareSection profile={asset.hardwareProfile} />

          <div className="md:col-span-2">
            <PhotosSection assetId={asset.id} photos={photos} canManage={canEdit} />
          </div>

          {canEdit && costing && (
            <section className="rounded-xl border border-neutral-200 bg-white p-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-900">Costing &amp; profit</h2>
              <dl className="mt-4 max-w-sm space-y-2 text-sm">
                <div className="flex items-baseline justify-between">
                  <dt className="text-neutral-500">Allocated cost</dt>
                  <dd className="text-right">
                    {costing.allocatedCost != null ? money(costing.allocatedCost) : '—'}
                    <span className="ml-2 text-xs text-neutral-500">
                      {costing.purchaseCost != null
                        ? 'override'
                        : costing.evenSplit != null
                          ? `split of lot ÷ ${costing.unitsInLot}`
                          : 'no lot cost'}
                    </span>
                  </dd>
                </div>
                {costing.sold ? (
                  <>
                    <div className="flex justify-between">
                      <dt className="text-neutral-500">Sale price</dt>
                      <dd>{costing.salePrice != null ? money(costing.salePrice) : '—'}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-neutral-500">Profit</dt>
                      <dd
                        className={
                          costing.profit == null
                            ? ''
                            : costing.profit > 0
                              ? 'text-emerald-700'
                              : costing.profit < 0
                                ? 'text-red-600'
                                : ''
                        }
                      >
                        {costing.profit != null ? money(costing.profit) : '—'}
                      </dd>
                    </div>
                    {costing.orderNumber && (
                      <div className="pt-1 text-xs text-neutral-500">
                        Sold on {costing.orderNumber}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-neutral-500">Not sold yet.</div>
                )}
              </dl>
            </section>
          )}

          <section className="rounded-xl border border-neutral-200 bg-white p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-900">Lifecycle</h2>
            <ul className="mt-4 space-y-3">
              {lifecycle.map((e) => (
                <li
                  key={e.id}
                  className={`border-l-2 pl-3 text-sm ${
                    e.isAudit ? 'border-emerald-200' : 'border-neutral-200'
                  }`}
                >
                  <div className="text-neutral-900">{e.title}</div>
                  {e.lines.map((line, i) => (
                    <div key={i} className="text-neutral-500">
                      {line}
                    </div>
                  ))}
                  <div className="text-xs text-neutral-500">
                    {new Date(e.at).toLocaleString()}
                  </div>
                </li>
              ))}
              {lifecycle.length === 0 && (
                <li className="text-sm text-neutral-500">No events yet.</li>
              )}
            </ul>
          </section>

          <section className="rounded-xl border border-neutral-200 bg-white p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-900">Label</h2>
            <div className="mt-4 flex items-start gap-6">
              <img
                src={`/api/assets/${asset.id}/barcode?type=qr`}
                alt={`QR code for ${asset.tag}`}
                className="h-28 w-28 rounded-md bg-white p-1"
              />
              <img
                src={`/api/assets/${asset.id}/barcode?type=code128`}
                alt={`Barcode for ${asset.tag}`}
                className="h-16 rounded-md bg-white p-1"
              />
            </div>
            <Link
              href={`/assets/${asset.id}/label`}
              className="mt-3 inline-block text-sm text-neutral-500 underline"
            >
              Open printable label →
            </Link>
          </section>
        </div>
        </div>
      </main>
  </>
  );
}
