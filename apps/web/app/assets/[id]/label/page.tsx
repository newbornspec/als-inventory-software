import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api-server';
import type { Asset } from '@/lib/actions/assets';
import { PrintButton } from './print-button';

// Spec fields live on the audit rows (the USB tool writes them there).
interface AuditSpec {
  cpu?: string | null;
  ramGb?: number | null;
  storageCapacity?: string | null;
  screenSize?: string | null;
  createdAt: string;
}

// Label stock: Brother DK-11201 (Standard Address Label) on a QL-800.
// These are the DRIVER's media dimensions, not the printable area — matching
// them exactly is what makes the print dialog pick the right size instead of
// falling back to a default and scaling. The ~1mm unprintable edge is covered
// by the padding on .label below. Change these two values for other stock and
// the whole layout follows; nothing else is hard-coded to a size.
const LABEL_W = '90mm'; // DK-11201 length
const LABEL_H = '29mm'; // DK-11201 width

export default async function AssetLabelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let asset: Asset;
  try {
    asset = await apiFetch<Asset>(`/assets/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  // Batch/Lot are resolved at PRINT time rather than baked into the Unit ID,
  // so a device that moves between lots always prints its current position.
  const [audits, batch, lot] = await Promise.all([
    apiFetch<AuditSpec[]>(`/assets/${id}/audits`).catch(() => [] as AuditSpec[]),
    asset.batchId
      ? apiFetch<{ batchNumber: string }>(`/batches/${asset.batchId}`).catch(() => null)
      : null,
    asset.lotId ? apiFetch<{ lotNumber: string }>(`/lots/${asset.lotId}`).catch(() => null) : null,
  ]);
  const spec = audits[0];

  // Manufacturer as it should read on a label: "Dell Inc." -> "DELL",
  // "Micro-Star International" -> "MICRO-STAR". Legal suffixes and filler words
  // cost characters on a line that has to fit 90mm, and nobody identifies a
  // laptop by "Inc.". Falls back to the raw value if stripping leaves nothing
  // (e.g. a manufacturer literally named one of these words).
  const rawMaker = (asset.manufacturer ?? '').trim();
  const maker =
    rawMaker
      .replace(
        /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|llc|plc|gmbh|ag|nv|bv|sa|kk)\b\.?/gi,
        '',
      )
      .replace(/\b(computers?|technolog(y|ies)|electronics|systems?|international|group)\b/gi, '')
      .replace(/[.,]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || rawMaker;

  // Vendor CPU strings are verbose ("Intel(R) Core(TM) i5-4590 CPU @ 3.30GHz")
  // and eat the label's one line. Trim them to the form used on the existing
  // labels: "CORE I5-4590 3.30GHZ".
  //
  // Same rules as cleanCpuModel() in apps/api/src/common/spec-normalise.ts, which
  // the xlsx export uses — kept in step by hand, since the web app cannot import
  // from the API. The one deliberate difference: this drops the Intel/AMD word
  // (dropMaker) because 90mm of label width is the binding constraint, whereas the
  // export keeps it so a spreadsheet reader can tell Intel from AMD.
  const cpu = (spec?.cpu ?? '')
    .replace(/\((R|TM)\)/g, '') // Intel(R) Core(TM) -> Intel Core
    .replace(/\b(Intel|AMD)\b/gi, '') // the maker is implied on our stock
    .replace(/\bCPU\b|\bProcessor\b/gi, '')
    .replace(/\s+with\s+.*?Graphics\b/i, '') // drop 'with Radeon Graphics'
    .replace(/\s*@\s*/, ' ') // '@ 3.30GHz' -> '3.30GHz'
    .replace(/\s+/g, ' ')
    .trim();

  // Vendors often repeat themselves: HP's model reads "HP Pro SFF 290 G9", so
  // maker + model printed "HP HP PRO SFF 290 G9" and pushed the line off the
  // label. Drop the maker when the model already opens with it.
  const model = (asset.model ?? '').trim();
  const dedupedMaker =
    maker && model.toUpperCase().startsWith(maker.toUpperCase()) ? '' : maker;

  // Line 1 — what the device is, as on the existing labels:
  // "DELL LATITUDE 7320 CORE I5-1135G7 2.40 GHZ 13.2""
  const title =
    [dedupedMaker, model, cpu, spec?.screenSize]
      .filter(Boolean)
      .join(' ')
      .toUpperCase() || asset.name.toUpperCase();

  // Long model names must still print in full rather than truncate — a label
  // that ends mid-word is useless in the warehouse. Step the type down instead.
  // Thresholds are calibrated against the widest real strings in the fleet
  // (~1.71mm per uppercase character at 9pt in Geist across 82.6mm of usable
  // width); below 6.5pt thermal output stops being legible, so that's the floor
  // and anything longer is a data-entry problem, not a layout one.
  const titlePt = title.length <= 46 ? 9 : title.length <= 52 ? 8 : title.length <= 60 ? 7 : 6.5;

  // Line 2 — the specs line: "Disk 256 GB SSD , RAM 8 GB"
  const specLine =
    [
      spec?.storageCapacity ? `Disk ${spec.storageCapacity}` : null,
      spec?.ramGb ? `RAM ${spec.ramGb} GB` : null,
    ]
      .filter(Boolean)
      .join(' , ') || asset.category;

  const unit = asset.unitId ?? asset.tag;

  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen bg-white p-8 text-neutral-900 print:p-0">
      <style>{`
        @page { size: ${LABEL_W} ${LABEL_H}; margin: 0; }
        @media print {
          html, body { width: ${LABEL_W}; height: ${LABEL_H}; margin: 0 !important; }
          .no-print { display: none !important; }
          /* Never let the driver lighten or dither our text. */
          .label, .label * { -webkit-print-color-adjust: exact; print-color-adjust: exact;
                             color: #000 !important; }
          .label { width: ${LABEL_W}; height: ${LABEL_H}; border: 0 !important;
                   box-shadow: none !important; page-break-after: always; }
        }
      `}</style>

      <div className="no-print mx-auto mb-4 max-w-md">
        <Link
          href={`/assets/${asset.id}`}
          className="text-sm text-neutral-500 hover:text-neutral-900"
        >
          ← Back to device
        </Link>
      </div>

      {/* The label itself. Sized to the stock so what you see is what prints. */}
      <div
        className="label mx-auto overflow-hidden border border-neutral-300 bg-white p-[3.5mm] text-black"
        style={{ width: LABEL_W, height: LABEL_H }}
      >
        <div
          className="truncate leading-[1.15] font-bold tracking-tight"
          style={{ fontSize: `${titlePt}pt` }}
        >
          {title}
        </div>
        <div className="truncate text-[8pt] leading-[1.15] text-black">{specLine}</div>

        <div className="mt-[0.8mm] flex items-center justify-between gap-[2mm]">
          <div className="text-[20pt] leading-none font-bold tracking-tight">{unit}</div>
          {/* Bars only (text=0): the Unit ID is already printed larger to the
              left, so the caption would just cost height. */}
          <img
            src={`/api/assets/${asset.id}/barcode?type=code128&text=0`}
            alt={`Barcode ${unit}`}
            className="h-[10mm] w-[40mm] shrink-0 object-contain"
          />
        </div>

        {/* Full width, so the service tag is never cut off. */}
        <div className="mt-[0.8mm] truncate text-[6.5pt] leading-[1.1] text-black">
          {[
            batch?.batchNumber,
            lot?.lotNumber,
            asset.serialNumber ? `S/N ${asset.serialNumber}` : null,
            asset.expressServiceCode ? `ST ${asset.expressServiceCode}` : null,
          ]
            .filter(Boolean)
            .join('  ·  ')}
        </div>
      </div>

      <div className="no-print mx-auto mt-6 max-w-md">
        <PrintButton />
        <p className="mt-3 text-xs text-neutral-500">
          Brother QL-800 · DK-11201 ({LABEL_W} × {LABEL_H}). In the print dialog choose the
          QL-800, set paper to <strong>29mm x 90mm</strong>, scale to{' '}
          <strong>Actual size</strong> (not &ldquo;Fit&rdquo;), and turn headers and footers off.
          Chrome remembers these per site, so you only set them once.
        </p>
      </div>
    </main>
  );
}
