import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api-server';
import type { Asset } from '@/lib/actions/assets';
import { PrintButton } from './print-button';

// Spec fields live on the audit rows (the USB tool writes them there).
interface AuditSpec {
  cpu?: string | null;
  cosmeticGrade?: string | null;
  screenGrade?: string | null;
  notes?: string | null;
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

  // "grade_b" -> "B". The word "Grade" is dropped because the label says
  // "Cosmetic"/"Screen" right before it, and every character costs width on a
  // line that has to survive truncation. for_parts/scrap have no letter, so
  // they print as their last word: "for_parts" -> "PARTS", "scrap" -> "SCRAP".
  // Measured at 8pt in Geist, spelling "FOR PARTS" out costs 100.6mm on an 83mm
  // line and truncates the screen grade away; "PARTS" brings it to 87.8mm, which
  // only overflows when the disk and RAM strings are also at their longest. The
  // audit station offers A-D only, so this path is the web form's alone.
  const gradeLetter = (g: string | null | undefined): string | null => {
    if (!g) return null;
    const m = /^grade_([a-z])$/.exec(g);
    return m ? m[1].toUpperCase() : (g.split('_').pop() ?? g).toUpperCase();
  };
  const cosmetic = gradeLetter(spec?.cosmeticGrade);
  const screen = gradeLetter(spec?.screenGrade);

  // The auditor's comment, headed for the tail of the identifier line. Capped
  // here as well as truncated in CSS: CSS truncation is a backstop that cuts at
  // whatever pixel runs out, whereas this cuts at a word so the fragment that
  // does print still reads as English. 40 characters is roughly the slack left
  // on that line once a batch, lot, serial and service tag have taken their
  // share; anything past it was never going to be readable at 6.5pt anyway.
  const rawNote = (spec?.notes ?? '').replace(/\s+/g, ' ').trim();
  const note =
    rawNote.length <= 40
      ? rawNote
      : rawNote.slice(0, 40).replace(/\s+\S*$/, '').trimEnd() + '\u2026';

  // Line 2 — the specs line: "Disk 256 GB SSD , RAM 8 GB , Cosmetic B , Screen C"
  //
  // The grades ride here rather than on a line of their own because the label
  // has 0.98mm of spare height and another 6.5pt row needs 3.32mm. This line
  // typically runs to about half the width, so there is room across but none
  // down. It also belongs: disk, RAM and condition are all descriptions of the
  // physical thing, which is what someone reads this line for.
  const hardware = [
    spec?.storageCapacity ? `Disk ${spec.storageCapacity}` : null,
    spec?.ramGb ? `RAM ${spec.ramGb} GB` : null,
  ].filter(Boolean);
  const specLine = [
    // Keep the category fallback tied to the hardware half. Folding the grades
    // into the same array would let a graded machine with no disk or RAM on
    // file print its grades and silently lose the category.
    ...(hardware.length ? hardware : [asset.category]),
    cosmetic ? `Cosmetic ${cosmetic}` : null,
    screen ? `Screen ${screen}` : null,
  ]
    .filter(Boolean)
    .join(' , ');

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
        <h1 className="mb-2 text-lg font-semibold">Label for {unit}</h1>
        <Link
          href={`/assets/${asset.id}`}
          className="text-sm text-neutral-700 hover:text-neutral-950"
        >
          <span aria-hidden="true">← </span>Back to device
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

        {/* Full width, so the service tag is never cut off.

            The comment goes LAST on purpose. This line truncates, and ordering
            decides what a long line sacrifices: identifiers first, note last
            means a wordy comment loses its own tail and never eats the service
            tag. Quoted so it reads as somebody's remark rather than as one more
            code in a row of codes. */}
        <div className="mt-[0.8mm] truncate text-[6.5pt] leading-[1.1] text-black">
          {[
            batch?.batchNumber,
            lot?.lotNumber,
            asset.serialNumber ? `S/N ${asset.serialNumber}` : null,
            asset.expressServiceCode ? `ST ${asset.expressServiceCode}` : null,
            note ? `“${note}”` : null,
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
