'use client';

import { useEffect, useRef, useState } from 'react';
import { getPowerSyncDb } from '@/lib/powersync/client';
import { Nav } from '@/app/components/nav';
import { AuditForm } from '@/app/components/audit-form';
import { formatLabel } from '@/lib/asset-options';
import { CameraScanner } from './camera-scanner';

type ScannedAsset = {
  id: string;
  name: string;
  tag: string;
  stock_status: string;
  batch_id: string | null;
};

type ScanResult =
  | { status: 'ok'; asset: ScannedAsset }
  | { status: 'received_new'; asset: ScannedAsset }
  | { status: 'already'; asset: ScannedAsset }
  | { status: 'not_on_list'; tag: string }
  | { status: 'not_found'; tag: string }
  | null;

type Mode = 'keyboard' | 'camera';

interface OpenBatch {
  id: string;
  batch_number: string;
  expected_unit_count: number | null;
}

export default function ScanPage() {
  const [mode, setMode] = useState<Mode>('keyboard');
  const [tag, setTag] = useState('');
  const [result, setResult] = useState<ScanResult>(null);
  const [showAudit, setShowAudit] = useState(false);
  const [recent, setRecent] = useState<{ tag: string; name: string; when: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Receiving: when a batch is selected, every resolved scan also links the
  // asset to it (assets.batch_id) — same local-write, offline-safe path as
  // everything else on this page. receivedCount is a live COUNT(*) against
  // local SQLite, so it's accurate even before anything has synced.
  const [openBatches, setOpenBatches] = useState<OpenBatch[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [receivedCount, setReceivedCount] = useState(0);
  // Set of accepted identifiers (serial/tag, uppercased) from the lot's
  // uploaded list; null when the lot has no list (then scanning is unverified).
  const [expectedIndex, setExpectedIndex] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (mode === 'keyboard') inputRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    const db = getPowerSyncDb();
    // getAll<T>(sql, params) is the multi-row counterpart to db.get() used
    // elsewhere on this page — verify against @powersync/web's current API
    // if this errors after an SDK version bump.
    db.getAll<OpenBatch>(
      "SELECT id, batch_number, expected_unit_count FROM batches WHERE status IN ('open', 'receiving') ORDER BY batch_number DESC",
    ).then(setOpenBatches);
  }, []);

  useEffect(() => {
    if (!selectedBatchId) {
      setReceivedCount(0);
      return;
    }
    refreshReceivedCount(selectedBatchId);
  }, [selectedBatchId]);

  // Load the lot's uploaded supplier list so scans can be verified against it.
  // Fetched from the API (needs signal at lot-select); scanning afterwards runs
  // against the in-memory set. No list -> null -> scanning falls back to
  // adding new devices (blind receiving).
  useEffect(() => {
    if (!selectedBatchId) {
      setExpectedIndex(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { token } = await (await fetch('/api/powersync/token')).json();
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL}/batches/${selectedBatchId}/expected`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) throw new Error('failed to load expected list');
        const items: { serialNumber: string | null; assetTag: string | null }[] = await res.json();
        const idx = new Set<string>();
        for (const it of items) {
          if (it.serialNumber) idx.add(it.serialNumber.trim().toUpperCase());
          if (it.assetTag) idx.add(it.assetTag.trim().toUpperCase());
        }
        if (!cancelled) setExpectedIndex(idx.size > 0 ? idx : null);
      } catch {
        if (!cancelled) setExpectedIndex(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedBatchId]);

  async function refreshReceivedCount(batchId: string) {
    const db = getPowerSyncDb();
    const row = await db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM assets WHERE batch_id = ? AND stock_status != 'sold'",
      [batchId],
    );
    setReceivedCount(row?.count ?? 0);
  }

  // Shared by both scan sources: a USB/Bluetooth scanner emulating keyboard
  // input (or manual typing) submits through the form below; the phone
  // camera calls this directly from CameraScanner's onDecode. Either way it
  // resolves against local SQLite and writes the scan event the same way —
  // there is no "camera path" vs "keyboard path" beyond how the tag arrives.
  async function processScan(rawTag: string) {
    const db = getPowerSyncDb();
    // Normalise: trim + uppercase. Serials/tags are case-insensitive, so
    // without this "4tc81g2" and "4TC81G2" would become two separate assets.
    const scannedTag = rawTag.trim().toUpperCase();
    if (!scannedTag) return;
    setShowAudit(false);

    // The uploaded list is the source of truth: when receiving into a lot that
    // has one, only identifiers on the list are accepted. Anything else is
    // reported and ignored — never created, linked, or counted.
    if (selectedBatchId && expectedIndex && !expectedIndex.has(scannedTag)) {
      setResult({ status: 'not_on_list', tag: scannedTag });
      return;
    }

    // getOptional(), not get() — a tag that doesn't match any asset is a
    // real, expected outcome here (handled below via the 'not_found' status),
    // not an exceptional one. db.get() throws "Result set is empty" on zero
    // rows; getOptional() returns null instead. COLLATE NOCASE so a re-scan in
    // any case finds the existing asset instead of creating a duplicate.
    const asset = await db.getOptional<ScannedAsset>(
      'SELECT id, name, tag, stock_status, batch_id FROM assets WHERE tag = ? COLLATE NOCASE',
      [scannedTag],
    );

    if (!asset) {
      // Not in inventory. Outside receiving, that's just a failed lookup. But
      // when receiving into a lot, an unknown tag is a NEW device arriving —
      // create it into the lot right here. Offline-safe: it's a local insert
      // that syncs via the same assets upload path as everything else.
      // name/category are placeholders, refined later at audit/grading.
      if (!selectedBatchId) {
        setResult({ status: 'not_found', tag: scannedTag });
        return;
      }
      const id = crypto.randomUUID();
      await db.execute(
        `INSERT INTO assets (id, tag, name, category, stock_status, batch_id, updated_at)
         VALUES (?, ?, ?, 'Uncategorised', 'received', ?, datetime('now'))`,
        [id, scannedTag, scannedTag, selectedBatchId],
      );
      await db.execute(
        `INSERT INTO asset_history (id, asset_id, event_type, user_id, created_at)
         VALUES (uuid(), ?, 'created', NULL, datetime('now'))`,
        [id],
      );
      await refreshReceivedCount(selectedBatchId);
      const createdAsset: ScannedAsset = {
        id,
        name: scannedTag,
        tag: scannedTag,
        stock_status: 'received',
        batch_id: selectedBatchId,
      };
      setResult({ status: 'received_new', asset: createdAsset });
      setRecent((prev) => [
        { tag: scannedTag, name: scannedTag, when: new Date().toLocaleTimeString() },
        ...prev.slice(0, 9),
      ]);
      return;
    }

    if (selectedBatchId && asset.batch_id === selectedBatchId) {
      // Already received into this lot — report it, don't count it again.
      setResult({ status: 'already', asset });
      return;
    }

    await db.execute(
      `INSERT INTO asset_history (id, asset_id, event_type, user_id, created_at)
       VALUES (uuid(), ?, 'scanned', NULL, datetime('now'))`,
      [asset.id],
    );

    if (selectedBatchId) {
      await db.execute('UPDATE assets SET batch_id = ? WHERE id = ?', [selectedBatchId, asset.id]);
      await refreshReceivedCount(selectedBatchId);
    }

    setResult({ status: 'ok', asset });
    setRecent((prev) => [
      { tag: asset.tag, name: asset.name, when: new Date().toLocaleTimeString() },
      ...prev.slice(0, 9),
    ]);
  }

  async function handleFormScan(e: React.FormEvent) {
    e.preventDefault();
    const scannedTag = tag.trim();
    setTag('');
    inputRef.current?.focus();
    await processScan(scannedTag);
  }

  const selectedBatch = openBatches.find((b) => b.id === selectedBatchId);

  return (
    <>
      <Nav />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-screen bg-neutral-50 text-neutral-950 px-4 py-6 sm:px-8 sm:py-8"
      >
        <div className="mx-auto max-w-[90rem]">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Scan Asset</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-neutral-600">
            {mode === 'keyboard'
              ? 'Point a USB/Bluetooth scanner here, or type a tag and press Enter.'
              : "Point your phone's camera at a QR code or barcode."}{' '}
            Works offline.
          </p>
        </div>

        {/* Two columns on a desktop, one on a phone.
            Every element on this page used to be max-w-sm stacked down the
            left, which is right on the handset an operator actually scans with
            and wrong at a bench: the result of the scan — the thing you read
            while holding the device — sat under the controls instead of beside
            them, and on a wide screen the page was 95% empty.
            Controls left, feedback right; on a phone it stacks back exactly as
            it was. */}
        <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <div className="space-y-4">
        <div className="rounded-xl border border-neutral-200 bg-white p-4">
          <label
            htmlFor="scan-lot"
            className="block text-[11px] uppercase tracking-wide text-neutral-500"
          >
            Receiving into lot (optional)
          </label>
          <select
            id="scan-lot"
            value={selectedBatchId}
            onChange={(e) => setSelectedBatchId(e.target.value)}
            className="field-underline mt-1 w-full px-2 py-1.5 text-sm"
          >
            <option value="">Not receiving — scan only</option>
            {openBatches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.batch_number}
              </option>
            ))}
          </select>
          {selectedBatch && (
            <div className="mt-2 text-sm">
              <p className="text-neutral-700">
                {receivedCount} / {selectedBatch.expected_unit_count ?? '—'} units received.
              </p>
              <p className="mt-0.5 text-xs text-neutral-600">
                {expectedIndex
                  ? `Verifying against the uploaded list (${expectedIndex.size} items) — only listed items are accepted.`
                  : 'No uploaded list — anything scanned is added as a new device.'}
              </p>
            </div>
          )}
        </div>

        {/* The Keyboard/Camera toggle used to live in the page's top-right
            corner, over a thousand pixels from the field it switches. It now
            sits on the card it controls. */}
        <div className="rounded-xl border border-neutral-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] uppercase tracking-wide text-neutral-500">
              Scan input
            </span>
            <div className="flex overflow-hidden rounded-md border border-neutral-300 text-xs font-semibold uppercase tracking-wide">
              <button
                onClick={() => setMode('keyboard')}
                aria-pressed={mode === 'keyboard'}
                className={
                  'px-3 py-1.5 ' +
                  (mode === 'keyboard'
                    ? 'bg-[#1a6ef5] text-white'
                    : 'bg-white text-neutral-700 hover:bg-neutral-50')
                }
              >
                Keyboard
              </button>
              <button
                onClick={() => setMode('camera')}
                aria-pressed={mode === 'camera'}
                className={
                  'border-l border-neutral-300 px-3 py-1.5 ' +
                  (mode === 'camera'
                    ? 'bg-[#1a6ef5] text-white'
                    : 'bg-white text-neutral-700 hover:bg-neutral-50')
                }
              >
                Camera
              </button>
            </div>
          </div>

        {mode === 'keyboard' ? (
          <form onSubmit={handleFormScan} className="mt-3">
            <label htmlFor="scan-tag" className="sr-only">
              Asset tag — scan or type
            </label>
            <input
              id="scan-tag"
              ref={inputRef}
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="Scan or type asset tag…"
              autoComplete="off"
              className="field-underline w-full px-3 py-2 text-neutral-950"
            />
          </form>
        ) : (
          <div className="mt-3">
            <CameraScanner
              onDecode={processScan}
              onReadText={(t) => {
                // OCR is fallible — drop the text into the field in keyboard
                // mode so it can be checked/corrected before it's submitted.
                setTag(t);
                setMode('keyboard');
              }}
            />
          </div>
        )}
        </div>
          </div>

          {/* Feedback column: what just happened, and what happened before it. */}
          <div className="space-y-4">
        <div aria-live="polite" aria-atomic="true">
        {result?.status === 'ok' && (
          <div className="space-y-3">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm">
              <div>
                Scanned <strong>{result.asset.name}</strong> ({result.asset.tag}) — status:{' '}
                {formatLabel(result.asset.stock_status)}
                {selectedBatch && ' — added to ' + selectedBatch.batch_number}
              </div>
              {!showAudit && (
                <button
                  onClick={() => setShowAudit(true)}
                  className="mt-2 text-xs text-emerald-700 underline"
                >
                  Record ITAD audit for this asset
                </button>
              )}
            </div>
            {showAudit && (
              <AuditForm assetId={result.asset.id} onSaved={() => setShowAudit(false)} />
            )}
          </div>
        )}
        {result?.status === 'received_new' && (
          <div className="space-y-3">
            <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm">
              <div>
                Received new device <strong>{result.asset.tag}</strong>
                {selectedBatch ? ' into ' + selectedBatch.batch_number : ''}.{' '}
                <span className="text-sky-700">Created in inventory.</span>
              </div>
              {!showAudit && (
                <button
                  onClick={() => setShowAudit(true)}
                  className="mt-2 text-xs text-sky-700 underline"
                >
                  Record ITAD audit for this asset
                </button>
              )}
            </div>
            {showAudit && (
              <AuditForm assetId={result.asset.id} onSaved={() => setShowAudit(false)} />
            )}
          </div>
        )}
        {result?.status === 'not_found' && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
            No asset found for tag &quot;{result.tag}&quot;.{' '}
            <span className="text-amber-700">
              Select a lot above to receive it as a new device.
            </span>
          </div>
        )}
        {result?.status === 'not_on_list' && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            &quot;{result.tag}&quot; is not on the uploaded inventory list for this lot — ignored.
          </div>
        )}
        {result?.status === 'already' && (
          <div className="rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-700">
            <strong>{result.asset.tag}</strong> is already received in this lot — not counted again.
          </div>
        )}
        </div>

        {!result && recent.length === 0 && (
          <p className="rounded-xl border border-dashed border-neutral-300 bg-white p-6 text-sm text-neutral-600">
            Nothing scanned yet. Results appear here as you scan.
          </p>
        )}

        {recent.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
            <div className="flex items-baseline justify-between gap-2 border-b border-neutral-200 px-4 py-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-900">
                Recent scans this session
              </h2>
              <span className="text-xs text-neutral-600 tabular-nums">
                {recent.length} scanned
              </span>
            </div>
            <ul className="divide-y divide-neutral-200 text-sm">
              {recent.map((r, i) => (
                <li key={i} className="flex justify-between gap-3 px-4 py-2.5 text-neutral-800">
                  <span className="min-w-0 truncate">{r.name}</span>
                  <span className="shrink-0 text-neutral-600 tabular-nums">{r.when}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
          </div>
        </div>
        </div>
      </main>
  </>
  );
}
