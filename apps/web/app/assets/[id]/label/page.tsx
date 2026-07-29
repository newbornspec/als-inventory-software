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

// Label stock. Change these two values to match your printer's media and the
// whole layout follows — nothing else is hard-coded to a size.
const LABEL_W = '88.9mm'; // 3.5in
const LABEL_H = '27.94mm'; // 1.1in

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

  // Vendor CPU strings are verbose ("Intel(R) Core(TM) i5-4590 CPU @ 3.30GHz")
  // and eat the label's one line. Trim them to the form used on the existing
  // labels: "CORE I5-4590 3.30GHZ".
  const cpu = (spec?.cpu ?? '')
    .replace(/\((R|TM)\)/g, '') // Intel(R) Core(TM) -> Intel Core
    .replace(/\b(Intel|AMD)\b/gi, '') // the maker is implied on our stock
    .replace(/\bCPU\b|\bProcessor\b/gi, '')
    .replace(/\s+with\s+.*?Graphics\b/i, '') // drop 'with Radeon Graphics'
    .replace(/\s*@\s*/, ' ') // '@ 3.30GHz' -> '3.30GHz'
    .replace(/\s+/g, ' ')
    .trim();

  // Line 1 — what the device is, as on the existing labels:
  // "DELL LATITUDE 7320 CORE I5-1135G7 2.40 GHZ 13.2""
  const title =
    [asset.manufacturer, asset.model, cpu, spec?.screenSize]
      .filter(Boolean)
      .join(' ')
      .toUpperCase() || asset.name.toUpperCase();

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
    <main className="min-h-screen bg-white p-8 text-neutral-900 print:p-0">
      <style>{`
        @page { size: ${LABEL_W} ${LABEL_H}; margin: 0; }
        @media print {
          html, body { width: ${LABEL_W}; height: ${LABEL_H}; margin: 0 !important; }
          .no-print { display: none !important; }
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
        className="label mx-auto overflow-hidden border border-neutral-300 bg-white px-[2mm] py-[1.5mm] text-black"
        style={{ width: LABEL_W, height: LABEL_H }}
      >
        <div className="truncate text-[9pt] leading-[1.15] font-bold tracking-tight">{title}</div>
        <div className="truncate text-[8pt] leading-[1.15] text-neutral-700">{specLine}</div>

        <div className="mt-[1mm] flex items-end justify-between gap-[2mm]">
          <div className="min-w-0">
            <div className="text-[20pt] leading-none font-bold tracking-tight">{unit}</div>
            <div className="mt-[0.5mm] truncate text-[6.5pt] leading-[1.1] text-neutral-700">
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
          {/* Encodes the Unit ID — scanning resolves it, the serial, or the tag. */}
          <img
            src={`/api/assets/${asset.id}/barcode?type=code128`}
            alt={`Barcode ${unit}`}
            className="h-[14mm] w-[40mm] shrink-0 object-contain"
          />
        </div>
      </div>

      <div className="no-print mx-auto mt-6 max-w-md">
        <PrintButton />
        <p className="mt-3 text-xs text-neutral-500">
          Label stock: {LABEL_W} × {LABEL_H}. Set your printer to that size with no scaling
          (&ldquo;Actual size&rdquo;), and turn headers and footers off.
        </p>
      </div>
    </main>
  );
}
